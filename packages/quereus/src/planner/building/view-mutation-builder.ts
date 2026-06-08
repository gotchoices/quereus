import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute, type TableDescriptor, type RowDescriptor } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { RowOpFlag, type RowConstraintSchema } from '../../schema/table.js';
import { ViewMutationNode } from '../nodes/view-mutation-node.js';
import { propagate, decompositionStorage, type BaseOp, type MutableViewLike, type MutationRequest } from '../mutation/propagate.js';
import { analyzeMultiSourceInsert, analyzeJoinView, decomposeUpdate, decomposeDelete, buildMultiSourceKeyCapture, buildMultiSourceUpdateReturning, buildMultiSourceDeleteReturning, makeMultiSourceKeyRef, isJoinBody, MS_UPDATE_KEYS_CTE, type MultiSourceKeyCapture, type JoinViewAnalysis, type CrossSourceValue } from '../mutation/multi-source.js';
import { analyzeDecompositionInsert, analyzeDecomposition, decomposeUpdate as decomposeDecompositionUpdate, buildDecompositionKeyCapture, type DecompInsertOp, type DecompShape, type CapturedDecompValue } from '../mutation/decomposition.js';
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
import { buildRowDefaultScope } from './default-scope.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:view-mutation');

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

	// Record a `view` schema dependency for the mutated view/MV. This is the single
	// funnel for ALL view-/MV-mediated writes (single-source, multi-source,
	// decomposition, set-op, lens), so recording here — rather than at each builder's
	// getView site — covers every write-through path DRY. It exists so that an
	// `ALTER VIEW/MATERIALIZED VIEW … SET TAGS` (which fires `view_modified` /
	// `materialized_view_modified`) invalidates this cached write-through plan, since
	// the view's behavioral `quereus.update.*` tags steer the routing collected above.
	// Read-only `select … from v` records no view dependency — view tags do not affect
	// read results, so its plan need not invalidate on a tag change.
	ctx.schemaDependencies.recordDependency(
		{ type: 'view', schemaName: view.schemaName, objectName: view.name },
		view,
	);

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

	// A decomposition-backed logical table UPDATE: plan the synthesized body ONCE here (so no
	// consumer re-plans it via AST — the same single-plan discipline the multi-source path
	// follows) and route directly to the decomposition decomposer with a captured-value carrier.
	// An arbitrary optional-columnar value rides the single-identity `__vmupd_keys` capture
	// (folded into the keyCapture machinery below); constant/anchor/self updates build no capture
	// and produce byte-identical base ops to the legacy `propagate` path. DELETE / INSERT through a
	// decomposition stay on `propagate` / the insert envelope (unchanged).
	const decompStorageShape = req.op === 'update' ? decompositionStorage(ctx, view) : undefined;
	const decompShape: DecompShape | undefined = decompStorageShape ? analyzeDecomposition(ctx, view, decompStorageShape) : undefined;

	// Cross-source SET values (`update v set a.x = b.y`) the multi-source UPDATE lowers
	// to a correlated read of the captured partner column accumulate here, then thread
	// into the identity capture so the same `__vmupd_keys` set carries them (§ Inner
	// Join). Empty for delete / single-source / decomposition.
	const sourceValues: CrossSourceValue[] = [];
	// Arbitrary optional-columnar values a decomposition UPDATE lowers to a captured read-back
	// accumulate here, then thread into the decomposition key capture (the dual of `sourceValues`).
	const capturedValues: CapturedDecompValue[] = [];
	let baseOps: BaseOp[];
	if (msAnalysis && req.op === 'update') {
		baseOps = decomposeUpdate(ctx, view, msAnalysis, req.stmt, sourceValues);
	} else if (msAnalysis && req.op === 'delete') {
		baseOps = decomposeDelete(ctx, view, msAnalysis, req.stmt);
	} else if (decompShape && req.op === 'update') {
		baseOps = decomposeDecompositionUpdate(ctx, view, decompShape, req.stmt, capturedValues);
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
	// Built once and shared. A decomposition UPDATE that lowered ≥1 arbitrary value builds the
	// single-identity (anchor-key) capture instead — the same `__vmupd_keys` substrate + downstream
	// wiring (`injectKeyRef` / `withKeyCapture` / `identityCapture`), with `k0_0` the anchor key and
	// one `srcN` per captured value. An empty carrier (constant/anchor/self) builds no capture.
	const keyCapture = decompShape && req.op === 'update'
		? (capturedValues.length > 0 ? buildDecompositionKeyCapture(ctx, view, decompShape, req.stmt.where, capturedValues) : undefined)
		: buildIdentityCapture(ctx, view, req, baseOps, msAnalysis, sourceValues);
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
	// A lens-synthesized constraint (set-level uniqueness / row-local CHECK / child-FK
	// EXISTS / parent-FK NOT EXISTS) references write-row columns in *basis* terms. On a
	// multi-op fan-out (a decomposition UPDATE) those columns may live on only some
	// members, so threading the SAME `extraConstraints` onto every base op would make a
	// member op that lacks a referenced column fail to build (`NEW.<col> isn't a column`).
	// Gate per op: a constraint rides a base op iff every write-row column it references
	// resolves on that op's target table — so a uniqueness CHECK rides only the op that
	// owns (and can change) the key, and a cross-member CHECK/FK rides the single member
	// that resolves it (or none — deferred, as on decomposition INSERT). Single-source has
	// exactly one base op carrying all basis columns, so this is a no-op there.
	const riddenConstraints = new Set<RowConstraintSchema>();
	const children = baseOps.map(op => {
		const opCtx = injectKeyRef ? withKeyCapture(ctx, keyCapture!) : ctx;
		const opConstraints = constraintsForOp(op, extraConstraints, riddenConstraints);
		return buildBaseOp(opCtx, op, opConstraints, isLensWrite);
	});
	// A lens-synthesized constraint that resolves on NO base op of the fan-out is silently
	// non-enforced (a key-unchanged UPDATE drops its uniqueness scan — correct; a CHECK/FK
	// spanning more than one member is deferred — as on decomposition INSERT). Trace it so
	// the non-enforcement is at least visible in debug logs.
	for (const c of extraConstraints) {
		if (!riddenConstraints.has(c)) {
			log('lens constraint %s references write-row columns no base op of the %s fan-out carries; not enforced on this write', c.name ?? '<anon>', req.op);
		}
	}

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
	return slot ? collectLensRowLocalConstraints(ctx, slot) : [];
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

	// Produced-row NEW context shared by every side's default scope (the dual of the
	// decomposition fan-out's): a side's column default can correlate on a sibling
	// supplied column its own base table does not carry, via `new.<col>`.
	const sideNewRowScope = buildMemberDefaultRowScope(ctx, plan.suppliedColumns, envelopeAttrs);

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
			// The shared-key column of an FK-child side is threaded conditionally: it
			// projects null for a row whose presence-gated partner is absent, so the FK
			// does not dangle (§ Outer Joins — Inserts). Every other column — and the key
			// of an unconditional (parent/anchor) side — is a plain envelope reference.
			if (side.keyGate && k === side.keyGate.keyTargetIndex) {
				const node = buildGatedKeyProjection(ctx, envelopeAttrs, envIdx, side.keyGate.groups);
				return { node, alias: baseColumn };
			}
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
		return buildInsertStmt(ctx, sideInsert, [], source, false, sideNewRowScope);
	});

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);
	const keyDefault = buildKeyDefault(ctx, view, plan.keyDefault, plan.suppliedColumns);

	return new ViewMutationNode(ctx.scope, baseOps, undefined, {
		source: envelopeSource,
		descriptor,
		keyDefault: keyDefault?.node,
		keyDefaultRowDescriptor: keyDefault?.rowDescriptor,
	});
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
 *
 * Lens constraint obligations (row-local CHECK / child-side FK / set-level uniqueness)
 * ride the member inserts under the SAME per-op resolvability gate the decomposition
 * UPDATE path uses (`constraintsForOp`): a single-member-resolvable obligation fires on
 * the member that owns its write-row columns; a cross-member one resolves on no single
 * member op and stays deferred. A plain (non-lens) decomposition collects none.
 */
function buildDecompositionInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): PlanNode {
	const storage = decompositionStorage(ctx, view)!; // guaranteed by the caller's gate

	// This path early-returns from `buildViewMutation` before its `rejectLensSetLevelConflictResolution`
	// gate (the decomposition routing sits above it), so run the gate here too. Now that the fan-out
	// threads the commit-time set-level count CHECK (below), an `insert or replace` / `or ignore` /
	// upsert through a decomposition with a commit-time set-level key would otherwise silently
	// ABORT-at-commit instead of getting the documented up-front diagnostic (docs/lens.md
	// § Enforcement by constraint class). A plain insert / `or abort` is unaffected.
	rejectLensSetLevelConflictResolution(ctx, view, { op: 'insert', stmt });

	const plan = analyzeDecompositionInsert(ctx, view, storage, stmt);

	const { envelopeAttrs, envelopeType, descriptor } = buildEnvelopeShape(plan.suppliedColumns, !!plan.keyDefault);

	// The produced logical row's NEW context, shared by every member insert's default
	// scope: each supplied logical column registered as `new.<col>` over the shared
	// envelope attributes (the same surface the single-source insert path exposes). A
	// member's key-column / NOT NULL default can thereby correlate on a sibling logical
	// column its own base table does not carry (e.g. an anchor surrogate default
	// `default (select … where parent.key = new.<fk>)`). The envelope attributes stay
	// resolvable through the member insert's pipeline — the narrowing envelope
	// projection keeps them bound while downstream rows are produced.
	const memberNewRowScope = buildMemberDefaultRowScope(ctx, plan.suppliedColumns, envelopeAttrs);

	// Lens enforcement on the decomposition INSERT fan-out — the dual of the per-op gate the
	// decomposition UPDATE path runs in `buildViewMutation` (the `extraConstraints` /
	// `constraintsForOp` seam). Collect the three INSERT-applicable lens constraint classes —
	// row-local CHECK, child-side FK existence, and commit-time set-level uniqueness —
	// synthesized in *basis* terms. Parent-side FK is DELETE/UPDATE-only (an INSERT cannot
	// orphan a logical child), so it is deliberately NOT collected here. Each constraint is
	// gated per member op by `constraintsForOp`: a single-member-resolvable obligation (every
	// write-row column it references lives on one member's table) rides that member insert and
	// fires; a cross-member obligation resolves on no single member op ⇒ rides none ⇒ stays
	// deferred (the documented, deliberately-weaker contract — the same boundary the UPDATE
	// fan-out draws). For a plain (non-lens) decomposition all three collectors return `[]`,
	// so this path pays nothing.
	const extraConstraints = [
		...lensRowLocalConstraints(ctx, view),
		...lensForeignKeyConstraints(ctx, view),
		...lensSetLevelConstraints(ctx, view),
	];
	const riddenConstraints = new Set<RowConstraintSchema>();

	const baseOps = plan.ops.map(op =>
		buildDecompositionMemberInsert(
			ctx, stmt, descriptor, envelopeAttrs, envelopeType, op, memberNewRowScope,
			constraintsForOp(op, extraConstraints, riddenConstraints)));

	// A lens constraint that resolves on NO member op of the fan-out (a cross-member CHECK /
	// FK / set-level key) is silently deferred — trace it so the non-enforcement is visible in
	// debug logs, mirroring the UPDATE fan-out's trace loop in `buildViewMutation`.
	for (const c of extraConstraints) {
		if (!riddenConstraints.has(c)) {
			log('lens constraint %s references write-row columns no member op of the decomposition insert fan-out carries; not enforced on this write', c.name ?? '<anon>');
		}
	}

	const envelopeSource = buildEnvelopeSource(ctx, view, stmt, plan.suppliedColumns.length);
	const keyDefault = buildKeyDefault(ctx, view, plan.keyDefault, plan.suppliedColumns);

	return new ViewMutationNode(ctx.scope, baseOps, undefined, {
		source: envelopeSource,
		descriptor,
		keyDefault: keyDefault?.node,
		keyDefaultRowDescriptor: keyDefault?.rowDescriptor,
	});
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
 *
 * The key default may read a value the INSERT supplies for a sibling view column via
 * `new.<col>` (the same surface as the single-source insert path — e.g.
 * `default (coalesce((select max(rid) from anchor), 0) + new.seq)`). We mint fresh
 * attributes for the supplied envelope columns and build the default against a row
 * scope registering them as `new.<col>` (and bare `<col>`); the returned
 * `rowDescriptor` maps those fresh attribute ids to source-row positions, and the
 * emitter installs it over each source row while evaluating the default. Minting fresh
 * (rather than reusing the `EnvelopeScanNode` attributes) keeps the reference
 * self-contained so the optimizer cannot dangle it.
 */
function buildKeyDefault(
	ctx: PlanningContext,
	view: MutableViewLike,
	keyDefault: AST.Expression | undefined,
	suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[],
): { node: ScalarPlanNode; rowDescriptor: RowDescriptor } | undefined {
	if (!keyDefault) return undefined;

	// Fresh attributes for the supplied envelope columns, referenced only by this key
	// default's `new.<col>` column refs and resolved at runtime via the row slot the
	// emitter installs over each source row (key minted before `__shared_key` append).
	const rowAttrs: Attribute[] = suppliedColumns.map(col => ({
		id: PlanNode.nextAttrId(),
		name: col.name,
		type: col.type,
		sourceRelation: 'envelope-key-default',
	}));
	const rowScope = buildRowDefaultScope(ctx.scope, suppliedColumns, rowAttrs);

	const node = buildExpression({ ...ctx, scope: rowScope }, keyDefault) as ScalarPlanNode;
	if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
		validateDeterministicDefault(node, '<shared key>', view.name);
	}

	const rowDescriptor: RowDescriptor = [];
	rowAttrs.forEach((attr, index) => { rowDescriptor[attr.id] = index; });
	return { node, rowDescriptor };
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
	/** The produced-row NEW context (`new.<col>` over the supplied envelope columns)
	 *  threaded into this member's default-build scope (see {@link buildDecompositionInsert}). */
	memberNewRowScope: RegisteredScope,
	/** The lens constraints (row-local CHECK / child-FK / set-level) gated onto THIS member op
	 *  by `constraintsForOp` — the single-member-resolvable subset whose every write-row column
	 *  resolves on this member's table. `[]` for a non-lens decomposition or a member that
	 *  resolves no obligation (see {@link buildDecompositionInsert}). */
	extraConstraints: ReadonlyArray<RowConstraintSchema>,
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
	// Lens enforcement rides via `extraConstraints`, the per-op-gated subset
	// `buildDecompositionInsert` computed for this member (`constraintsForOp`): a
	// single-member-resolvable obligation (row-local CHECK / child-FK / set-level whose
	// write-row columns all resolve on this member's table) fires on this member insert; a
	// cross-member one resolves on no member op and stays deferred. The same threading seam
	// the single-source insert spine uses (`buildInsertStmt`'s `extraConstraints`), composed
	// here with the `projectedSource` (the envelope projection) — the two params are
	// independent. Leaves `lensRouted = false` (default): a decomposition parent has no single
	// basis spine for the runtime parent-side cascade reverse-map to match, so the marker is
	// moot here (do not "fix" this) — and parent-side FK is not collected for an INSERT anyway.
	// `memberNewRowScope` threads the produced row's `new.<col>` context so this member's
	// defaults resolve against the supplied logical row (not only this member's own columns).
	return buildInsertStmt(ctx, memberInsert, extraConstraints, projectedSource, false, memberNewRowScope);
}

