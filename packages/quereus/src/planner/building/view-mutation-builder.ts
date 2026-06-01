import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type TableDescriptor } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { RowOpFlag, type RowConstraintSchema } from '../../schema/table.js';
import { ViewMutationNode, type MutationEnvelope, type ReturningCapture } from '../nodes/view-mutation-node.js';
import { propagate, decompositionStorage, type BaseOp, type MutableViewLike, type MutationRequest } from '../mutation/propagate.js';
import { analyzeMultiSourceInsert, buildMultiSourceUpdateReturning, isJoinBody } from '../mutation/multi-source.js';
import { analyzeDecompositionInsert, type DecompInsertOp } from '../mutation/decomposition.js';
import { FilterNode } from '../nodes/filter.js';
import { RegisteredScope } from '../scopes/registered.js';
import { collectMutationTags } from '../mutation/mutation-tags.js';
import { collectLensRowLocalConstraints, collectLensForeignKeyConstraints, collectLensParentSideForeignKeyConstraints, collectLensSetLevelConstraints, hasCommitTimeSetLevelObligation } from '../mutation/lens-enforcement.js';
import { ConflictResolution } from '../../common/constants.js';
import { buildInsertStmt } from './insert.js';
import { buildUpdateStmt } from './update.js';
import { buildDeleteStmt } from './delete.js';
import { buildSelectStmt, buildValuesStmt } from './select.js';
import { buildExpression } from './expression.js';
import { EnvelopeScanNode } from '../nodes/envelope-scan-node.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { parseExpressionString } from '../../parser/index.js';
import { INTEGER_TYPE } from '../../types/builtin-types.js';
import { raiseMutationDiagnostic } from '../mutation/mutation-diagnostic.js';

/**
 * Build the view-mutation substrate for a view-/materialized-view-mediated DML.
 *
 * `propagate` decomposes the view mutation into an ordered list of base-table
 * operations (one for the single-source spine); each is re-planned through the
 * ordinary base-table builder — so every constraint / conflict / FK /
 * mutation-context / RETURNING-rejection rule is reused verbatim — and the
 * results are sequenced in a `ViewMutationNode`. For the single-source case the
 * wrapped subtree is byte-identical to what the retired AST rewrite re-planned.
 */
