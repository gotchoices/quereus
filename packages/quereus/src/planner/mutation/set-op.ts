import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { ScalarType } from '../../common/datatype.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
import { SetOperationNode } from '../nodes/set-operation-node.js';
import { buildSelectStmt } from '../building/select.js';
import { buildExpression } from '../building/expression.js';
import { FilterNode } from '../nodes/filter.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import { propagate, type BaseOp, type MutableViewLike, type MutationRequest } from './propagate.js';
import { MS_UPDATE_KEYS_CTE, type MultiSourceKeyCapture } from './multi-source.js';
import { cloneExpr, transformExpr } from './scope-transform.js';

/**
 * Set-operation membership-column write decomposition — the **first set-op view
 * writability** in the engine (docs/view-updateability.md § Set Operations).
 *
 * The read half (`set-op-membership-read`) reifies a binary set operation's branch
 * provenance as first-class `existence`-sited boolean columns and, per row, computes
 * a runtime membership probe (`inA ≡ tuple ∈ A`). This module delivers the write
 * payoff: a membership column **is** the branch presence, and *writing* it drives the
 * branch's existence:
 *
 * ```sql
 * -- U = select id, x from A union exists left as inA, exists right as inB select id, x from B
 * update U set inB = true  where id = 3   -- a row in A only ⇒ INSERT it into B
 * update U set inB = false where id = 3   -- a row in B      ⇒ DELETE the matching B row
 * ```
 *
 * **The substrate (Halloween-safe via an up-front capture).** Every affected view
 * row — its data columns AND its membership-probe flags — is captured ONCE
 * (`buildSetOpCapture`), *before* any branch op fires, into the same context-backed
 * key relation the multi-source path uses ({@link MS_UPDATE_KEYS_CTE}). The per-branch
 * ops then read that immutable capture rather than re-scanning the view (which reads
 * the very branches being written), so a branch insert/delete can never perturb the
 * affected set out from under a sibling branch op. The capture rides the existing
 * `ViewMutationNode.identityCapture` side input + the void/drain runtime path — no new
 * runtime substrate (see `runtime/emit/view-mutation.ts`).
 *
 * **A branch is itself a view body — routed per-branch via recursive `propagate`.**
 * Each operand of the set operation is a relational sub-plan (`select … from B`),
 * exactly a single-source (or, in principle, join) view body. Inserting/deleting a row
 * *into a branch* is a recursive view-mutation on that branch's sub-plan, so each
 * per-branch op is lowered to an AST `BaseOp` against a **synthetic branch view-like**
 * and run back through {@link propagate} — reusing the single-source / multi-source
 * spines verbatim (the branch's own σ predicate, renames, and base routing are honored
 * by its spine). A branch that bottoms out in a base table emits one base op; a branch
 * that is itself a `SetOperationNode` (a **subtree operand**, `nestable-flagged-set-ops`)
 * recurses *here* for the unambiguous fan-out — a data-column UPDATE, a DELETE, and a
 * `set <subtreeFlag> = false` drop fan out to every member leaf, sharing the ONE up-front
 * capture (`fanBranchDataUpdate` / `fanBranchDelete`, detected via {@link analyzeSetOpBranches}).
 * The genuinely ambiguous inserts into a subtree — `set <subtreeFlag> = true`, a
 * surfaced-inner-flag write, and insert-through routing into a subtree side — have no single
 * deterministic target leaf (product-coordinate addressing) and are rejected, pointing at
 * `set-op-membership-nested`.
 *
 * **Per-branch correlation.** A fan-out / membership-delete op identifies the branch's
 * affected rows by a correlated `exists (select 1 from __vmupd_keys k where <k matches
 * the branch row's data tuple>)` — a NULL-safe full-data-tuple match (set operations
 * treat `NULL = NULL` as equal, and the engine has no `IS NOT DISTINCT FROM`, so each
 * column is matched `k.c = b.c or (k.c is null and b.c is null)`). The branch's own
 * columns are qualified with the synthetic branch-view name so {@link propagate}'s
 * single-source correlation (the `__vm_self` self-alias) binds them to the lowered base
 * row; the `k.*` capture columns stay unqualified-to-the-branch and resolve to the
 * injected `__vmupd_keys` relation. The membership-INSERT branch instead reads the
 * captured rows **absent** from the branch via the probe flag (`where not k.<flag>`),
 * so a `set <flag> = true` is a clean no-op for rows already present (and across
 * operators — `except`'s always-false right flag inserts every visible row, `intersect`'s
 * always-true flags insert none).
 *
 * **Scope.** union / union all / except / intersect membership writes, data-column fan-out,
 * delete fan-out, and insert-through, at any nesting depth for the unambiguous fan-out
 * operations (data UPDATE / DELETE / `set <subtreeFlag> = false`). The ambiguous inserts
 * into a subtree (`set <subtreeFlag> = true`, surfaced-inner-flag writes, insert-through into
 * a subtree side) are `set-op-membership-nested` (product-coordinate addressing); non-literal
 * boolean membership writes and the `strict` unspecified-case policy stay deferred.
 */

/**
 * True iff `selectAst` is a **binary set-operation body carrying ≥1 membership flag**
 * (`<setop> exists <branch> as <name>`) — the shape this write path decomposes. An
 * AST peek (no plan built), the write-side shadow of the read half's combinator. A
 * plain (flag-less) set-op body returns `false` and keeps rejecting `unsupported-set-op`
 * through the single-source spine (there is no membership column to address a branch by).
 * `diff` is excluded (the parser already rejects membership on it).
 */
export function isSetOpMembershipBody(selectAst: AST.QueryExpr): boolean {
	return selectAst.type === 'select'
		&& !!selectAst.compound
		&& selectAst.compound.op !== 'diff'
		&& !!selectAst.compound.existence
		&& selectAst.compound.existence.length > 0;
}

