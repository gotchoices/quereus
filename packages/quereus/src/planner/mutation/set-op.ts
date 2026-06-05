import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { ScalarType } from '../../common/datatype.js';
import { isRelationalNode, type RelationalPlanNode } from '../nodes/plan-node.js';
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
 * that is itself a `SetOperationNode` would recurse again (the **nested** subtree write —
 * its per-leaf product-coordinate addressing is `set-op-membership-nested`).
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
 * **v1 scope (binary, non-nested).** union / union all / except / intersect membership
 * writes, data-column fan-out, delete fan-out, and insert-through. Nested/subtree flags
 * and product-coordinate addressing are `set-op-membership-nested`; non-literal boolean
 * membership writes and the `strict` unspecified-case policy stay deferred.
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
	/** Count of data (non-flag) columns. */
	readonly dataColCount: number;
	/** The data (non-flag) column names — `viewColNames.slice(0, dataColCount)`. */
	readonly dataColNames: readonly string[];
	readonly flags: readonly MembershipFlag[];
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
	const dataColCount = attrs.length - flags.length;
	if (dataColCount <= 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-set-op',
			table: view.name,
			message: `cannot write through view '${view.name}': the set operation exposes no data columns alongside its membership flags`,
		});
	}
	const dataColNames = viewColNames.slice(0, dataColCount);

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

	return { op: compound.op, root: relRoot, viewColScope, viewColNames, viewColTypes, dataColCount, dataColNames, flags, branches };
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
	return { side, view: branchView, dataColNames, ...(flag ? { flag } : {}) };
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
	const names: string[] = [];
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

	// Data fan-out: update the row in every branch it is currently a member of. The
	// full-data-tuple `exists` correlation restricts each branch update to the rows
	// actually present in that branch (a non-member branch matches no row), so the
	// per-branch membership is honored without an explicit flag gate.
	if (dataAssignments.length > 0) {
		for (const branch of analysis.branches) {
			baseOps.push(...buildBranchDataUpdate(ctx, view, analysis, branch, dataAssignments, stmt));
		}
	}

	// Membership flips.
	for (const branch of analysis.branches) {
		const flip = flips.get(branch.side);
		if (flip === undefined) continue;
		if (flip) {
			baseOps.push(...buildBranchMembershipInsert(ctx, view, analysis, branch, dataAssignments, stmt));
		} else {
			baseOps.push(...buildBranchMembershipDelete(ctx, view, analysis, branch, stmt));
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

/** Fan a data-column UPDATE out to one branch: update its member rows (matched via the capture). */
function buildBranchDataUpdate(
	ctx: PlanningContext,
	_view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	dataAssignments: readonly DataAssignment[],
	stmt: AST.UpdateStmt,
): BaseOp[] {
	const assignments: { column: string; value: AST.Expression }[] = dataAssignments.map(da => ({
		// The branch's own column name at this data position (honors a leg rename); the
		// value is in data-column terms — its refs resolve against the branch's columns
		// when the leg column names match (the v1 caveat for column-referencing values).
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

/** `set <flag> = false`: delete the matching branch row for every captured row present in this branch. */
function buildBranchMembershipDelete(
	ctx: PlanningContext,
	_view: MutableViewLike,
	analysis: SetOpAnalysis,
	branch: SetOpBranch,
	stmt: AST.UpdateStmt,
): BaseOp[] {
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
	// Delete from every branch the row is a member of (the full-tuple `exists` correlation
	// restricts each branch delete to its resident rows — a non-member branch matches none).
	for (const branch of analysis.branches) {
		const deleteStmt: AST.DeleteStmt = {
			type: 'delete',
			table: { type: 'identifier', name: branch.view.name },
			where: buildMemberExists(analysis, branch),
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		baseOps.push(...propagate(ctx, branch.view, { op: 'delete', stmt: deleteStmt }));
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