export function buildViewMutation(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): PlanNode {
	// Collect, site-validate, and merge the view-level + statement-level reserved
	// `quereus.update.*` override tags (a sited error is raised here, before any
	// base op is built — atomic). The decomposers read the merged map off the req.
	const tags = collectMutationTags(view, req.stmt);

	// A decomposition INSERT fans out one insert per member off the same shared-
	// surrogate envelope, materialized once and read back per member through an
	// `EnvelopeScanNode` — the plan-level form the AST `BaseOp[]` model cannot
	// express. Build it directly (the dual of the multi-source insert below).
	if (req.op === 'insert' && decompositionStorage(ctx, view)) {
		return buildDecompositionInsert(ctx, view, req.stmt);
	}

	// Multi-source inner-join INSERT needs the plan-level shared-surrogate envelope
	// (a materialized augmented source the sibling base inserts fan out from), which
	// the AST-level `BaseOp[]` model cannot express — build it directly.
	if (req.op === 'insert' && isJoinBody(view.selectAst)) {
		return buildMultiSourceInsert(ctx, view, req.stmt);
	}

	// Lens set-level conflict-resolution gate: a commit-time set-level key (no basis
	// covering structure) enforces via an O(n) deferred count scan, which cannot
	// perform `or replace` / `or ignore`. Reject those up front so a write that would
	// silently ABORT-at-commit instead of skipping/replacing is caught with a clear
	// diagnostic. A row-time key (backed by a basis UNIQUE + covering MV) is NOT
	// gated — its basis UC's covering-MV enforcement resolves the conflict action for
	// free (`lens-set-level-rowtime-enforcement`, delivered).
	rejectLensSetLevelConflictResolution(ctx, view, req);

	const baseOps = propagate(ctx, view, withTags(req, tags));
	// Lens row-local enforcement: when the target is a lens-backed logical table,
	// its prover-classified `enforced-row-local` CHECK obligations (rewritten to
	// basis terms) ride the basis write's per-row check pipeline, so they fire on
	// the write through the lens even when the basis carries no such check. A
	// plain view / MV has no lens slot ⇒ no extras (unchanged behavior). DELETE
	// writes no NEW row, so a CHECK is moot there.
	// Lens FK enforcement (the `enforced-fk` obligation): each logical FK rides the
	// same `extraConstraints` seam as a deferred basis-term `EXISTS` existence check
	// against the schema-qualified logical parent — gated by the `foreign_keys`
	// pragma exactly like the physical child-side FK, so a lens write enforces the
	// logical FK with matching gating + commit-time timing even when the basis
	// carries no such FK.
	// Lens set-level enforcement (the `enforced-set-level` `commit-time` obligation):
	// each logical unique / primary key with no basis covering structure rides the
	// same seam as a deferred `(select count(*) … ) <= 1` count-subquery CHECK over
	// the logical key columns — auto-deferred to commit, where a duplicate logical
	// key sees count ≥ 2 ⇒ ABORT. DELETE writes no NEW row and can introduce no
	// duplicate, so the three child/write classes do not apply there.
	// Lens parent-side FK enforcement (the cross-slot dual of the child-side FK): a
	// delete/update of a logical *parent* through the lens runs the RESTRICT existence
	// check against the logical *child*, synthesized as a deferred `NOT EXISTS` and
	// routed through the same seam — gated on `foreign_keys`. It fires on DELETE and
	// UPDATE (the only ops that can orphan a child), so it is the *sole* extra for a
	// delete and joins the row-local/child-FK/set-level list (UPDATE-masked) otherwise.
	const extraConstraints = req.op === 'delete'
		? lensParentSideForeignKeyConstraints(ctx, view, RowOpFlag.DELETE)
		: [
			...lensRowLocalConstraints(ctx, view),
			...lensForeignKeyConstraints(ctx, view),
			...lensSetLevelConstraints(ctx, view),
			...lensParentSideForeignKeyConstraints(ctx, view, RowOpFlag.UPDATE),
		];
	const children = baseOps.map(op => buildBaseOp(ctx, op, extraConstraints));

	// RETURNING-through-view. Single-source already embedded the (rewritten)
	// RETURNING onto its base op (it now plans to a relational ReturningNode the
	// substrate surfaces), so nothing more is needed there. A **multi-source**
	// update/delete cannot recover the view row from its per-side base ops: a delete
	// re-queries the view *before* the base ops fire (its rows are about to vanish);
	// an update captures each affected row's base-PK identity *before* the base ops,
	// then re-queries the join body *after* restricted to those identities (robust
	// against an update that rewrites its own predicate column).
	const { returning, returningTiming, returningCapture } = buildMultiSourceReturning(ctx, view, req);
	return new ViewMutationNode(ctx.scope, children, returning, undefined, returningTiming, returningCapture);
}

/**
 * Build the separate RETURNING substrate for a **multi-source** update/delete (the
 * only path where the view row is not recoverable from the base ops). Returns `{}`
 * (no returning) for the absent-clause case, for single-source (handled by the
 * embedded base-op RETURNING), for insert (single-source embeds; multi-source insert
 * is rejected upstream), and for decomposition-backed logical tables (whose
 * RETURNING stays rejected by `propagate`).
 *
 * Two shapes, by op:
 *  - **UPDATE** uses per-row identity capture (`buildMultiSourceUpdateReturning`):
 *    capture each affected row's base-PK identity *before* the base ops, re-query
 *    the join body *after* restricted to those identities (`returningTiming: 'post'`,
 *    plus a {@link ReturningCapture}). This is robust against an update that rewrites
 *    a column its own WHERE filters on — the captured identity still matches even
 *    though the changed row no longer satisfies the predicate.
 *  - **DELETE** re-queries the view restricted to the user predicate, captured `pre`
 *    (before the base op fires — the rows still match the predicate and are about to
 *    vanish), so the projected columns resolve naturally against the view.
 */
function buildMultiSourceReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	req: MutationRequest,
): { returning?: RelationalPlanNode; returningTiming?: 'pre' | 'post'; returningCapture?: ReturningCapture } {
	const returningCols = req.stmt.returning;
	if (!returningCols || returningCols.length === 0) return {};
	if (req.op === 'insert') return {}; // single-source insert embeds; multi-source insert is rejected upstream
	if (!isJoinBody(view.selectAst) || decompositionStorage(ctx, view)) return {};

	if (req.op === 'update') {
		const { source, descriptor, returning } = buildMultiSourceUpdateReturning(ctx, view, req.stmt);
		return { returning, returningTiming: 'post', returningCapture: { source, descriptor } };
	}

	// DELETE: re-query the view (predicate-restricted) captured `pre`.
	const selectAst: AST.SelectStmt = {
		type: 'select',
		columns: [...returningCols],
		from: [{ type: 'table', table: { type: 'identifier', name: view.name, schema: view.schemaName } }],
		where: req.stmt.where,
		loc: req.stmt.loc,
	};
	const node = buildSelectStmt(ctx, selectAst);
	if (!isRelationalNode(node)) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `cannot project RETURNING through view '${view.name}': the re-query did not produce a relation`,
		});
	}
	return { returning: node, returningTiming: 'pre' };
}

/**
 * The lens row-local CHECK constraints for a view-mediated write, or `[]` when the
 * target is not a lens-backed logical table (a plain view / MV) or the lens has no
 * row-local obligations. The lens slot is resolved the same way the single-source
 * rewrite resolves the read-only gate — only a logical schema carries one.
 */
function lensRowLocalConstraints(ctx: PlanningContext, view: MutableViewLike): RowConstraintSchema[] {
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	return slot ? collectLensRowLocalConstraints(slot) : [];
}

/**
 * The lens child-side FK existence constraints for a view-mediated write, or `[]`
 * when the target is not a lens-backed logical table or the `foreign_keys` pragma
 * is off. Gating on the pragma mirrors the physical child-side FK builder
 * (`buildChildSideFKChecks` is only called when `foreign_keys` is true), so the
 * lens enforces FKs under exactly the same switch — never adding enforcement the
 * physical path would not.
 */
function lensForeignKeyConstraints(ctx: PlanningContext, view: MutableViewLike): RowConstraintSchema[] {
	if (!ctx.db.options.getBooleanOption('foreign_keys')) return [];
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	return slot ? collectLensForeignKeyConstraints(slot, ctx.schemaManager) : [];
}

/**
 * The lens **parent-side** FK non-existence constraints for a view-mediated
 * delete/update, or `[]` when the target is not a lens-backed logical table or the
 * `foreign_keys` pragma is off. The target view's slot is the FK *parent*; the
 * collector discovers logical FKs on *other* slots that reference it and synthesizes
 * a deferred `NOT EXISTS` over the logical child per RESTRICT (`operation` selects the
 * DELETE vs UPDATE form). Pragma-gated symmetrically with {@link lensForeignKeyConstraints}
 * — the lens enforces parent-side FKs under the same switch as the physical
 * `buildParentSideFKChecks`.
 */
function lensParentSideForeignKeyConstraints(
	ctx: PlanningContext,
	view: MutableViewLike,
	operation: RowOpFlag.DELETE | RowOpFlag.UPDATE,
): RowConstraintSchema[] {
	if (!ctx.db.options.getBooleanOption('foreign_keys')) return [];
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	return slot ? collectLensParentSideForeignKeyConstraints(slot, ctx.schemaManager, operation) : [];
}