/**
 * True iff a set-op membership body is reportable-writable by the static surfaces — the
 * no-plan shadow of {@link analyzeSetOpView}'s pre-write rejections: an outer LIMIT/OFFSET
 * (the body is not decomposable — a write would escape the limited window), a non-SELECT
 * right operand, a `select *` leg, or a computed (non-plain-column) leg. Lets the
 * `column_info` / `view_info` static surfaces gate the membership-writable claim on the SAME
 * shape the dynamic write enforces, instead of reporting writable from the membership flag's
 * presence alone.
 *
 * **Recursive** (`nestable-flagged-set-ops`): an operand is branch-writable iff it is a
 * plain-leg leaf OR a (recursively) branch-writable set-op body — so a nested view reports
 * `is_updatable` / `is_deletable` = YES, agreeing with the dynamic accept (data + delete
 * fan-out recurse through a subtree operand). Inserts into a subtree are deferred, so
 * insertability is gated separately on {@link setOpHasSubtreeOperand}.
 */
export function isSetOpBranchWritable(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.compound) return false;
	return isSetOpBodyWritable(selectAst);
}

/**
 * True iff a set-op body (its compound + both operands) is recursively branch-writable.
 * Mirrors the dynamic write's pre-write rejections at this level — an outer LIMIT/OFFSET
 * (a write would escape the window), then each operand checked via {@link isOperandWritable}.
 */
function isSetOpBodyWritable(selectAst: AST.SelectStmt): boolean {
	if (!selectAst.compound) return false;
	if (selectAst.limit || selectAst.offset) return false;
	return isOperandWritable(leftBranchSelect(selectAst)) && isOperandWritable(selectAst.compound.select);
}

/**
 * True iff an operand (a compound leg) is recursively branch-writable: a (recursively)
 * writable set-op body, OR a plain-column leaf (the shape that round-trips a base column
 * through the branch's single-source spine). A non-SELECT operand, a `select *` leg, or a
 * computed leg is non-writable — the dynamic write rejects all three.
 */
function isOperandWritable(operand: AST.QueryExpr): boolean {
	if (operand.type !== 'select') return false;
	if (operand.compound && operand.compound.op !== 'diff') {
		// Only a union / union all subtree operand is recursively fannable: the fan-out's
		// soundness rests on "a leaf's rows ⊆ the subtree's rows", which holds for union /
		// union all but NOT for except / intersect (a leaf can hold rows the subtree's own set
		// operation excludes). So an except / intersect subtree operand is not (yet)
		// branch-writable — the dynamic fan-out rejects it (`set-op-membership-nested`), and
		// this static probe agrees rather than over-claiming.
		if (!isUnionLikeSubtree(operand.compound.op)) return false;
		return isSetOpBodyWritable(operand);
	}
	return tryBranchColumnNames(operand) !== null;
}

/**
 * True iff a subtree operand's set operator is fannable — `union` / `unionAll`, whose result
 * is a SUPERSET of each operand (so every resident leaf row is a member). `except` /
 * `intersect` are NOT: a leaf can hold rows the subtree excludes, so a blind delete / data
 * fan-out would touch non-member rows. Their membership-gated fan-out is deferred to
 * `set-op-membership-nested-except`.
 */
function isUnionLikeSubtree(op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'): boolean {
	return op === 'union' || op === 'unionAll';
}

/**
 * True iff a membership body has a **subtree (compound) operand** — an inner
 * `SetOperationNode` operand. Insert-through into a multi-leaf subtree has no single
 * deterministic target leaf (product-coordinate addressing — `set-op-membership-nested`),
 * so the static `is_insertable_into` surface gates to `NO` when this holds, while
 * data/delete fan-out (which touches every member leaf) stays writable. The left operand is
 * never a compound in SQL (a parenthesized left compound flattens to a subquery), so only
 * the right operand is probed.
 */
export function setOpHasSubtreeOperand(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.compound) return false;
	const right = selectAst.compound.select;
	return right.type === 'select' && !!right.compound && right.compound.op !== 'diff';
}

/**
 * The **surfaced inner-branch membership-flag names** of a (possibly nested) set-op body —
 * every flag declared on a subtree operand, surfaced as a readable-but-non-writable column
 * of the outer view (the layout's `[L flags] ++ [R flags]`). Empty for a binary (non-nested)
 * body. Writing one addresses a branch *inside* a subtree operand (product-coordinate
 * addressing), so `buildUpdate` rejects it with a `set-op-membership-nested` diagnostic and
 * the `column_info` surface reports it `is_updatable = NO`.
 */
export function surfacedInnerFlagNames(selectAst: AST.QueryExpr): string[] {
	const out: string[] = [];
	if (selectAst.type === 'select' && selectAst.compound) {
		// The left operand is never a compound in SQL; only the right operand can be a subtree.
		collectSubtreeFlagNames(selectAst.compound.select, out);
	}
	return out;
}

/** Collect every membership-flag name declared on `operand` and its deeper subtree operands. */
function collectSubtreeFlagNames(operand: AST.QueryExpr, out: string[]): void {
	if (operand.type !== 'select' || !operand.compound || operand.compound.op === 'diff') return;
	for (const e of operand.compound.existence ?? []) out.push(e.name);
	collectSubtreeFlagNames(operand.compound.select, out);
}

/** One membership flag declared on the set operation. */
interface MembershipFlag {
	readonly name: string;
	readonly side: 'left' | 'right';
}

/** One branch (operand) of the binary set operation, as a recursively-writable view body. */
interface SetOpBranch {
	readonly side: 'left' | 'right';
	/** Synthetic view-like wrapping the operand's SELECT — recursed through {@link propagate}. */
	readonly view: MutableViewLike;
	/** The operand's projected data-column names (positional, aligned to the view's data columns). */
	readonly dataColNames: readonly string[];
	/** This branch's declared membership flag, when one is declared. */
	readonly flag?: MembershipFlag;
	/**
	 * True iff this operand is itself a set-operation body (a subtree) — its `selectAst`
	 * carries a (non-diff) `compound`. A nested branch's fan-out (data UPDATE / DELETE /
	 * `= false` flip) recurses through {@link analyzeSetOpBranches} to its member leaves
	 * (sharing the one up-front capture); its `= true` flip / insert-through route is
	 * rejected (a multi-leaf insert has no single deterministic target leaf —
	 * `set-op-membership-nested`).
	 */
	readonly isNested: boolean;
}