/**
 * Build the produced-row NEW context every member insert of a fan-out shares: each
 * supplied logical column registered as `new.<col>` (and the bare form, unless a
 * member shadows it) over the shared envelope attributes — the same `new.<col>`
 * surface the single-source insert path exposes, lifted to the produced *logical*
 * row. A member insert's default-build scope parents on this, so a default can
 * correlate on a sibling supplied column the member's own base table does not carry.
 * The envelope attributes it references stay resolvable through each member insert's
 * pipeline because the narrowing envelope projection keeps its source row bound.
 */
function buildMemberDefaultRowScope(
	ctx: PlanningContext,
	suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[],
	envelopeAttrs: Attribute[],
): RegisteredScope {
	return buildRowDefaultScope(ctx.scope, suppliedColumns, envelopeAttrs);
}

/**
 * A scope resolving each envelope column by name to a `ColumnReferenceNode` over the
 * materialized envelope rows (by the attribute's stable id + position). Shared by
 * {@link buildPresenceGate} and {@link buildGatedKeyProjection}, so a parsed predicate /
 * CASE over the envelope columns binds identically to the inlined plan nodes.
 */
function envelopeColumnScope(ctx: PlanningContext, envelopeAttrs: Attribute[]): RegisteredScope {
	const scope = new RegisteredScope(ctx.scope);
	envelopeAttrs.forEach((attr, i) => {
		scope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
	});
	return scope;
}