/**
 * The lens set-level (`unique` / primary key) count-subquery constraints for a
 * view-mediated write, or `[]` when the target is not a lens-backed logical table
 * or the lens has no commit-time set-level obligation (a proved / row-time key, a
 * plain view / MV). No pragma gate — set-level uniqueness is not a `foreign_keys`
 * concern.
 */
function lensSetLevelConstraints(ctx: PlanningContext, view: MutableViewLike): RowConstraintSchema[] {
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	return slot ? collectLensSetLevelConstraints(slot) : [];
}

/**
 * Reject a conflict-resolution write the commit-time set-level scan cannot honor.
 * The detection-only count scan (no basis covering structure) can only ABORT on a
 * duplicate; it cannot replace or skip the offending row — that requires a row-time
 * covering structure. A **row-time** key (backed by a basis `UNIQUE` + covering MV)
 * is *not* gated here: it carries no commit-time obligation, so the basis UC's
 * covering-MV enforcement resolves `or replace` / `or ignore` for free
 * (`lens-set-level-rowtime-enforcement`, delivered). Only the commit-time class is
 * rejected. So an `insert or replace` / `or ignore` (or any upsert) against a logical table
 * with a commit-time set-level key is rejected up front rather than silently
 * ABORTing at commit instead of replacing/skipping. `or abort` / `or fail` /
 * `or rollback` (and a plain insert) are fine — they ABORT, consistent with
 * detection-only. UPDATE carries no statement-level OR clause, so only INSERT is
 * gated. Upsert matching the key is awkward to disambiguate, so v1 conservatively
 * rejects **any** upsert when a commit-time set-level obligation is present.
 */
function rejectLensSetLevelConflictResolution(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): void {
	if (req.op !== 'insert') return;
	const slot = ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	if (!slot || !hasCommitTimeSetLevelObligation(slot)) return;

	const reject = (clause: string): never => raiseMutationDiagnostic({
		reason: 'lens-set-level-conflict-resolution',
		table: view.name,
		message: `cannot ${clause} through lens-backed table '${view.name}': its logical unique/primary key has no basis covering structure, so it enforces via an O(n) commit-time scan that cannot perform row-time conflict resolution`,
		suggestion: 'Add a basis covering materialized view (order by the key columns) to upgrade the key to row-time enforcement, or use a plain insert (which ABORTs on a duplicate).',
	});

	if (req.stmt.onConflict === ConflictResolution.REPLACE) reject('insert or replace');
	if (req.stmt.onConflict === ConflictResolution.IGNORE) reject('insert or ignore');
	if (req.stmt.upsertClauses && req.stmt.upsertClauses.length > 0) reject('upsert (on conflict do …)');
}

/** Attach the merged override tags to the request (discriminant preserved). */
function withTags(req: MutationRequest, tags: MutationRequest['tags']): MutationRequest {
	if (tags === undefined) return req;
	switch (req.op) {
		case 'insert': return { op: 'insert', stmt: req.stmt, tags };
		case 'update': return { op: 'update', stmt: req.stmt, tags };
		case 'delete': return { op: 'delete', stmt: req.stmt, tags };
	}
}

/**
 * Build the shared-surrogate envelope substrate for a multi-source inner-join
 * INSERT (docs/view-updateability.md § Inner Join — Inserts, § Mutation Context).
 *
 * The decomposition (`analyzeMultiSourceInsert`) yields the per-side base inserts
 * plus the envelope shape. We build:
 *   - the **envelope source** — the user's VALUES/SELECT, whose columns are the
 *     supplied view columns. The `ViewMutation` emitter materializes it once,
 *     appends the minted shared key (if any) per row, and stashes the rows in
 *     context;
 *   - one **base insert per side**, each sourcing from a projection over an
 *     `EnvelopeScanNode` that reads those shared rows back (key first, then the
 *     view columns that side owns). Re-planned through the ordinary base-table
 *     builder, so every constraint / conflict / FK / default rule is reused; and
 *   - the **surrogate seed** (`max(anchor.key)`), evaluated once before fan-out.
 *
 * The sides are already FK-parent-before-FK-child ordered; the emitter drives them
 * in that order. Every side reads the same materialized envelope, so a generated
 * shared key is minted exactly once per produced row and threaded identically.
 */
function buildMultiSourceInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): PlanNode {
	const plan = analyzeMultiSourceInsert(ctx, view, stmt);

	const { envelopeAttrs, envelopeType, descriptor } = buildEnvelopeShape(plan.suppliedColumns, !!plan.mint);

	const baseOps = plan.orderedSides.map(side => {
		const scan = new EnvelopeScanNode(ctx.scope, descriptor, envelopeAttrs, envelopeType);
		const projections: Projection[] = side.targetColumns.map((baseColumn, k) => {
			const envIdx = side.envelopeIndices[k];
			const attr = envelopeAttrs[envIdx];
			const ref = new ColumnReferenceNode(
				ctx.scope,
				{ type: 'column', name: attr.name },
				attr.type,
				attr.id,
				envIdx,
			);
			return { node: ref, alias: baseColumn };
		});
		// preserveInputColumns=false → output is exactly the picked columns, fresh
		// attribute ids, positionally aligned to the base op's target columns.
		const source = new ProjectNode(ctx.scope, scan, projections, undefined, undefined, false);

		const sideInsert: AST.InsertStmt = {
			type: 'insert',
			table: { type: 'identifier', name: side.schema.name, schema: side.schema.schemaName },
			columns: [...side.targetColumns],
			source: { type: 'values', values: [] }, // placeholder — ignored when preBuiltSource is set
			onConflict: stmt.onConflict,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		return buildInsertStmt(ctx, sideInsert, [], source);
	});

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);
	const mint = buildSeedMint(ctx, plan.mint);

	return new ViewMutationNode(ctx.scope, baseOps, undefined, { source: envelopeSource, descriptor, mint });
}

/**
 * Build the shared-surrogate envelope substrate for an INSERT through a
 * decomposition-backed logical table (docs/lens.md § The Default Mapper,
 * docs/view-updateability.md § Mutation Context). The dual of
 * `buildMultiSourceInsert`, generalized from two FK-ordered sides to an n-way,
 * anchor-first member fan-out with optional / EAV members.
 *
 * `analyzeDecompositionInsert` yields the per-member base inserts plus the envelope
 * shape. We build the **envelope source** (the user's VALUES/SELECT, columns = the
 * supplied logical columns), one **base insert per op** (each sourcing from a
 * projection — over a presence `FilterNode` for an optional/EAV op — of the shared
 * `EnvelopeScanNode`), and the **surrogate seed** when the shared key is minted.
 * Every member reads the same materialized envelope, so a generated key is minted
 * once per produced row and threaded identically across the fan-out.
 */
function buildDecompositionInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): PlanNode {
	const storage = decompositionStorage(ctx, view)!; // guaranteed by the caller's gate
	const plan = analyzeDecompositionInsert(ctx, view, storage, stmt);

	const { envelopeAttrs, envelopeType, descriptor } = buildEnvelopeShape(plan.suppliedColumns, !!plan.mint);

	const baseOps = plan.ops.map(op =>
		buildDecompositionMemberInsert(ctx, stmt, descriptor, envelopeAttrs, envelopeType, op));

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);
	const mint = buildSeedMint(ctx, plan.mint);

	return new ViewMutationNode(ctx.scope, baseOps, undefined, { source: envelopeSource, descriptor, mint });
}

/**
 * Build the shared envelope shape both insert fan-outs ride: the leading columns
 * are the supplied logical/view columns (positional with the user source), plus a
 * trailing `__shared_key` column when a surrogate is minted. The descriptor is the
 * stitch every base op's `EnvelopeScanNode` shares with the rows the `ViewMutation`
 * emitter materializes once.
 */
