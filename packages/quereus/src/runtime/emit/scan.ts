import { StatusCode, type Row, type SqlValue } from "../../common/types.js";
import { SeqScanNode, IndexScanNode, IndexSeekNode } from "../../planner/nodes/table-access-nodes.js";
import { QuereusError } from "../../common/errors.js";
import type { VirtualTable } from "../../vtab/table.js";
import type { BaseModuleConfig, AnyVirtualTableModule } from "../../vtab/module.js";
import type { Instruction, InstructionRun, RuntimeContext } from "../types.js";
import type { EmissionContext } from "../emission-context.js";
import { createValidatedInstruction, emitPlanNode } from "../emitters.js";
import { disconnectVTable } from "../utils.js";
import { buildRowDescriptor } from "../../util/row-descriptor.js";
import { createRowSlot } from "../context-helpers.js";

/**
 * Emits instructions for physical table access nodes (SeqScan, IndexScan, IndexSeek)
 */
export function emitSeqScan(plan: SeqScanNode | IndexScanNode | IndexSeekNode, ctx: EmissionContext): Instruction {
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
      const effectiveFilterInfo = (() => {
        if (plan instanceof IndexSeekNode && dynamicArgs && dynamicArgs.length > 0) {
          return { ...plan.filterInfo, args: dynamicArgs };
        }
        return plan.filterInfo;
      })();

      const asyncRowIterable = vtabInstance.query(effectiveFilterInfo);
			for await (const row of asyncRowIterable) {
				rowSlot.set(row);
				yield row;
			}
		} catch (e: unknown) {
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
    run as InstructionRun,
    ctx,
    `${plan.nodeType}(${schema.name})`
  );
}
