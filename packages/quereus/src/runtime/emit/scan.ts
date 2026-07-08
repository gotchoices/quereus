import { StatusCode, type Row, type SqlValue } from "../../common/types.js";
import { SeqScanNode, IndexScanNode, IndexSeekNode } from "../../planner/nodes/table-access-nodes.js";
import { AbortError, QuereusError, throwIfAborted } from "../../common/errors.js";
import type { VirtualTable } from "../../vtab/table.js";
import type { BaseModuleConfig, AnyVirtualTableModule } from "../../vtab/module.js";
import type { FilterInfo } from "../../vtab/filter-info.js";
import type { Instruction, RuntimeContext } from "../types.js";
import { asRun } from "../types.js";
import type { EmissionContext } from "../emission-context.js";
import { createValidatedInstruction, emitPlanNode } from "../emitters.js";
import { disconnectVTable } from "../utils.js";
import { buildRowDescriptor } from "../../util/row-descriptor.js";
import { createRowSlot } from "../context-helpers.js";

/**
 * Optional override hook supplied by callers that need to mutate the
 * `FilterInfo` handed to the vtab at runtime — e.g., `OrdinalSlice`
 * stamping `limit` / `offset` after resolving its scalar expressions.
 *
 * The override receives the plan's `FilterInfo` (already augmented with
 * any IndexSeek dynamic args) and returns a possibly-cloned, possibly-
 * augmented copy. Returning the input unchanged is legal.
 */
export type FilterInfoOverride = (
	baseFilterInfo: FilterInfo,
	runtimeCtx: RuntimeContext,
	dynamicArgs: SqlValue[],
) => FilterInfo | Promise<FilterInfo>;

/**
 * Emits instructions for physical table access nodes (SeqScan, IndexScan, IndexSeek).
 *
 * Optionally accepts a `filterInfoOverride` so wrapping operators (e.g.,
 * `OrdinalSlice`) can push `limit`/`offset` directives into the vtab call
 * without re-emitting the leaf or duplicating connect/disconnect lifecycle.
 */
export function emitSeqScan(
	plan: SeqScanNode | IndexScanNode | IndexSeekNode,
	ctx: EmissionContext,
	filterInfoOverride?: FilterInfoOverride,
): Instruction {
	// Handle physical access nodes
	const source = plan.source;
	const schema = source.tableSchema;

	// Create row descriptor mapping attribute IDs to column indices
	const rowDescriptor = buildRowDescriptor(plan.getAttributes());

	// Look up the virtual table module during emission and record the dependency
	const moduleInfo = ctx.getVtabModule(schema.vtabModuleName);
	if (!moduleInfo) {
		throw new QuereusError(`Virtual table module '${schema.vtabModuleName}' not found`, StatusCode.ERROR);
	}

	// Capture the module info key for runtime retrieval
	const moduleKey = `vtab_module:${schema.vtabModuleName}`;

	async function* run(runtimeCtx: RuntimeContext, ...dynamicArgs: SqlValue[]): AsyncIterable<Row> {
		// Use the captured module info instead of doing a fresh lookup
		const capturedModuleInfo = ctx.getCapturedSchemaObject<{ module: AnyVirtualTableModule, auxData?: unknown }>(moduleKey);
		if (!capturedModuleInfo) {
			throw new QuereusError(`Virtual table module '${schema.vtabModuleName}' was not captured during emission`, StatusCode.INTERNAL);
		}

		const module = capturedModuleInfo.module;
		if (typeof module.connect !== 'function') {
			throw new QuereusError(`Virtual table module '${schema.vtabModuleName}' does not implement connect`, StatusCode.MISUSE);
		}

		let vtabInstance: VirtualTable;
		try {
			const options: BaseModuleConfig = {
				...(schema.vtabArgs ?? {}),
				...(source.readCommitted ? { _readCommitted: true } : {})
			};
			vtabInstance = await module.connect(
				runtimeCtx.db,
				capturedModuleInfo.auxData,
				schema.vtabModuleName,
				schema.schemaName,
				schema.name,
				options
			);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Module '${schema.vtabModuleName}' connect failed for table '${schema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		}

		if (typeof vtabInstance.query !== 'function') {
			// Fallback or error if query is not available. For now, throwing an error.
			// Later, we could implement the open/filter/next loop here as a fallback.
			throw new QuereusError(`Virtual table '${schema.name}' does not support query.`, StatusCode.UNSUPPORTED);
		}

		const rowSlot = createRowSlot(runtimeCtx, rowDescriptor);
		try {
			// If this is an IndexSeek with dynamic seek keys, populate args from params
			let effectiveFilterInfo: FilterInfo = (plan instanceof IndexSeekNode && dynamicArgs && dynamicArgs.length > 0)
				? { ...plan.filterInfo, args: dynamicArgs }
				: plan.filterInfo;

			if (filterInfoOverride) {
				effectiveFilterInfo = await filterInfoOverride(effectiveFilterInfo, runtimeCtx, dynamicArgs);
			}

			const asyncRowIterable = vtabInstance.query(effectiveFilterInfo);
			throwIfAborted(runtimeCtx.signal);
			for await (const row of asyncRowIterable) {
				// Cooperative cancellation checkpoint: a request-timeout (or any
				// caller abort) interrupts the scan between rows so the whole query
				// pipeline unwinds promptly instead of draining the table.
				// NOTE: for the memory vtab this is now the ONLY per-row cancellation
				// checkpoint — the inner scan layers (safeIterate/scanLayer) went sync,
				// so do not remove it expecting an inner checkpoint to cover the scan.
				throwIfAborted(runtimeCtx.signal);
				rowSlot.set(row);
				yield row;
			}
		} catch (e: unknown) {
			// Preserve cancellation identity — don't re-wrap it as a generic query error.
			if (e instanceof AbortError) throw e;
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Error during query on table '${schema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		} finally {
			rowSlot.close();
			// Properly disconnect the VirtualTable instance
			await disconnectVTable(runtimeCtx, vtabInstance);
		}
	}

	// Emit parameter instructions for dynamic seek keys (IndexSeek only)
	const params: Instruction[] = [];
	if (plan instanceof IndexSeekNode) {
		for (const key of plan.getSeekKeys()) {
			params.push(emitPlanNode(key, ctx));
		}
	}

	return createValidatedInstruction(
		params,
		asRun(run),
		ctx,
		`${plan.nodeType}(${schema.name})`
	);
}