function buildEnvelopeShape(
	suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[],
	hasMint: boolean,
): { envelopeAttrs: Attribute[]; envelopeType: RelationType; descriptor: TableDescriptor } {
	const envelopeAttrs: Attribute[] = suppliedColumns.map(col => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: col.type,
		sourceRelation: 'envelope',
	}));
	if (hasMint) {
		envelopeAttrs.push({
			id: PlanNode.nextAttrId(),
			name: '__shared_key',
			type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false },
			sourceRelation: 'envelope',
		});
	}
	const envelopeType: RelationType = {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false,
		columns: envelopeAttrs.map(a => ({ name: a.name, type: a.type })),
		keys: [],
		rowConstraints: [],
	};
	return { envelopeAttrs, envelopeType, descriptor: {} };
}

/**
 * Build the `MutationEnvelope.mint` from an analysis' surrogate descriptor (or
 * `undefined` when the shared key is supplied, not minted). The seed is
 * `coalesce(max(<anchor.key>), 0)` evaluated once before fan-out — it observes the
 * pre-mutation state. The optional cadence (`per-row` / `per-statement`) is
 * threaded through; the multi-source insert leaves it absent (⇒ `per-row`).
 */
function buildSeedMint(
	ctx: PlanningContext,
	mintSpec: { readonly seedTable: { tableSchema: { schemaName: string; name: string } }; readonly seedColumn: string; readonly cadence?: 'per-row' | 'per-statement' } | undefined,
): MutationEnvelope['mint'] | undefined {
	if (!mintSpec) return undefined;
	const seedExpr = parseExpressionString(
		`coalesce((select max(${quoteIdent(mintSpec.seedColumn)}) from ${qualifiedTable(mintSpec.seedTable.tableSchema.schemaName, mintSpec.seedTable.tableSchema.name)}), 0)`,
	);
	return { seed: buildExpression(ctx, seedExpr) as ScalarPlanNode, cadence: mintSpec.cadence };
}

/**
 * Build one member base insert of a decomposition fan-out: a projection over the
 * shared `EnvelopeScanNode` (key + supplied values, or an EAV triple), re-planned
 * through the ordinary base-table builder so every constraint / conflict / FK /
 * default rule is reused. An optional / EAV op first passes the envelope through a
 * presence `FilterNode` so only rows that supply the component materialize a row.
 */
