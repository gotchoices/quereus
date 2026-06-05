import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type TableDescriptor } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { RowOpFlag, type RowConstraintSchema } from '../../schema/table.js';
import { ViewMutationNode } from '../nodes/view-mutation-node.js';
import { propagate, decompositionStorage, type BaseOp, type MutableViewLike, type MutationRequest } from '../mutation/propagate.js';
import { analyzeMultiSourceInsert, analyzeJoinView, decomposeUpdate, decomposeDelete, buildMultiSourceKeyCapture, buildMultiSourceUpdateReturning, buildMultiSourceDeleteReturning, makeMultiSourceKeyRef, isJoinBody, MS_UPDATE_KEYS_CTE, type MultiSourceKeyCapture, type JoinViewAnalysis, type CrossSourceValue } from '../mutation/multi-source.js';
import { analyzeDecompositionInsert, type DecompInsertOp } from '../mutation/decomposition.js';
import { isSetOpMembershipBody, buildSetOpWrite } from '../mutation/set-op.js';
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
import { validateDeterministicDefault } from '../validation/determinism-validator.js';

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

	// Set-operation membership write (binary, non-nested): the per-branch fan-out keyed
	// on the runtime membership probe needs a plan-level capture (the affected rows +
	// their probe flags, materialized once before any branch op fires — Halloween-safe),
	// which the AST `BaseOp[]` model cannot express. Build it directly (the dual of the
	// multi-source insert), for insert / update / delete alike. A plain (flag-less)
	// set-op body is NOT this case — it keeps rejecting `unsupported-set-op` downstream.
	if (isSetOpMembershipBody(view.selectAst)) {
		return buildSetOpMutation(ctx, view, req);
	}

	// Lens set-level conflict-resolution gate: a commit-time set-level key (no basis
	// covering structure) enforces via an O(n) deferred count scan, which cannot
	// perform `or replace` / `or ignore`. Reject those up front so a write that would
	// silently ABORT-at-commit instead of skipping/replacing is caught with a clear
	// diagnostic. A row-time key (backed by a basis UNIQUE + covering MV) is NOT
	// gated — its basis UC's covering-MV enforcement resolves the conflict action for
	// free (`lens-set-level-rowtime-enforcement`, delivered).
	rejectLensSetLevelConflictResolution(ctx, view, req);

	// Multi-source inner-join UPDATE / DELETE: plan the join body ONCE here and thread
	// the single analysis through decomposition, the identity capture, and the
	// RETURNING re-query — so no consumer re-plans the body via AST (the retired
	// double-plan; docs/view-updateability.md § Round-Trip Laws and the Derived
	// Backward Walk). A decomposition-backed logical table (a `primary-storage`
	// advertisement) is NOT this case — it routes to `propagate`'s advertisement
	// fan-out (`decomposition.ts`); a single-source body routes to the spine.
	const msAnalysis: JoinViewAnalysis | undefined =
		(req.op === 'update' || req.op === 'delete') && isJoinBody(view.selectAst) && !decompositionStorage(ctx, view)
			? analyzeJoinView(ctx, view)
			: undefined;

	// Cross-source SET values (`update v set a.x = b.y`) the multi-source UPDATE lowers
	// to a correlated read of the captured partner column accumulate here, then thread
	// into the identity capture so the same `__vmupd_keys` set carries them (§ Inner
	// Join). Empty for delete / single-source / decomposition.
	const sourceValues: CrossSourceValue[] = [];
	let baseOps: BaseOp[];
	if (msAnalysis && req.op === 'update') {
		baseOps = decomposeUpdate(ctx, view, msAnalysis, req.stmt, sourceValues);
	} else if (msAnalysis && req.op === 'delete') {
		baseOps = decomposeDelete(ctx, view, msAnalysis, req.stmt);
	} else {
		baseOps = propagate(ctx, view, withTags(req, tags));
	}
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
	// Multi-source identity capture (docs/view-updateability.md § Inner Join): an
	// UPDATE that assigns BOTH base sides (⇒ more than one base op) — or carries
	// RETURNING — and a lenient DELETE fanned out to BOTH candidate sides (⇒ more than
	// one base op) capture each affected view row's base-PK identities ONCE up-front,
	// *before* any base op mutates. The multi-side base ops read their identifying
	// values back from that captured set (so the first op can't empty the join — or
	// rewrite a predicate column — out from under the second op's identifying
	// subquery), and the UPDATE RETURNING re-query re-projects by captured identity.
	// Built once and shared.
	const keyCapture = buildIdentityCapture(ctx, view, req, baseOps, msAnalysis, sourceValues);
	// EVERY multi-source update/delete base op now resolves `select k<side> from
	// __vmupd_keys` against the context-backed key relation (single-side and both-sides
	// alike — the live join-body subquery is retired), so inject a fresh key ref per op
	// (sharing the one capture descriptor) into each op's planning `cteNodes`. Non
	// multi-source paths build no capture, so this is a no-op there.
	const injectKeyRef = !!keyCapture;
	// A write through a *lens* view (a lens slot exists for it) is the only view-mutation
	// the runtime parent-side **logical** FK machinery applies to — the same predicate the
	// lens*Constraints collectors above use. Plain updatable view / MV write-through lowers
	// to a basis write too, but has no lens slot ⇒ `lensRouted = false` ⇒ basis-only FK
	// semantics. Threaded onto each single-source-spine base op's DmlExecutorNode so the
	// runtime can distinguish a lens-routed basis write from a basis-direct one.
	const isLensWrite = !!ctx.schemaManager.getSchema(view.schemaName)?.getLensSlot(view.name);
	const children = baseOps.map(op =>
		buildBaseOp(injectKeyRef ? withKeyCapture(ctx, keyCapture!) : ctx, op, extraConstraints, isLensWrite));

	// RETURNING-through-view. Single-source already embedded the (rewritten)
	// RETURNING onto its base op (it now plans to a relational ReturningNode the
	// substrate surfaces), so nothing more is needed there. A **multi-source**
	// update/delete cannot recover the view row from its per-side base ops: a delete
	// re-queries the view *before* the base ops fire (its rows are about to vanish);
	// an update re-queries the join body *after* restricted to the captured identities
	// (robust against an update that rewrites its own predicate column).
	const { returning, returningTiming } = buildMultiSourceReturning(ctx, view, req, keyCapture, msAnalysis);
	const identityCapture = keyCapture ? { source: keyCapture.source, descriptor: keyCapture.descriptor } : undefined;
	return new ViewMutationNode(ctx.scope, children, returning, undefined, returningTiming, identityCapture);
}