/** The `<col> is not null` OR-disjunction over the envelope columns named by `indices`. */
function presencePredicateSql(envelopeAttrs: Attribute[], indices: readonly number[]): string {
	return indices.map(i => `${quoteIdent(envelopeAttrs[i].name)} is not null`).join(' or ');
}

/**
 * Build the per-row presence predicate gating an optional / EAV member insert:
 * `<col> is not null [or <col> is not null …]` over the envelope columns named by
 * `gateIndices`. Resolved against a scope registering the envelope attributes (by
 * their stable ids), so the predicate reads the materialized envelope rows.
 */
function buildPresenceGate(ctx: PlanningContext, envelopeAttrs: Attribute[], gateIndices: readonly number[]): ScalarPlanNode {
	const gateScope = envelopeColumnScope(ctx, envelopeAttrs);
	const ast = parseExpressionString(presencePredicateSql(envelopeAttrs, gateIndices));
	return buildExpression({ ...ctx, scope: gateScope }, ast) as ScalarPlanNode;
}

/**
 * Build the conditional shared-key projection for an FK-child side whose key column
 * must not dangle: `case when <pred> then "<keyCol>" else null end`, where `<pred>` is
 * the AND, over each presence-gated FK-parent partner, of that partner's presence
 * predicate (the OR of its supplied columns being non-null). When every referenced
 * partner is absent for a row, the key projects null — the correct "no partner" marker —
 * so the preserved FK-child row does not reference a shared key with no partner row
 * (§ Outer Joins — Inserts). `keyEnvIdx` names the key column (the appended
 * `__shared_key` or a supplied key view column); resolved against the same envelope
 * column scope {@link buildPresenceGate} uses.
 */