function buildDecompositionMemberInsert(
	ctx: PlanningContext,
	stmt: AST.InsertStmt,
	descriptor: TableDescriptor,
	envelopeAttrs: Attribute[],
	envelopeType: RelationType,
	op: DecompInsertOp,
): PlanNode {
	let source: RelationalPlanNode = new EnvelopeScanNode(ctx.scope, descriptor, envelopeAttrs, envelopeType);

	if (op.presenceGateIndices.length > 0) {
		source = new FilterNode(ctx.scope, source, buildPresenceGate(ctx, envelopeAttrs, op.presenceGateIndices));
	}

	const projections: Projection[] = op.columns.map((col): Projection => {
		if (col.literal !== undefined) {
			// EAV attribute literal — a constant per row, no envelope column.
			const node = buildExpression(ctx, { type: 'literal', value: col.literal } as AST.LiteralExpr) as ScalarPlanNode;
			return { node, alias: col.baseColumn };
		}
		const envIdx = col.envelopeIndex!;
		const attr = envelopeAttrs[envIdx];
		const ref = new ColumnReferenceNode(ctx.scope, { type: 'column', name: attr.name }, attr.type, attr.id, envIdx);
		return { node: ref, alias: col.baseColumn };
	});
	// preserveInputColumns=false → output is exactly the picked columns, positionally
	// aligned to the member insert's target columns.
	const projectedSource = new ProjectNode(ctx.scope, source, projections, undefined, undefined, false);

	const memberInsert: AST.InsertStmt = {
		type: 'insert',
		table: { type: 'identifier', name: op.schema.name, schema: op.schema.schemaName },
		columns: op.columns.map(c => c.baseColumn),
		source: { type: 'values', values: [] }, // placeholder — ignored when preBuiltSource is set
		onConflict: stmt.onConflict,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	// Lens row-local CHECK enforcement on a decomposition insert is deferred (the
	// logical check cannot be unambiguously routed to a single member's basis terms);
	// matches the multi-source insert path, which also passes no extra constraints.
	return buildInsertStmt(ctx, memberInsert, [], projectedSource);
}

/**
 * Build the per-row presence predicate gating an optional / EAV member insert:
 * `<col> is not null [or <col> is not null …]` over the envelope columns named by
 * `gateIndices`. Resolved against a scope registering the envelope attributes (by
 * their stable ids), so the predicate reads the materialized envelope rows.
 */
function buildPresenceGate(ctx: PlanningContext, envelopeAttrs: Attribute[], gateIndices: readonly number[]): ScalarPlanNode {
	const gateScope = new RegisteredScope(ctx.scope);
	envelopeAttrs.forEach((attr, i) => {
		gateScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
	});
	const predicateSql = gateIndices.map(i => `${quoteIdent(envelopeAttrs[i].name)} is not null`).join(' or ');
	const ast = parseExpressionString(predicateSql);
	return buildExpression({ ...ctx, scope: gateScope }, ast) as ScalarPlanNode;
}

/**
 * Build the envelope source — the user's INSERT source (VALUES / SELECT), whose
 * output columns are the supplied view columns in order. The emitter materializes
 * it once; downstream the `EnvelopeScanNode` reads those rows back (plus the
 * appended minted key) for every base side.
 */
function buildEnvelopeSource(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.InsertStmt,
	suppliedCount: number,
): RelationalPlanNode {
	switch (stmt.source.type) {
		case 'values': {
			const node = buildValuesStmt(ctx, stmt.source);
			assertSourceArity(view, node.getType().columns.length, suppliedCount);
			return node;
		}
		case 'select': {
			const node = buildSelectStmt(ctx, stmt.source);
			if (!isRelationalNode(node)) {
				raiseMutationDiagnostic({ reason: 'no-base-lineage', table: view.name, message: `cannot insert through view '${view.name}': the SELECT source did not produce a relation` });
			}
			assertSourceArity(view, node.getType().columns.length, suppliedCount);
			return node;
		}
		default:
			raiseMutationDiagnostic({
				reason: 'unsupported-source',
				table: view.name,
				message: `cannot insert through view '${view.name}': a multi-source (join) insert supports a VALUES or SELECT source (DML-as-source is a later phase)`,
			});
	}
}

function assertSourceArity(view: MutableViewLike, got: number, expected: number): void {
	if (got !== expected) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot insert through view '${view.name}': the source supplies ${got} value(s) but ${expected} view column(s) are targeted`,
		});
	}
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTable(schema: string, table: string): string {
	return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Re-plan one base op through the matching base-table builder. `extraConstraints`
 * carries the lens-routed CHECKs (basis terms) to merge into the per-row check
 * pipeline: row-local / child-FK / set-level for insert+update, and the parent-side
 * FK `NOT EXISTS` for update **and delete** (a delete can orphan a logical child, so
 * the delete base op now threads them too). For the single-source spine there is
 * exactly one base op, so the constraints route unambiguously onto it; multi-source
 * put fan-out (which would route per member) is a later phase and is write-rejected
 * upstream, so the constraints never reach an ambiguous fan-out here.
 */
function buildBaseOp(ctx: PlanningContext, op: BaseOp, extraConstraints: ReadonlyArray<RowConstraintSchema>): PlanNode {
	switch (op.op) {
		case 'insert':
			return buildInsertStmt(ctx, op.statement as AST.InsertStmt, extraConstraints);
		case 'update':
			return buildUpdateStmt(ctx, op.statement as AST.UpdateStmt, extraConstraints);
		case 'delete':
			return buildDeleteStmt(ctx, op.statement as AST.DeleteStmt, extraConstraints);
	}
}