interface SetOpAnalysis {
	readonly op: 'union' | 'unionAll' | 'intersect' | 'except';
	/** The planned view body root (its attributes are the view's output columns). */
	readonly root: RelationalPlanNode;
	/** A scope resolving every view output column name against {@link root}. */
	readonly viewColScope: Scope;
	/** Every view output column name (data columns then flag columns), positional. */
	readonly viewColNames: readonly string[];
	/** Every view output column's scalar type, positional with {@link viewColNames}. */
	readonly viewColTypes: readonly ScalarType[];
	/** Count of data (non-flag) columns (recursive `SetOperationNode.dataColumnCount()`). */
	readonly dataColCount: number;
	/** The data (non-flag) column names — `viewColNames.slice(0, dataColCount)`. */
	readonly dataColNames: readonly string[];
	readonly flags: readonly MembershipFlag[];
	/**
	 * Surfaced inner-branch flag names (the view columns that are neither data nor this
	 * node's own flags — `[L flags] ++ [R flags]` of a subtree operand). Writing one is
	 * deferred to `set-op-membership-nested`; `buildUpdate` rejects it with a clean
	 * diagnostic rather than `unknown-view-column` (it IS a view column).
	 */
	readonly surfacedInnerFlagNames: readonly string[];
	readonly branches: readonly [SetOpBranch, SetOpBranch];
}

/**
 * The decomposition of a set-op membership write: the ordered per-branch base ops plus
 * the up-front capture they read. `capture` is absent for insert-through (whose values
 * are self-contained — no affected-row read), present for every probe-driven write
 * (membership flip, data fan-out, delete fan-out).
 */
export interface SetOpWritePlan {
	readonly baseOps: BaseOp[];
	readonly capture?: MultiSourceKeyCapture;
}

/** Decompose a set-op membership-column view mutation. Throws a structured diagnostic for unsupported shapes. */
export function buildSetOpWrite(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): SetOpWritePlan {
	const analysis = analyzeSetOpView(ctx, view);
	switch (req.op) {
		case 'insert': return buildInsertThrough(ctx, view, analysis, req.stmt);
		case 'update': return buildUpdate(ctx, view, analysis, req.stmt);
		case 'delete': return buildDelete(ctx, view, analysis, req.stmt);
	}
}

// --- analysis -------------------------------------------------------------

function analyzeSetOpView(ctx: PlanningContext, view: MutableViewLike): SetOpAnalysis {
	if (view.selectAst.type !== 'select' || !view.selectAst.compound) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': not a set-operation body`,
		});
	}
	const sel = view.selectAst;
	const compound = sel.compound!;
	if (compound.op === 'diff') {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': a DIFF (symmetric difference) body has no single addressable branch per row`,
		});
	}
	if (!compound.existence || compound.existence.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': a set-operation body is writable only through its membership columns; declare 'exists <branch> as <flag>' to address a branch`,
		});
	}

	// LIMIT / OFFSET on the outer compound would put the capture's filter above the
	// window — a write would escape it. Reject (parity with the join / single-source spine).
	if (sel.limit || sel.offset) {
		raiseMutationDiagnostic({
			reason: 'unsupported-limit',
			table: view.name,
			message: `cannot write through view '${view.name}': a LIMIT/OFFSET set-operation body is not decomposable (a write would escape the limited window)`,
		});
	}

	const flags: MembershipFlag[] = compound.existence.map(e => ({ name: e.name, side: e.branch }));

	// Plan the body ONCE: its root attributes are the view output columns (data columns
	// then the appended membership flags — `set-op-membership-read`'s combinator surface).
	const root = buildSelectStmt(ctx, sel);
	if (!isRelationalNode(root)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the set-operation body did not produce a relation`,
		});
	}
	const relRoot = root as RelationalPlanNode;
	const attrs = relRoot.getAttributes();
	const viewColNames = attrs.map(a => a.name);
	const viewColTypes = attrs.map(a => a.type);
	// Data-column count is the recursive DATA arity of the planned set operation
	// (`SetOperationNode.dataColumnCount()`), NOT `attrs.length - flags.length`: with a nested
	// (flagged) subtree operand, the surfaced inner flags inflate `attrs.length`, so subtracting
	// only the OWN flags would mis-count them as data columns (`nestable-flagged-set-ops`).
	const setOpNode = findSetOpNode(relRoot);
	if (!setOpNode) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the set-operation body produced no SetOperationNode`,
		});
	}
	const dataColCount = setOpNode.dataColumnCount();
	if (dataColCount <= 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the set operation exposes no data columns alongside its membership flags`,
		});
	}
	const dataColNames = viewColNames.slice(0, dataColCount);
	// Surfaced inner flags sit BETWEEN the data columns and this node's own flags in the
	// `[data] ++ [L flags] ++ [R flags] ++ [own flags]` layout — `viewColNames` minus the
	// leading data columns and the trailing own flags. Empty for a binary (non-nested) body.
	const surfacedInnerFlagNames = viewColNames.slice(dataColCount, viewColNames.length - flags.length);

	// A scope resolving each view output column name to its producing attribute over the
	// planned root — the same shape `createSetOperationScope` builds for the body itself,
	// reused here so the user predicate / capture projections resolve byte-identically.
	// Parented to `ctx.scope` so a user WHERE's parameters (`where id = ?`), CTE refs, and
	// other ambient symbols still resolve — a view output column shadows them (checked
	// first), and a base-only name still fails to resolve (the statement scope exposes no
	// base columns), so the encapsulation guard is unchanged.
	const viewColScope = new RegisteredScope(ctx.scope);
	attrs.forEach((attr, i) => {
		viewColScope.registerSymbol(attr.name.toLowerCase(), (exp, s) =>
			new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, i));
	});

	const branches: [SetOpBranch, SetOpBranch] = [
		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, flags),
		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, flags),
	];

	return { op: compound.op, root: relRoot, viewColScope, viewColNames, viewColTypes, dataColCount, dataColNames, surfacedInnerFlagNames, flags, branches };
}

/**
 * The `SetOperationNode` inside a planned body root — the root itself for a bare compound
 * body, else found by descending the relational spine (a body with an outer ORDER BY wraps
 * the set op in a `SortNode`). Its recursive `dataColumnCount()` is the data arity the
 * surfaced-inner-flag count subtraction (`attrs.length - flags.length`) over-counts.
 */
function findSetOpNode(node: RelationalPlanNode): SetOperationNode | undefined {
	if (node instanceof SetOperationNode) return node;
	for (const child of node.getRelations()) {
		const found = findSetOpNode(child);
		if (found) return found;
	}
	return undefined;
}

/**
 * Membership-free branch analysis of a nested (subtree) operand: its two inner branches,
 * built without the membership gate `analyzeSetOpView` enforces (a flag-less subtree has no
 * `compound.existence`). The data arity is the OUTER body's (`dataColCount`) — set
 * operations preserve data columns at every depth (the `SetOperationNode` constructor
 * enforces `dataArity(left) === dataArity(right)`), so an inner leaf has exactly the same
 * data columns the outer capture froze. Used by the data/delete fan-out recursion.
 */
function analyzeSetOpBranches(view: MutableViewLike, branchView: MutableViewLike, dataColCount: number): readonly [SetOpBranch, SetOpBranch] {
	const sel = branchView.selectAst as AST.SelectStmt;
	const compound = sel.compound!;
	const innerFlags: MembershipFlag[] = (compound.existence ?? []).map(e => ({ name: e.name, side: e.branch }));
	return [
		buildBranch(view, 'left', leftBranchSelect(sel), dataColCount, innerFlags),
		buildBranch(view, 'right', rightBranchSelect(view, compound.select), dataColCount, innerFlags),
	];
}

/** The left operand's SELECT — the compound statement stripped of its outer modifiers. */
function leftBranchSelect(sel: AST.SelectStmt): AST.SelectStmt {
	const { compound: _c, orderBy: _o, limit: _l, offset: _f, ...leftCore } = sel;
	return leftCore as AST.SelectStmt;
}

/** The right operand's SELECT, stripped of any leg-local ORDER BY / LIMIT / OFFSET. */
function rightBranchSelect(view: MutableViewLike, right: AST.QueryExpr): AST.SelectStmt {
	if (right.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the right branch is a ${right.type.toUpperCase()} operand, which is not a recursively-writable body (v1 supports SELECT operands)`,
		});
	}
	const { orderBy: _o, limit: _l, offset: _f, ...core } = right;
	return core as AST.SelectStmt;
}