function buildGatedKeyProjection(
	ctx: PlanningContext,
	envelopeAttrs: Attribute[],
	keyEnvIdx: number,
	groups: readonly (readonly number[])[],
): ScalarPlanNode {
	const scope = envelopeColumnScope(ctx, envelopeAttrs);
	const pred = groups.map(g => `(${presencePredicateSql(envelopeAttrs, g)})`).join(' and ');
	const keyCol = quoteIdent(envelopeAttrs[keyEnvIdx].name);
	const ast = parseExpressionString(`case when ${pred} then ${keyCol} else null end`);
	return buildExpression({ ...ctx, scope }, ast) as ScalarPlanNode;
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
 * Filter the lens-synthesized `extraConstraints` to those a base op can build: a
 * constraint rides `op` iff every write-row column it references resolves on the op's
 * target-table columns (case-insensitive). Each constraint that rides ≥1 op is recorded
 * in `ridden` so the caller can trace any that rode none (a silently-deferred cross-member
 * CHECK/FK, or a dropped uniqueness scan on a key-unchanged UPDATE).
 *
 * The write-row column set comes from one of two sources. A lens-synthesized **row-local
 * CHECK** carries `referencedWriteRowColumns` — prover-supplied lowercased basis names
 * (`collectLensRowLocalConstraints`) — which is preferred because the AST walk
 * ({@link writeRowColumns}) under-collects a correlated bare write-row ref that appears
 * only inside a subquery (a subquery-bearing row-local CHECK, which the prover still
 * classifies `enforced-row-local`). The FK / set-level classes leave it undefined and fall
 * back to the walk, which collects their `NEW.*` / `OLD.*` refs unambiguously anywhere.
 *
 * `extraConstraints` is exclusively lens-synthesized (the basis table's own checks are
 * added inside `buildConstraintChecks` from `tableSchema.checkConstraints`, never via
 * this seam), so gating every entry is safe.
 *
 * `op` is typed structurally on just its `table` so BOTH fan-out op shapes satisfy it: a
 * `BaseOp` (the single-source spine and the multi-source / decomposition UPDATE + DELETE
 * fan-out) and a `DecompInsertOp` (the decomposition INSERT fan-out, which routes per
 * member through {@link buildDecompositionInsert} — not via `buildBaseOp`). Both carry the
 * member's `TableReferenceNode`, so `op.table.tableSchema.columns` resolves the member's
 * columns directly for either.
 */
function constraintsForOp(
	op: Pick<BaseOp, 'table'>,
	extraConstraints: ReadonlyArray<RowConstraintSchema>,
	ridden: Set<RowConstraintSchema>,
): RowConstraintSchema[] {
	if (extraConstraints.length === 0) return [];
	const opCols = new Set(op.table.tableSchema.columns.map(c => c.name.toLowerCase()));
	const kept: RowConstraintSchema[] = [];
	for (const c of extraConstraints) {
		// Prefer the prover-supplied row-local metadata (already lowercased basis names);
		// fall back to the AST walk for FK / set-level constraints (which leave it undefined).
		const refs = c.referencedWriteRowColumns ?? writeRowColumns(c.expr);
		let resolvable = true;
		for (const col of refs) {
			if (!opCols.has(col)) { resolvable = false; break; }
		}
		if (resolvable) {
			ridden.add(c);
			kept.push(c);
		}
	}
	return kept;
}

/**
 * The lowercased set of **write-row** column names a lens-synthesized constraint
 * references — the columns that must resolve on a base op's target table for the
 * constraint to build there. Two reference classes count:
 *  - any `NEW.*` / `OLD.*`-qualified column **anywhere** (including nested in a
 *    subquery): the correlated write-row side of a set-level count subquery, a child-FK
 *    `EXISTS`, or a parent-FK `NOT EXISTS` (+ its UPDATE short-circuit guard);
 *  - any **bare** (unqualified) column **not** inside a subquery: a row-local CHECK
 *    rewritten to bare basis terms (`rewriteToBasisTerms`), whose bare top-level ref is a
 *    write-row ref.
 * Subquery-internal bare / alias-qualified refs (the count subquery's `_u.docKey`, an FK
 * child/parent alias) are assumed to resolve against the subquery's own FROM, not the
 * write row, so they are ignored.
 *
 * That subquery-free assumption is now only ever applied to the FK / set-level classes,
 * whose bare-in-subquery refs are genuinely FROM-resolved aliases. The **row-local CHECK**
 * class no longer reaches this walk: a subquery-bearing row-local CHECK could carry a
 * *correlated* bare write-row ref inside its subquery (the prover does not forbid a
 * subquery in a row-local CHECK), which this walk would under-collect, so the gate prefers
 * the prover-supplied `referencedWriteRowColumns` metadata for that class (see
 * {@link constraintsForOp} and `collectLensRowLocalConstraints`).
 */
function writeRowColumns(expr: AST.Expression): Set<string> {
	const cols = new Set<string>();
	collectWriteRowColumns(expr, false, cols);
	return cols;
}

/** Walk an expression collecting write-row column names (see {@link writeRowColumns}). */
function collectWriteRowColumns(expr: AST.Expression, insideSubquery: boolean, cols: Set<string>): void {
	switch (expr.type) {
		case 'column': {
			const qualifier = expr.table?.toLowerCase();
			if (qualifier === 'new' || qualifier === 'old') {
				cols.add(expr.name.toLowerCase());
			} else if (!insideSubquery && !expr.table && !expr.schema) {
				cols.add(expr.name.toLowerCase());
			}
			return;
		}
		case 'binary':
			collectWriteRowColumns(expr.left, insideSubquery, cols);
			collectWriteRowColumns(expr.right, insideSubquery, cols);
			return;
		case 'unary':
		case 'cast':
		case 'collate':
			collectWriteRowColumns(expr.expr, insideSubquery, cols);
			return;
		case 'function':
			expr.args.forEach(a => collectWriteRowColumns(a, insideSubquery, cols));
			return;
		case 'between':
			collectWriteRowColumns(expr.expr, insideSubquery, cols);
			collectWriteRowColumns(expr.lower, insideSubquery, cols);
			collectWriteRowColumns(expr.upper, insideSubquery, cols);
			return;
		case 'case':
			if (expr.baseExpr) collectWriteRowColumns(expr.baseExpr, insideSubquery, cols);
			expr.whenThenClauses.forEach(w => {
				collectWriteRowColumns(w.when, insideSubquery, cols);
				collectWriteRowColumns(w.then, insideSubquery, cols);
			});
			if (expr.elseExpr) collectWriteRowColumns(expr.elseExpr, insideSubquery, cols);
			return;
		case 'in':
			collectWriteRowColumns(expr.expr, insideSubquery, cols);
			if (expr.values) expr.values.forEach(v => collectWriteRowColumns(v, insideSubquery, cols));
			if (expr.subquery) collectQueryWriteRowColumns(expr.subquery, cols);
			return;
		case 'subquery':
			collectQueryWriteRowColumns(expr.query, cols);
			return;
		case 'exists':
			collectQueryWriteRowColumns(expr.subquery, cols);
			return;
		default:
			// literal / identifier / parameter / windowFunction / functionSource — no
			// write-row column ref to collect.
			return;
	}
}

/**
 * Descend into a subquery operand collecting only its `NEW.*` / `OLD.*`-qualified
 * (correlated write-row) refs — bare / alias-qualified refs resolve against the
 * subquery's own FROM and are skipped (`insideSubquery = true`).
 */
function collectQueryWriteRowColumns(query: AST.QueryExpr, cols: Set<string>): void {
	if (query.type === 'select') {
		for (const rc of query.columns) {
			if (rc.type !== 'all') collectWriteRowColumns(rc.expr, true, cols);
		}
		if (query.from) query.from.forEach(fc => collectFromWriteRowColumns(fc, cols));
		if (query.where) collectWriteRowColumns(query.where, true, cols);
		if (query.groupBy) query.groupBy.forEach(e => collectWriteRowColumns(e, true, cols));
		if (query.having) collectWriteRowColumns(query.having, true, cols);
		if (query.orderBy) query.orderBy.forEach(ob => collectWriteRowColumns(ob.expr, true, cols));
		if (query.limit) collectWriteRowColumns(query.limit, true, cols);
		if (query.offset) collectWriteRowColumns(query.offset, true, cols);
		if (query.compound) collectQueryWriteRowColumns(query.compound.select, cols);
		if (query.union) collectQueryWriteRowColumns(query.union, cols);
		return;
	}
	if (query.type === 'values') {
		query.values.forEach(row => row.forEach(e => collectWriteRowColumns(e, true, cols)));
	}
	// An INSERT/UPDATE/DELETE … RETURNING subquery: lens collectors never synthesize one,
	// so there is nothing to collect.
}

/** Collect write-row refs in a subquery's FROM (join conditions, TVF args, nested subqueries). */
function collectFromWriteRowColumns(fc: AST.FromClause, cols: Set<string>): void {
	switch (fc.type) {
		case 'table':
			return;
		case 'join':
			collectFromWriteRowColumns(fc.left, cols);
			collectFromWriteRowColumns(fc.right, cols);
			if (fc.condition) collectWriteRowColumns(fc.condition, true, cols);
			return;
		case 'functionSource':
			fc.args.forEach(a => collectWriteRowColumns(a, true, cols));
			return;
		case 'subquerySource':
			collectQueryWriteRowColumns(fc.subquery, cols);
			return;
	}
}

/**
 * Re-plan one base op through the matching base-table builder. `extraConstraints`
 * carries the lens-routed CHECKs (basis terms) to merge into the per-row check
 * pipeline: row-local / child-FK / set-level for insert+update, and the parent-side
 * FK `NOT EXISTS` for update **and delete** (a delete can orphan a logical child, so
 * the delete base op now threads them too). The caller (`buildViewMutation`) has already
 * gated `extraConstraints` per op via {@link constraintsForOp}, so the single-source spine
 * (one base op carrying all basis columns) receives the full set and a multi-op UPDATE /
 * DELETE fan-out receives only the obligations that resolve on this op's table. The
 * decomposition INSERT fan-out also routes per member, but through
 * {@link buildDecompositionMemberInsert} (which calls `buildInsertStmt` against the shared
 * envelope) rather than this path — so it runs the same gate independently there.
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