/**
 * Build the shared up-front identity capture for a multi-source inner-join UPDATE /
 * DELETE. Now built for **every** such mutation (the single-side live join-body
 * subquery is retired — single-side and both-sides alike read the captured set), with
 * `analysis` the SINGLE plan of the join body threaded from {@link buildViewMutation}
 * so the body is planned once. `undefined` for everything else (inserts, single-source
 * spines, decomposition-backed tables — none thread an `analysis`).
 *
 * The captured sides are the sides whose base ops read the set, EXCEPT an UPDATE with
 * RETURNING captures EVERY side's PK — its post-mutation re-query identifies the full
 * joined row by all sides' keys, so it needs a key on each side even when only one side
 * is assigned (matching the retired path, whose RETURNING capture also projected both
 * sides' PKs). Composite-PK sides contribute one capture column per PK column.
 *
 * `sourceValues` carries any cross-source SET reads `decomposeUpdate` lowered (the
 * partner base columns a `set a.x = b.y` reads); they ride the SAME capture as extra
 * `srcN` projections (so a single-side cross-source update — which previously needed no
 * capture distinct from the unified one — still materializes it once with the read
 * column). Empty for delete.
 */
function buildIdentityCapture(
	ctx: PlanningContext,
	view: MutableViewLike,
	req: MutationRequest,
	baseOps: readonly BaseOp[],
	analysis: JoinViewAnalysis | undefined,
	sourceValues: readonly CrossSourceValue[],
): MultiSourceKeyCapture | undefined {
	if (!analysis) return undefined; // only multi-source update/delete thread an analysis
	switch (req.op) {
		case 'update': {
			const hasReturning = !!req.stmt.returning && req.stmt.returning.length > 0;
			const sides = hasReturning ? analysis.sides.map((_, i) => i) : capturedSideIndices(baseOps, analysis);
			return buildMultiSourceKeyCapture(ctx, view, req.stmt.where, analysis, sides, sourceValues);
		}
		case 'delete':
			return buildMultiSourceKeyCapture(ctx, view, req.stmt.where, analysis, capturedSideIndices(baseOps, analysis));
		default:
			return undefined;
	}
}