/** Build one recursively-writable branch view-like from an operand SELECT. */
function buildBranch(
	view: MutableViewLike,
	side: 'left' | 'right',
	branchSelect: AST.SelectStmt,
	dataColCount: number,
	flags: readonly MembershipFlag[],
): SetOpBranch {
	const dataColNames = branchColumnNames(view, side, branchSelect);
	if (dataColNames.length !== dataColCount) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the ${side} branch projects ${dataColNames.length} columns but the set operation exposes ${dataColCount} data columns`,
		});
	}
	const branchView: MutableViewLike = {
		name: `__setop_${side}`,
		schemaName: view.schemaName,
		selectAst: branchSelect,
	};
	const flag = flags.find(f => f.side === side);
	// A subtree operand carries its own (non-diff) compound; its fan-out recurses to leaves.
	const isNested = !!branchSelect.compound && branchSelect.compound.op !== 'diff';
	return { side, view: branchView, dataColNames, isNested, ...(flag ? { flag } : {}) };
}

/**
 * The branch operand's projected column names (positional). v1 admits plain column
 * references (with optional rename) — the shape that round-trips a base column through
 * the branch's single-source spine. A `select *` leg or a computed projection is
 * rejected (the nested / computed-branch generality is deferred): a `*` has no static
 * name list to align positionally, and a computed leg column has no base column to
 * write a fanned-out value into.
 */
function branchColumnNames(view: MutableViewLike, side: 'left' | 'right', branchSelect: AST.SelectStmt): string[] {
	const names = tryBranchColumnNames(branchSelect);
	if (names) return names;
	// `tryBranchColumnNames` returned `null` ⇒ a `*` or computed leg; re-derive the
	// specific reason for the per-side diagnostic (the shared probe only yields the
	// boolean, so the static surface and this path cannot drift on what counts as writable).
	for (const rc of branchSelect.columns) {
		if (rc.type === 'all') {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				table: view.name,
				message: `cannot write through view '${view.name}': the ${side} branch uses 'select *'; list its columns explicitly so each maps to a writable branch column`,
			});
		}
		if (rc.expr.type !== 'column') {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				table: view.name,
				message: `cannot write through view '${view.name}': the ${side} branch projects a computed column; v1 supports plain (optionally renamed) base columns in a writable branch`,
			});
		}
	}
	// Unreachable: `tryBranchColumnNames` returns `null` only for a `*`/computed leg, both
	// handled above. Guard defensively rather than returning a wrong (empty) name list.
	raiseMutationDiagnostic({
		reason: 'unsupported-set-op',
		table: view.name,
		message: `cannot write through view '${view.name}': the ${side} branch is not a writable plain-column projection`,
	});
}

/**
 * The non-throwing core of {@link branchColumnNames}: the branch operand's projected
 * plain-column names (positional, honoring a leg rename via `rc.alias ?? rc.expr.name`),
 * or `null` when the leg is not a writable shape — a `select *` (`rc.type === 'all'`, no
 * static name list to align positionally) or a computed (`rc.expr.type !== 'column'`)
 * projection (no base column to write a fanned-out value into). Shared by the dynamic
 * write path and the static {@link isSetOpBranchWritable} probe so neither can drift on
 * what a writable leg is.
 */
function tryBranchColumnNames(branchSelect: AST.SelectStmt): string[] | null {
	const names: string[] = [];
	for (const rc of branchSelect.columns) {
		if (rc.type === 'all' || rc.expr.type !== 'column') return null;
		names.push(rc.alias ?? rc.expr.name);
	}
	return names;
}

// --- capture --------------------------------------------------------------

/**
 * Build the up-front affected-row capture: `Project_{all view cols}(Filter_{userWhere}
 * (setOpRoot))`, materialized ONCE before any branch op fires. Every probe-driven write
 * reads it back through {@link MS_UPDATE_KEYS_CTE}, so the data columns AND the
 * membership-probe flags are frozen at their pre-mutation values (Halloween-safe). The
 * capture column shape (one per view output column, by name) is what each branch op's
 * `k.<col>` reference and the membership-INSERT projection resolve against.
 */
function buildSetOpCapture(ctx: PlanningContext, analysis: SetOpAnalysis, where: AST.Expression | undefined): MultiSourceKeyCapture {
	const scope = analysis.viewColScope;
	const filtered: RelationalPlanNode = where
		? new FilterNode(scope, analysis.root, buildExpression({ ...ctx, scope }, cloneExpr(where)))
		: analysis.root;
	const projections: Projection[] = analysis.viewColNames.map(name => ({
		node: buildExpression({ ...ctx, scope }, { type: 'column', name } as AST.ColumnExpr),
		alias: name,
	}));
	const source = new ProjectNode(scope, filtered, projections, undefined, undefined, false);
	const keyColumns = analysis.viewColNames.map((name, i) => ({ name, type: analysis.viewColTypes[i] }));
	return { source, descriptor: {}, keyColumns };
}

// --- UPDATE (membership flip + data fan-out) ------------------------------

interface DataAssignment {
	/** The data column's position (index into `analysis.dataColNames`). */
	readonly position: number;
	/** The assigned value (in view / data-column terms). */
	readonly value: AST.Expression;
}

function buildUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.UpdateStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);

	const flips = new Map<'left' | 'right', boolean>();
	const dataAssignments: DataAssignment[] = [];
	for (const asg of stmt.assignments) {
		const flag = analysis.flags.find(f => f.name.toLowerCase() === asg.column.toLowerCase());
		if (flag) {
			const value = asBooleanLiteral(asg.value);
			if (value === undefined) {
				raiseMutationDiagnostic({
					reason: 'unsupported-set-op',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the membership column '${asg.column}' must be assigned a boolean literal (true/false); a per-row branch on a non-literal value is deferred`,
				});
			}
			const existing = flips.get(flag.side);
			if (existing !== undefined && existing !== value) {
				raiseMutationDiagnostic({
					reason: 'conflicting-assignment',
					column: asg.column,
					table: view.name,
					message: `cannot write through view '${view.name}': the ${flag.side} branch's membership is assigned both true and false in one statement`,
				});
			}
			flips.set(flag.side, value);
			continue;
		}
		// A surfaced inner flag (`inB`/`inC`) IS a view column, but writing it addresses a
		// branch INSIDE a subtree operand (product-coordinate addressing) — deferred to
		// `set-op-membership-nested`. Reject with a clean diagnostic (NOT `unknown-view-column`,
		// which would mislead — the name resolves).
		if (analysis.surfacedInnerFlagNames.some(n => n.toLowerCase() === asg.column.toLowerCase())) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': '${asg.column}' is a surfaced inner-branch membership flag of a nested set operation; writing it addresses a branch inside a subtree operand (product-coordinate addressing) — deferred to set-op-membership-nested`,
			});
		}
		const position = analysis.dataColNames.findIndex(n => n.toLowerCase() === asg.column.toLowerCase());
		if (position < 0) {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': '${asg.column}' is not a data or membership column of the set operation`,
				suggestion: `view '${view.name}' exposes: ${analysis.viewColNames.join(', ')}.`,
			});
		}
		dataAssignments.push({ position, value: asg.value });
	}

	// Contradiction: a `false` flip removes the row from its branch, but a data
	// assignment fans out to every member branch (including that one). The two effects on
	// the same branch contradict (write a column of a row being deleted). Reject rather
	// than silently pick one (parity with the join-existence write's `set npCol, hasB=false`).
	const anyFalseFlip = [...flips.values()].some(v => v === false);
	if (anyFalseFlip && dataAssignments.length > 0) {
		raiseMutationDiagnostic({
			reason: 'conflicting-assignment',
			table: view.name,
			message: `cannot write through view '${view.name}': a membership-flag write removes a branch (= false) while the same statement also writes a data column that fans out to that branch — the two effects contradict`,
		});
	}

	const capture = buildSetOpCapture(ctx, analysis, stmt.where);
	const baseOps: BaseOp[] = [];

	// Data fan-out: update the row in every member leaf, recursing through a subtree operand
	// to its leaves. The full-data-tuple `exists` correlation restricts each leaf update to
	// the rows actually present there (a non-member leaf matches no row), so the per-branch
	// membership is honored without an explicit flag gate.
	if (dataAssignments.length > 0) {
		for (const branch of analysis.branches) {
			baseOps.push(...fanBranchDataUpdate(ctx, view, analysis, branch, dataAssignments, stmt));
		}
	}

	// Membership flips. `= true` inserts into the branch (rejected for a subtree — a
	// multi-leaf insert has no single target leaf); `= false` is a delete fan-out (recurses
	// through a subtree to drop the row from its resident leaves).
	for (const branch of analysis.branches) {
		const flip = flips.get(branch.side);
		if (flip === undefined) continue;
		if (flip) {
			baseOps.push(...buildBranchMembershipInsert(ctx, view, analysis, branch, dataAssignments, stmt));
		} else {
			baseOps.push(...fanBranchDelete(ctx, view, analysis, branch, stmt));
		}
	}

	if (baseOps.length === 0) {
		// Unreachable: the parser requires ≥1 assignment, and every assignment routes to a
		// flip or a data fan-out above. Guard defensively.
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the update names no writable set-operation column`,
		});
	}
	return { baseOps, capture };
}

/**
 * Reject a delete / data fan-out into an `except` / `intersect` subtree operand. The
 * recursion shares the ONE up-front capture and touches each resident leaf row whose data
 * tuple ∈ `__vmupd_keys` — sound only when "a leaf's rows ⊆ the subtree's rows" (union /
 * union all). For `except` / `intersect` a leaf can hold rows the subtree's own set operation
 * EXCLUDES (e.g. a row in both B and C is absent from `B except C`); if an OUTER operand makes
 * that row visible, it enters the capture, and a blind fan-out would delete / mutate it in the
 * inner leaves even though its `inSub` membership probe reads FALSE — silently corrupting base
 * rows the view never exposed as subtree members. Defer it cleanly until the membership-gated
 * fan-out (`set-op-membership-nested-except`) lands; union / union all subtree fan-out is sound
 * and stays supported.
 */
function rejectNonUnionSubtreeFanout(view: MutableViewLike, branch: SetOpBranch): void {
	const op = (branch.view.selectAst as AST.SelectStmt).compound?.op;
	if (op === 'except' || op === 'intersect') {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': a delete / data fan-out through an ${op.toUpperCase()} subtree operand is deferred — a leaf can hold rows the subtree excludes, so a blind fan-out would touch rows that are not members of the subtree (membership-gated nested fan-out is set-op-membership-nested-except)`,
		});
	}
}

/**
 * Fan a data-column UPDATE out to one branch — recursing through a nested (subtree) operand
 * to its member leaves, else updating the leaf's member rows (matched via the shared capture).
 *
 * The recursion reuses the SINGLE up-front capture: a subtree's leaves share the outer's data
 * columns (nesting preserves them), so "update the leaf rows whose data tuple ∈ `__vmupd_keys`"
 * is the same frozen-capture correlation rebuilt against each inner branch — no second capture.
 * The positional `dataAssignments` fan unchanged (each re-mapped to the leaf's own column name
 * at that data position via `branch.dataColNames[da.position]`); the value is cloned fresh at
 * each leaf (its refs resolve against that leaf's columns when leg names match — the v1 caveat).
 */
function fanBranchDataUpdate(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	dataAssignments: readonly DataAssignment[],
	stmt: AST.UpdateStmt,
): BaseOp[] {
	if (branch.isNested) {
		rejectNonUnionSubtreeFanout(view, branch);
		const baseOps: BaseOp[] = [];
		for (const inner of analyzeSetOpBranches(view, branch.view, analysis.dataColCount)) {
			baseOps.push(...fanBranchDataUpdate(ctx, view, analysis, inner, dataAssignments, stmt));
		}
		return baseOps;
	}
	const assignments: { column: string; value: AST.Expression }[] = dataAssignments.map(da => ({
		column: branch.dataColNames[da.position],
		value: cloneExpr(da.value),
	}));
	const updateStmt: AST.UpdateStmt = {
		type: 'update',
		table: { type: 'identifier', name: branch.view.name },
		assignments,
		where: buildMemberExists(analysis, branch),
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return propagate(ctx, branch.view, { op: 'update', stmt: updateStmt });
}

/**
 * `set <flag> = true`: insert the captured rows that are **absent** from this branch
 * (`where not k.<flag>`) into it. Composed same-statement data assignments flow into the
 * inserted projection (the new value); every other data column reads the captured row.
 */
function buildBranchMembershipInsert(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	dataAssignments: readonly DataAssignment[],
	stmt: AST.UpdateStmt,
): BaseOp[] {
	if (branch.isNested) {
		// `set <subtreeFlag> = true` would insert the row into a multi-leaf subtree (B∪C) —
		// "which leaf?" has no single deterministic answer (product-coordinate addressing).
		// Deferred to `set-op-membership-nested`. (The `= false` flip routes to the delete
		// fan-out, which IS unambiguous — it touches every member leaf.)
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			column: branch.flag?.name,
			table: view.name,
			message: `cannot write through view '${view.name}': 'set ${branch.flag?.name ?? '<flag>'} = true' inserts into a multi-leaf subtree operand, which has no single deterministic target leaf (product-coordinate addressing) — deferred to set-op-membership-nested`,
		});
	}
	if (!branch.flag) {
		// Unreachable on the flip path (a flip targets a declared flag's side), but guard.
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the ${branch.side} branch has no membership flag to insert through`,
		});
	}
	const assignedByPosition = new Map<number, AST.Expression>();
	for (const da of dataAssignments) assignedByPosition.set(da.position, da.value);

	const projections: AST.ResultColumn[] = analysis.dataColNames.map((uName, i): AST.ResultColumn => {
		const assigned = assignedByPosition.get(i);
		const expr = assigned !== undefined
			? qualifyDataRefsWithCapture(view, analysis, assigned)
			: ({ type: 'column', name: uName, table: 'k' } as AST.ColumnExpr);
		return { type: 'column', expr, alias: branch.dataColNames[i] };
	});
	const source: AST.SelectStmt = {
		type: 'select',
		columns: projections,
		from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
		// Only the captured rows NOT already in this branch — the probe makes a redundant
		// `= true` a clean no-op (and folds the per-operator semantics: `except`'s right
		// flag is always false ⇒ insert all, `intersect`'s flags are always true ⇒ none).
		where: { type: 'unary', operator: 'NOT', expr: { type: 'column', name: branch.flag.name, table: 'k' } } as AST.UnaryExpr,
	};
	const insertStmt: AST.InsertStmt = {
		type: 'insert',
		table: { type: 'identifier', name: branch.view.name },
		columns: [...branch.dataColNames],
		source,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return propagate(ctx, branch.view, { op: 'insert', stmt: insertStmt });
}

/**
 * Fan a DELETE out to one branch — recursing through a nested (subtree) operand to its member
 * leaves, else deleting the leaf's matching rows (every captured row present there). Serves
 * both the `delete from V` fan-out and the `set <subtreeFlag> = false` subtree drop (a
 * delete fan-out into the subtree's leaves), so it takes either originating statement and
 * reads only its shared `contextValues` / `schemaPath` / `loc`. Reuses the SINGLE up-front
 * capture (the same frozen-data-tuple correlation, rebuilt against each inner branch).
 */
function fanBranchDelete(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	stmt: AST.UpdateStmt | AST.DeleteStmt,
): BaseOp[] {
	if (branch.isNested) {
		rejectNonUnionSubtreeFanout(view, branch);
		const baseOps: BaseOp[] = [];
		for (const inner of analyzeSetOpBranches(view, branch.view, analysis.dataColCount)) {
			baseOps.push(...fanBranchDelete(ctx, view, analysis, inner, stmt));
		}
		return baseOps;
	}
	const deleteStmt: AST.DeleteStmt = {
		type: 'delete',
		table: { type: 'identifier', name: branch.view.name },
		where: buildMemberExists(analysis, branch),
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return propagate(ctx, branch.view, { op: 'delete', stmt: deleteStmt });
}

// --- DELETE (fan-out via the probe) ---------------------------------------

function buildDelete(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.DeleteStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	const capture = buildSetOpCapture(ctx, analysis, stmt.where);
	const baseOps: BaseOp[] = [];
	// Delete from every member leaf at every depth — the fan recurses through a subtree
	// operand to its leaves (the full-tuple `exists` correlation restricts each leaf delete to
	// its resident rows, so a non-member leaf matches none).
	for (const branch of analysis.branches) {
		baseOps.push(...fanBranchDelete(ctx, view, analysis, branch, stmt));
	}
	return { baseOps, capture };
}

// --- INSERT (insert-through, flag-routed) ---------------------------------

function buildInsertThrough(ctx: PlanningContext, view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.InsertStmt): SetOpWritePlan {
	rejectReturning(view, stmt.returning);
	if (stmt.source.type !== 'values') {
		raiseMutationDiagnostic({
			reason: 'unsupported-source',
			table: view.name,
			message: `cannot insert through view '${view.name}': a set-operation insert routes by literal membership flags, so it requires a VALUES source (a SELECT/DML source's per-row routing is deferred)`,
		});
	}

	// Resolve each VALUES position to a data column or a membership flag. An explicit
	// column list maps by name; an omitted list maps positionally over the view's output
	// layout (data columns then flags).
	const layout = resolveInsertLayout(view, analysis, stmt);

	// The flags route the insert: a true flag activates its branch, a false flag omits it.
	// The flag value must be a uniform boolean literal across the inserted rows (a per-row
	// mix is deferred), mirroring the join-existence insert directive.
	const activeSides = new Set<'left' | 'right'>();
	for (const flag of analysis.flags) {
		const pos = layout.flagPositions.get(flag.name.toLowerCase());
		if (pos === undefined) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: flag.name,
				table: view.name,
				message: `cannot insert through view '${view.name}': the membership flag '${flag.name}' must be supplied to route the insert to its branch (a flag-less multi-branch insert is ambiguous)`,
			});
		}
		if (uniformBooleanFlag(view, stmt.source.values, pos, flag.name)) activeSides.add(flag.side);
	}
	if (activeSides.size === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot insert through view '${view.name}': no membership flag is true, so the inserted row would belong to no branch (set at least one 'exists' flag true)`,
		});
	}

	const baseOps: BaseOp[] = [];
	for (const branch of analysis.branches) {
		if (!activeSides.has(branch.side)) continue;
		if (branch.isNested) {
			// Routing a VALUES row into a multi-leaf subtree operand has no single deterministic
			// target leaf (product-coordinate addressing) — deferred to `set-op-membership-nested`.
			// A leaf-only active side still inserts normally.
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				table: view.name,
				message: `cannot insert through view '${view.name}': the active routing flag targets a multi-leaf subtree operand, which has no single deterministic target leaf for a VALUES row (product-coordinate addressing) — deferred to set-op-membership-nested`,
			});
		}
		const values = stmt.source.values.map(row => layout.dataPositions.map(p => cloneExpr(row[p])));
		const source: AST.SelectStmt | AST.ValuesStmt = { type: 'values', values };
		const insertStmt: AST.InsertStmt = {
			type: 'insert',
			table: { type: 'identifier', name: branch.view.name },
			columns: [...branch.dataColNames],
			source,
			onConflict: stmt.onConflict,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		baseOps.push(...propagate(ctx, branch.view, { op: 'insert', stmt: insertStmt }));
	}
	// Insert-through reads no existing row, so it needs no capture (self-contained values).
	return { baseOps };
}

interface InsertLayout {
	/** VALUES positions of the data columns, in data-column order. */
	readonly dataPositions: number[];
	/** Membership flag name (lowercase) → its VALUES position. */
	readonly flagPositions: Map<string, number>;
}

/** Map the insert's column list (explicit or positional) onto data columns + membership flags. */
function resolveInsertLayout(view: MutableViewLike, analysis: SetOpAnalysis, stmt: AST.InsertStmt): InsertLayout {
	const flagNames = new Set(analysis.flags.map(f => f.name.toLowerCase()));
	const dataNames = new Set(analysis.dataColNames.map(n => n.toLowerCase()));

	const cols = stmt.columns && stmt.columns.length > 0 ? stmt.columns : analysis.viewColNames;
	const dataByName = new Map<string, number>(); // data col name → VALUES position
	const flagPositions = new Map<string, number>();
	cols.forEach((rawName, pos) => {
		const name = rawName.toLowerCase();
		if (flagNames.has(name)) {
			flagPositions.set(name, pos);
		} else if (dataNames.has(name)) {
			dataByName.set(name, pos);
		} else {
			raiseMutationDiagnostic({
				reason: 'unknown-view-column',
				column: rawName,
				table: view.name,
				message: `cannot insert through view '${view.name}': '${rawName}' is not a data or membership column of the set operation`,
				suggestion: `view '${view.name}' exposes: ${analysis.viewColNames.join(', ')}.`,
			});
		}
	});

	// Data columns must be supplied in full (the branches need every data column to build
	// a row); a missing one is left to the branch's own NOT NULL / default handling only
	// when truly omittable — v1 requires the data columns be supplied for an insert-through.
	const dataPositions = analysis.dataColNames.map(name => {
		const pos = dataByName.get(name.toLowerCase());
		if (pos === undefined) {
			raiseMutationDiagnostic({
				reason: 'no-default',
				column: name,
				table: view.name,
				message: `cannot insert through view '${view.name}': data column '${name}' is not supplied; a set-operation insert-through requires every data column`,
			});
		}
		return pos;
	});
	return { dataPositions, flagPositions };
}

// --- helpers --------------------------------------------------------------

/**
 * The correlated `exists (select 1 from __vmupd_keys k where <k matches the branch row>)`
 * a fan-out / membership-delete routes on. The match is a NULL-safe full-data-tuple
 * comparison: each data column is `k.c = b.c or (k.c is null and b.c is null)` (set
 * operations treat `NULL = NULL` as equal; the engine has no `IS NOT DISTINCT FROM`).
 * The branch columns are qualified with the synthetic branch-view name so {@link propagate}
 * lowers them to the target row (`__vm_self`); the `k.*` columns resolve to the injected
 * `__vmupd_keys` relation.
 *
 * In the nested fan-out the OUTER `analysis` is threaded unchanged, so `k.*` keeps naming the
 * one outer capture's data columns while `branch.*` names the inner leaf's — sound because a
 * subtree preserves the data columns at every depth (`buildBranch`'s arity check guarantees
 * `branch.dataColNames.length === analysis.dataColCount`), and a leaf's rows ⊆ the subtree's,
 * so the same frozen capture selects exactly the leaf rows to touch.
 */
function buildMemberExists(analysis: SetOpAnalysis, branch: SetOpBranch): AST.Expression {
	let pred: AST.Expression | undefined;
	for (let i = 0; i < analysis.dataColCount; i++) {
		const colMatch = nullSafeEqual(
			{ type: 'column', name: analysis.dataColNames[i], table: 'k' },
			{ type: 'column', name: branch.dataColNames[i], table: branch.view.name },
		);
		pred = pred ? { type: 'binary', operator: 'AND', left: pred, right: colMatch } : colMatch;
	}
	return {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
			where: pred,
		},
	} as AST.ExistsExpr;
}

/** `a = b or (a is null and b is null)` — null-safe equality built from primitives. */
function nullSafeEqual(a: AST.ColumnExpr, b: AST.ColumnExpr): AST.Expression {
	const eq: AST.Expression = { type: 'binary', operator: '=', left: { ...a }, right: { ...b } };
	const bothNull: AST.Expression = {
		type: 'binary',
		operator: 'AND',
		left: { type: 'unary', operator: 'IS NULL', expr: { ...a } } as AST.UnaryExpr,
		right: { type: 'unary', operator: 'IS NULL', expr: { ...b } } as AST.UnaryExpr,
	};
	return { type: 'binary', operator: 'OR', left: eq, right: bothNull };
}

/**
 * Rewrite a composed data-assignment value (in view / data-column terms) so its column
 * references read the captured row (`k.<col>`) — the membership-INSERT projection runs
 * over `__vmupd_keys`, not the branch. A reference to a membership flag, or to a name
 * that is neither a data column, is rejected (a data value cannot read a routing flag).
 */
function qualifyDataRefsWithCapture(view: MutableViewLike, analysis: SetOpAnalysis, value: AST.Expression): AST.Expression {
	const dataNames = new Set(analysis.dataColNames.map(n => n.toLowerCase()));
	return transformExpr(value, (col) => {
		if (col.table) return undefined; // already qualified (e.g. a correlated outer ref) — leave it
		if (dataNames.has(col.name.toLowerCase())) return { type: 'column', name: col.name, table: 'k' };
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			column: col.name,
			table: view.name,
			message: `cannot write through view '${view.name}': the membership-insert value references '${col.name}', which is not a data column; a data value cannot read a membership flag`,
		});
	});
}

/**
 * The uniform boolean directive a membership flag supplies on an insert-through — `true`
 * activates its branch, `false` omits it. Must be the SAME boolean literal across every
 * inserted row (a per-row branch on the value is deferred — `set-op-membership-nested`).
 */
function uniformBooleanFlag(view: MutableViewLike, rows: readonly AST.Expression[][], position: number, flagName: string): boolean {
	let flag: boolean | undefined;
	for (const row of rows) {
		const cell = row[position];
		const b = cell ? asBooleanLiteral(cell) : undefined;
		if (b === undefined) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: flagName,
				table: view.name,
				message: `cannot insert through view '${view.name}': the membership flag '${flagName}' must be a boolean literal (true/false); a non-literal per-row directive is deferred`,
			});
		}
		if (flag === undefined) flag = b;
		else if (flag !== b) {
			raiseMutationDiagnostic({
				reason: 'unsupported-set-op',
				column: flagName,
				table: view.name,
				message: `cannot insert through view '${view.name}': the membership flag '${flagName}' must be uniform across the inserted rows (a per-row mix of true/false is deferred)`,
			});
		}
	}
	return flag ?? false;
}

/**
 * The boolean value of a literal membership assignment (`true`/`false`, or the numeric
 * `1`/`0` spellings), or `undefined` for any non-literal / non-boolean value (a per-row
 * branch on the written value is deferred). Mirrors the join-existence write's gate.
 */
function asBooleanLiteral(expr: AST.Expression): boolean | undefined {
	if (expr.type !== 'literal') return undefined;
	const v = expr.value;
	if (v === true || v === false) return v;
	if (v === 1 || v === 1n) return true;
	if (v === 0 || v === 0n) return false;
	return undefined;
}

/** RETURNING through a set-op membership write is not yet recoverable — reject. */
function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `cannot write through view '${view.name}': RETURNING is not yet supported on a set-operation membership write (the per-branch fan-out yields no single recoverable view row)`,
		});
	}
}