/**
 * The distinct join-side indices the emitted base ops target (each base op carries the
 * planned side's `TableReferenceNode`), sorted ascending — the sides whose PKs the
 * capture must project so each op's `select k<side> from __vmupd_keys` resolves.
 */
function capturedSideIndices(baseOps: readonly BaseOp[], analysis: JoinViewAnalysis): number[] {
	const set = new Set<number>();
	for (const op of baseOps) {
		const i = analysis.sides.findIndex(s => s.table.id === op.table.id);
		if (i >= 0) set.add(i);
	}
	return [...set].sort((a, b) => a - b);
}

/**
 * A planning context whose `cteNodes` resolves `__vmupd_keys` to a freshly-minted
 * context-backed key relation (over the shared capture descriptor), so a multi-side
 * base op's `select k<side> from __vmupd_keys` identifying subquery reads the
 * materialized capture rows. A fresh ref per call keeps each base op's subtree from
 * sharing a node instance.
 */
function withKeyCapture(ctx: PlanningContext, capture: MultiSourceKeyCapture): PlanningContext {
	const cteNodes = new Map(ctx.cteNodes ?? []);
	cteNodes.set(MS_UPDATE_KEYS_CTE, makeMultiSourceKeyRef(ctx.scope, capture));
	return { ...ctx, cteNodes };
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
 *  - **UPDATE** re-queries the join body *after* the base ops, restricted to the
 *    `keyCapture` identities captured *before* them (`returningTiming: 'post'`;
 *    `buildMultiSourceUpdateReturning`). This is robust against an update that
 *    rewrites a column its own WHERE filters on — the captured identity still matches
 *    even though the changed row no longer satisfies the predicate. The capture is
 *    built (and materialized) by {@link buildViewMutation} and shared with the
 *    both-sides base ops, so it is passed in rather than rebuilt here.
 *  - **DELETE** re-queries the join body restricted to the identifying predicate,
 *    captured `pre` (before the base op fires — the rows still match the predicate and
 *    are about to vanish; `returningTiming: 'pre'`; `buildMultiSourceDeleteReturning`).
 *    The RETURNING columns are recomputed in **base terms** over the planned `joinNode`
 *    (shared with the UPDATE path via `buildMultiSourceReturningProjection`), not by
 *    reference to the body `root`'s output attribute ids — so a body-computed column
 *    whose intermediate id project-merge eliminates still surfaces.
 */
function buildMultiSourceReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	req: MutationRequest,
	keyCapture: MultiSourceKeyCapture | undefined,
	analysis: JoinViewAnalysis | undefined,
): { returning?: RelationalPlanNode; returningTiming?: 'pre' | 'post' } {
	const returningCols = req.stmt.returning;
	if (!returningCols || returningCols.length === 0) return {};
	if (req.op === 'insert') return {}; // single-source insert embeds; multi-source insert is rejected upstream
	if (!analysis) return {}; // only multi-source update/delete thread an analysis

	if (req.op === 'update') {
		// keyCapture is guaranteed present here: buildIdentityCapture builds it
		// whenever a multi-source update carries RETURNING (same gating conditions).
		const returning = buildMultiSourceUpdateReturning(ctx, view, req.stmt, keyCapture!, analysis);
		return { returning, returningTiming: 'post' };
	}

	// DELETE: the OLD view image of the rows about to vanish, captured `pre`. Built in
	// base terms over the planned `joinNode` (recomputing each view-spelled column from
	// base columns) — robust against a body-computed column whose intermediate output
	// attribute id the optimizer eliminates (project-merge), which a by-id reference to
	// the body `root` would dangle on. Mirrors the UPDATE RETURNING path.
	const node = buildMultiSourceDeleteReturning(ctx, view, req.stmt, analysis);
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
 * Build the set-operation membership-write substrate (docs/view-updateability.md
 * § Set Operations) — the first set-op view writability in the engine.
 *
 * `buildSetOpWrite` (planner/mutation/set-op.ts) decomposes the write into the ordered
 * per-branch base ops (each lowered through `propagate` against a synthetic branch
 * view-like, so the branch's own spine handles its base routing) plus the up-front
 * affected-row capture they read. We wire the capture through the SAME `identityCapture`
 * side input + context-backed `__vmupd_keys` relation the multi-source path uses (so the
 * branch ops' `exists (… from __vmupd_keys …)` resolves), and sequence the base ops in a
 * void `ViewMutationNode` (no RETURNING through a set-op write in v1). Insert-through
 * carries no capture (its values are self-contained), so no key ref is injected there.
 */
function buildSetOpMutation(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): PlanNode {
	const { baseOps, capture } = buildSetOpWrite(ctx, view, req);
	// Each probe-driven branch op reads the capture back through `__vmupd_keys`; inject a
	// fresh context-backed key ref (sharing the one capture descriptor) per op, exactly as
	// the multi-source update/delete path does. Insert-through has no capture ⇒ no injection.
	const opCtx = capture ? withKeyCapture(ctx, capture) : ctx;
	const children = baseOps.map(op => buildBaseOp(opCtx, op, [], false));
	const identityCapture = capture ? { source: capture.source, descriptor: capture.descriptor } : undefined;
	return new ViewMutationNode(ctx.scope, children, undefined, undefined, undefined, identityCapture);
}

/**
 * Build the shared-surrogate envelope substrate for a multi-source inner-join
 * INSERT (docs/view-updateability.md § Inner Join — Inserts, § Mutation Context).
 *
 * The decomposition (`analyzeMultiSourceInsert`) yields the per-side base inserts
 * plus the envelope shape. We build:
 *   - the **envelope source** — the user's VALUES/SELECT, whose columns are the
 *     supplied view columns. The `ViewMutation` emitter materializes it once,
 *     appends the default-sourced shared key (if any) per row, and stashes the rows
 *     in context;
 *   - one **base insert per side**, each sourcing from a projection over an
 *     `EnvelopeScanNode` that reads those shared rows back (key first, then the
 *     view columns that side owns). Re-planned through the ordinary base-table
 *     builder, so every constraint / conflict / FK / default rule is reused; and
 *   - the **key default** (the anchor key column's declared `default`), evaluated
 *     once per produced row at the envelope.
 *
 * The sides are already FK-parent-before-FK-child ordered; the emitter drives them
 * in that order. Every side reads the same materialized envelope, so the shared key
 * is evaluated exactly once per produced row and threaded identically.
 */
function buildMultiSourceInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): PlanNode {
	const plan = analyzeMultiSourceInsert(ctx, view, stmt);

	const { envelopeAttrs, envelopeType, descriptor } = buildEnvelopeShape(plan.suppliedColumns, !!plan.keyDefault);

	const baseOps = plan.orderedSides.map(side => {
		const scan = new EnvelopeScanNode(ctx.scope, descriptor, envelopeAttrs, envelopeType);
		// A non-preserved (outer-join optional) side inserts only for rows that supply ≥1
		// of its columns — gate the envelope through the same presence FilterNode the
		// decomposition fan-out uses (`buildDecompositionMemberInsert`). Empty ⇒
		// unconditional (a preserved / inner side).
		const gated: RelationalPlanNode = side.presenceGateIndices.length > 0
			? new FilterNode(ctx.scope, scan, buildPresenceGate(ctx, envelopeAttrs, side.presenceGateIndices))
			: scan;
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
		const source = new ProjectNode(ctx.scope, gated, projections, undefined, undefined, false);

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
		// Leaves `lensRouted = false` (default): a multi-source parent resolves to no
		// single basis spine, so the runtime parent-side cascade reverse-map never matches
		// it — the marker would have no effect. The single-source spine (`buildBaseOp`) is
		// the only place it is load-bearing. Do not "fix" this omission.
		return buildInsertStmt(ctx, sideInsert, [], source);
	});

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);
	const keyDefault = buildKeyDefault(ctx, view, plan.keyDefault);

	return new ViewMutationNode(ctx.scope, baseOps, undefined, { source: envelopeSource, descriptor, keyDefault });
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
 * `EnvelopeScanNode`), and the **key default** (the anchor key column's declared
 * `default`) when the shared key is a surrogate. Every member reads the same
 * materialized envelope, so the default is evaluated once per produced row and the
 * value threads identically across the fan-out.
 */
function buildDecompositionInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): PlanNode {
	const storage = decompositionStorage(ctx, view)!; // guaranteed by the caller's gate
	const plan = analyzeDecompositionInsert(ctx, view, storage, stmt);

	const { envelopeAttrs, envelopeType, descriptor } = buildEnvelopeShape(plan.suppliedColumns, !!plan.keyDefault);

	const baseOps = plan.ops.map(op =>
		buildDecompositionMemberInsert(ctx, stmt, descriptor, envelopeAttrs, envelopeType, op));

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);
	const keyDefault = buildKeyDefault(ctx, view, plan.keyDefault);

	return new ViewMutationNode(ctx.scope, baseOps, undefined, { source: envelopeSource, descriptor, keyDefault });
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
 * Compile the `MutationEnvelope.keyDefault` from the anchor key column's declared
 * `default` AST (or `undefined` when the shared key is directly supplied). The
 * emitter evaluates it once per produced row — with `mutation_ordinal()` resolving
 * to the row's ordinal and any `max()` subquery observing the pre-mutation state
 * (no base write has fired yet). Determinism is validated exactly as a base-column
 * default is on the single-source insert path (skipped under
 * `nondeterministic_schema`), so a `uuid7()`-style default rides the same
 * capture-once-and-thread guarantee.
 */
function buildKeyDefault(
	ctx: PlanningContext,
	view: MutableViewLike,
	keyDefault: AST.Expression | undefined,
): ScalarPlanNode | undefined {
	if (!keyDefault) return undefined;
	const node = buildExpression(ctx, keyDefault) as ScalarPlanNode;
	if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
		validateDeterministicDefault(node, '<shared key>', view.name);
	}
	return node;
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
	// Leaves `lensRouted = false` (default) for the same reason as the multi-source
	// path: a decomposition parent has no single basis spine for the runtime parent-side
	// cascade reverse-map to match, so the marker is moot here. Do not "fix" this.
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
function buildBaseOp(
	ctx: PlanningContext,
	op: BaseOp,
	extraConstraints: ReadonlyArray<RowConstraintSchema>,
	lensRouted: boolean,
): PlanNode {
	switch (op.op) {
		case 'insert':
			return buildInsertStmt(ctx, op.statement as AST.InsertStmt, extraConstraints, undefined, lensRouted);
		case 'update':
			return buildUpdateStmt(ctx, op.statement as AST.UpdateStmt, extraConstraints, lensRouted);
		case 'delete':
			return buildDeleteStmt(ctx, op.statement as AST.DeleteStmt, extraConstraints, lensRouted);
	}
}
