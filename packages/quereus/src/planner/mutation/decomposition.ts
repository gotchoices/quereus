import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableReferenceNode } from '../nodes/reference.js';
import { buildTableReference } from '../building/table.js';
import type { StorageShape, DecompositionMember } from '../../vtab/mapping-advertisement.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { transformExpr, cloneExpr } from './single-source.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';

/**
 * Advertisement-driven **put** fan-out for a logical table backed by an n-way
 * decomposition (columnar split / column-family / EAV), the write dual of the
 * `get` join `schema/lens-compiler.ts` synthesizes (`compileDecompositionBody`).
 * See `docs/lens.md` § The Default Mapper and `docs/view-updateability.md`
 * § Decomposition put fan-out.
 *
 * A decomposition lens is registered as an ordinary view whose `selectAst` is the
 * synthesized `anchor ⋈ members` join, so writing it would otherwise route to the
 * generic two-table-inner-join `multi-source.ts` path — which has the **wrong**
 * semantics for a decomposition (it picks a single delete side, rejects > 2
 * members, and rejects the outer joins optional members ride). `propagate()`
 * intercepts a decomposition body (the slot carries a `primary-storage`
 * advertisement and no override) and routes it here instead.
 *
 * **Scope shipped here (the substrate-independent, sound cases):**
 *
 * - **DELETE** fans out to *every* member (mandatory, optional, and EAV pivot) so
 *   the logical row ceases to exist across the whole decomposition. Members are
 *   ordered **anchor-last**; each non-anchor member's identifying set is read from
 *   the **anchor alone** (never the full join), so an earlier member's delete can
 *   never shrink a later member's identifying set. This is what keeps the fan-out
 *   sound without the snapshot-consistent multi-member execution substrate.
 * - **UPDATE** routes each assignment to the single **mandatory, non-EAV** member
 *   that backs it, keyed off the anchor the same anchor-last way.
 *
 * **Deferred (raised here with a precise diagnostic), because each rides a
 * substrate that is not yet present:**
 *
 * - **INSERT** — needs the per-row/per-statement shared-surrogate mutation-context
 *   envelope (evaluate-once-and-thread) built by `view-mutation-shared-surrogate-insert`.
 * - A DELETE/UPDATE **WHERE that references a non-anchor member** — needs the
 *   snapshot-consistent multi-member base-op execution the predicate-honest
 *   multi-side fan-out is deferred onto (see `multi-source.ts` § delete + the
 *   `view-mutation-lenient-multiside-delete-fanout` backlog ticket).
 * - **UPDATE of an optional-member / EAV / shared-key column** — an optional or
 *   EAV write is an insert-or-delete of a component row, which needs the insert
 *   path above; a key write is an identity change.
 * - **composite shared keys** — v1 threads a single-column key (mirrors the
 *   single-column-PK boundary in `multi-source.ts`).
 */

/** Resolved view of one decomposition for the put fan-out. */
interface DecompShape {
	readonly storage: StorageShape;
	readonly anchor: DecompositionMember;
	/** logical-column-name (lowercased) → its backing expression in the get body. */
	readonly viewColToBaseRef: ReadonlyMap<string, AST.Expression>;
}

/**
 * Decompose a mutation through a decomposition-backed logical table into an
 * ordered `BaseOp[]`. Throws a structured diagnostic for any deferred shape.
 */
export function propagateDecomposition(
	ctx: PlanningContext,
	view: MutableViewLike,
	storage: StorageShape,
	req: MutationRequest,
): BaseOp[] {
	const anchor = storage.members.find(m => m.relationId === storage.anchorRelationId);
	if (!anchor) {
		// Validated at advertisement resolution; defensive.
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through logical table '${view.name}': decomposition anchor '${storage.anchorRelationId}' is not among its members`,
		});
	}
	const shape: DecompShape = { storage, anchor, viewColToBaseRef: buildViewColMap(view) };

	switch (req.op) {
		case 'delete': return decomposeDelete(ctx, view, shape, req.stmt);
		case 'update': return decomposeUpdate(ctx, view, shape, req.stmt);
		case 'insert':
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-insert',
				table: view.name,
				message: `cannot insert into logical table '${view.name}': insert across a decomposition needs the shared-surrogate mutation-context envelope (evaluate-once-per-row-and-thread), which the 'view-mutation-shared-surrogate-insert' substrate ships; only DELETE/UPDATE fan-out is available so far`,
			});
	}
}

// --- DELETE ---------------------------------------------------------------

/**
 * Fan a logical delete out to every member. Order anchor-last; each non-anchor
 * member's identifying set is `select <anchorKey> from <anchor> where <pred>`, so
 * deleting other members never changes it. The anchor's own delete then applies
 * the predicate directly against the anchor (its IN subquery would self-reference
 * the rows it removes, so the bare-predicate form is both simpler and clearer).
 */
function decomposeDelete(ctx: PlanningContext, view: MutableViewLike, shape: DecompShape, stmt: AST.DeleteStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);
	const pred = anchorPredicate(view, shape, stmt.where);

	const ops: BaseOp[] = [];
	// Non-anchor members first (each reads the still-intact anchor), anchor last.
	for (const member of shape.storage.members) {
		if (member.relationId === shape.anchor.relationId) continue;
		ops.push(memberDeleteOp(ctx, view, shape, member, pred, stmt));
	}
	ops.push(anchorDeleteOp(ctx, view, shape, pred, stmt));
	return ops;
}

/**
 * One member's delete. No predicate ⇒ an unconditional `delete from <member>`
 * (truncate the component — also the sound singleton path, which has no key to
 * thread). With an anchor predicate ⇒ `delete from <member> where
 * <memberKeyOrEntity> in (select <anchorKey> from <anchor> where <pred>)`.
 */
function memberDeleteOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	pred: AST.Expression | undefined,
	stmt: AST.DeleteStmt,
): BaseOp {
	let where: AST.Expression | undefined;
	if (pred) {
		const memberCol = member.attributePivot
			? member.attributePivot.entityColumn // EAV: delete every triple for the matched entities
			: singleKeyColumn(view, shape, member);
		where = { type: 'in', expr: { type: 'column', name: memberCol }, subquery: anchorKeySubquery(shape, pred) };
	}
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: memberIdentifier(member),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, member), op: 'delete', statement };
}

/** `delete from <anchor> [where <pred bare>]`. */
function anchorDeleteOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	pred: AST.Expression | undefined,
	stmt: AST.DeleteStmt,
): BaseOp {
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: memberIdentifier(shape.anchor),
		where: pred ? stripAnchorQualifier(pred, shape) : undefined,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, shape.anchor), op: 'delete', statement };
}

// --- UPDATE ---------------------------------------------------------------

/**
 * Route each assignment to the mandatory, non-EAV member that backs it and emit
 * one per-member UPDATE, anchor-last (so a member whose column the predicate reads
 * is not mutated before a sibling's identifying set is computed). Optional / EAV /
 * key / computed targets and cross-member value references are deferred or rejected.
 */
function decomposeUpdate(ctx: PlanningContext, view: MutableViewLike, shape: DecompShape, stmt: AST.UpdateStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);
	const pred = anchorPredicate(view, shape, stmt.where);

	// member relationId → its routed (basisColumn, value) assignments.
	const perMember = new Map<string, Array<{ column: string; value: AST.Expression }>>();
	for (const asg of stmt.assignments) {
		const routed = routeAssignment(view, shape, asg);
		let list = perMember.get(routed.relationId);
		if (!list) { list = []; perMember.set(routed.relationId, list); }
		list.push({ column: routed.basisColumn, value: routed.value });
	}

	const ops: BaseOp[] = [];
	const emit = (member: DecompositionMember): void => {
		const assignments = perMember.get(member.relationId);
		if (!assignments || assignments.length === 0) return;
		ops.push(memberUpdateOp(ctx, view, shape, member, assignments, pred, stmt));
	};
	for (const member of shape.storage.members) {
		if (member.relationId === shape.anchor.relationId) continue;
		emit(member);
	}
	emit(shape.anchor); // anchor last
	return ops;
}

interface RoutedAssignment {
	readonly relationId: string;
	readonly basisColumn: string;
	readonly value: AST.Expression;
}

/** Resolve one `set <col> = <value>` to its backing member + basis column. */
function routeAssignment(view: MutableViewLike, shape: DecompShape, asg: AST.UpdateStmt['assignments'][number]): RoutedAssignment {
	const logical = asg.column.toLowerCase();
	if (isSharedKeyColumn(shape, logical)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-update',
			column: asg.column,
			table: view.name,
			message: `cannot update logical table '${view.name}': column '${asg.column}' is part of the decomposition shared key; an identity change is not a value write`,
		});
	}
	for (const member of shape.storage.members) {
		const mapping = member.columns.find(c => c.logicalColumn.toLowerCase() === logical);
		if (!mapping) continue;
		if (member.presence !== 'mandatory' || member.attributePivot) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-update',
				column: asg.column,
				table: view.name,
				message: `cannot update logical table '${view.name}': column '${asg.column}' is backed by ${member.attributePivot ? 'an EAV pivot' : 'an optional'} member ('${member.relationId}'); materializing/removing that component row needs the insert/delete fan-out (deferred)`,
			});
		}
		if (mapping.basisExpr.type !== 'column') {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot update logical table '${view.name}': column '${asg.column}' is a computed (non-invertible) decomposition mapping and is read-only`,
			});
		}
		return { relationId: member.relationId, basisColumn: mapping.basisExpr.name, value: rewriteAssignedValue(view, shape, member, asg.value) };
	}
	// An EAV pivot member backs its logical columns as attribute *rows*, not via
	// `member.columns` (the get body projects them as correlated scalar subqueries,
	// not join columns), so the loop above never matches them. Detect that here off
	// the projection map: a logical column the get body projects as a non-column
	// expression is EAV-served (writing it is an insert-or-delete of a triple — the
	// deferred component fan-out), whereas a column the body never projects is a
	// name that is simply not part of the decomposition.
	const projected = shape.viewColToBaseRef.get(logical);
	if (projected && projected.type !== 'column') {
		const eav = shape.storage.members.find(m => m.attributePivot);
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-update',
			column: asg.column,
			table: view.name,
			message: `cannot update logical table '${view.name}': column '${asg.column}' is backed by ${eav ? `an EAV pivot member ('${eav.relationId}')` : 'a computed projection'}; materializing/removing that component needs the insert/delete fan-out (deferred)`,
		});
	}
	raiseMutationDiagnostic({
		reason: 'no-inverse',
		column: asg.column,
		table: view.name,
		message: `cannot update logical table '${view.name}': column '${asg.column}' is not backed by any decomposition member`,
	});
}

/** `update <member> set <cols> where <memberKey> in (select <anchorKey> from <anchor> where <pred>)`. */
function memberUpdateOp(
	ctx: PlanningContext,
	view: MutableViewLike,
	shape: DecompShape,
	member: DecompositionMember,
	assignments: ReadonlyArray<{ column: string; value: AST.Expression }>,
	pred: AST.Expression | undefined,
	stmt: AST.UpdateStmt,
): BaseOp {
	const memberKey = singleKeyColumn(view, shape, member);
	const where: AST.InExpr = {
		type: 'in',
		expr: { type: 'column', name: memberKey },
		subquery: anchorKeySubquery(shape, pred),
	};
	const statement: AST.UpdateStmt = {
		type: 'update',
		table: memberIdentifier(member),
		assignments: assignments.map(a => ({ column: a.column, value: a.value })),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return { table: resolveMemberTable(ctx, member), op: 'update', statement };
}

/**
 * Rewrite an assigned value from logical terms into the owning member's base
 * terms, then strip the member's own alias qualifier (the per-member UPDATE
 * targets that table directly). A reference to a *different* member is a
 * cross-source assignment a single-table SET cannot express — rejected.
 */
function rewriteAssignedValue(view: MutableViewLike, shape: DecompShape, owner: DecompositionMember, value: AST.Expression): AST.Expression {
	const base = substituteViewColumns(value, shape, view);
	return transformExpr(base, (col) => {
		if (!col.table) return undefined;
		if (col.table === owner.relationId) return { type: 'column', name: col.name };
		raiseMutationDiagnostic({
			reason: 'cross-source-assignment',
			column: col.name,
			table: view.name,
			message: `cannot update logical table '${view.name}': an update value references column '${col.name}' on decomposition member '${col.table}', a different member than the column it assigns; cross-member assignment is not supported`,
		});
	});
}

// --- predicate / subquery construction ------------------------------------

/**
 * The user WHERE rewritten from logical columns into the get body's base terms,
 * validated to reference **only the anchor** (so each member's identifying set
 * can be read from the anchor alone — see the file header). A predicate touching
 * a non-anchor member is deferred onto the snapshot-consistent substrate.
 */
function anchorPredicate(view: MutableViewLike, shape: DecompShape, where: AST.Expression | undefined): AST.Expression | undefined {
	if (!where) return undefined;
	const base = substituteViewColumns(where, shape, view);
	const refs = collectColumnQualifiers(base);
	if (refs.hasSubquery || [...refs.tables].some(t => t !== shape.anchor.relationId)) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-predicate',
			table: view.name,
			message: `cannot write through logical table '${view.name}': the WHERE references a non-anchor decomposition member; a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution (deferred — filter only on the anchor / shared key, or pin the rows via the anchor)`,
		});
	}
	return base;
}

/** `select <anchorKey> from <anchorTable> <anchorAlias> [where <pred>]` — the shared identifying set. */
function anchorKeySubquery(shape: DecompShape, pred: AST.Expression | undefined): AST.SelectStmt {
	const anchorKey = singleKeyColumn(undefined, shape, shape.anchor);
	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: anchorKey, table: shape.anchor.relationId } }],
		from: [{ ...memberIdentifierSource(shape.anchor), alias: shape.anchor.relationId }],
		where: pred ? cloneExpr(pred) : undefined,
	};
}

/**
 * Substitute references to logical columns (unqualified, or qualified by the
 * logical table's own name) with their backing get-body expression. Base-member-
 * qualified references are left untouched.
 */
function substituteViewColumns(expr: AST.Expression, shape: DecompShape, view: MutableViewLike): AST.Expression {
	const viewName = view.name.toLowerCase();
	return transformExpr(expr, (col) => {
		if (col.table && col.table.toLowerCase() !== viewName) return undefined;
		const repl = shape.viewColToBaseRef.get(col.name.toLowerCase());
		return repl ? cloneExpr(repl) : undefined;
	});
}

/** Strip the anchor's alias qualifier so a predicate targets the bare anchor UPDATE/DELETE. */
function stripAnchorQualifier(expr: AST.Expression, shape: DecompShape): AST.Expression {
	return transformExpr(expr, (col) => (col.table === shape.anchor.relationId ? { type: 'column', name: col.name } : undefined));
}

// --- shape helpers --------------------------------------------------------

/**
 * logical-column → backing get-body expression, read off the synthesized body's
 * projection (`<backingExpr> as <logicalColumn>`). This is the exact inverse of
 * the projection `compileDecompositionBody` emitted, so a user predicate over a
 * logical column maps to the same base term the read uses.
 */
function buildViewColMap(view: MutableViewLike): Map<string, AST.Expression> {
	const map = new Map<string, AST.Expression>();
	const sel = view.selectAst;
	if (sel.type !== 'select') return map;
	for (const rc of sel.columns) {
		if (rc.type !== 'column') continue;
		const name = (rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined));
		if (name) map.set(name.toLowerCase(), rc.expr);
	}
	return map;
}

/** True when `logical` (lowercased) is one of the anchor's shared-key columns. */
function isSharedKeyColumn(shape: DecompShape, logical: string): boolean {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(shape.anchor.relationId) ?? [];
	return keys.some(k => k.toLowerCase() === logical);
}

/**
 * The single shared-key column for a member. v1 threads a single-column key
 * (mirrors `multi-source.ts`' single-column-PK boundary); a composite/absent key
 * is deferred. `view` is optional purely so the deferral message can name the
 * logical table (the anchor-subquery call site has none in scope).
 */
function singleKeyColumn(view: MutableViewLike | undefined, shape: DecompShape, member: DecompositionMember): string {
	const keys = shape.storage.sharedKey.keyColumnsByRelation.get(member.relationId) ?? [];
	if (keys.length !== 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-decomposition-key',
			table: view?.name,
			message: `cannot write through a decomposition with a ${keys.length === 0 ? 'missing' : 'composite'} shared key on member '${member.relationId}': v1 fan-out threads a single-column key`,
		});
	}
	return keys[0];
}

function memberIdentifier(member: DecompositionMember): AST.IdentifierExpr {
	return { type: 'identifier', name: member.relation.table, schema: member.relation.schema };
}

function memberIdentifierSource(member: DecompositionMember): AST.TableSource {
	return { type: 'table', table: memberIdentifier(member) };
}

function resolveMemberTable(ctx: PlanningContext, member: DecompositionMember): TableReferenceNode {
	return buildTableReference(memberIdentifierSource(member), ctx).tableRef;
}

/** Collect the member aliases (`ColumnExpr.table`) a mapped predicate references, and whether it holds a subquery. */
function collectColumnQualifiers(expr: AST.Expression): { tables: Set<string>; hasSubquery: boolean } {
	const tables = new Set<string>();
	let hasSubquery = false;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) { node.forEach(walk); return; }
		if (!node || typeof node !== 'object' || !('type' in (node as object))) return;
		const n = node as Record<string, unknown> & { type: string };
		if (n.type === 'column') {
			if (typeof n.table === 'string') tables.add(n.table);
			return;
		}
		if (n.type === 'subquery' || n.type === 'select' || n.type === 'exists') { hasSubquery = true; return; }
		for (const v of Object.values(n)) walk(v);
	};
	walk(expr);
	return { tables, hasSubquery };
}

function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through logical table '${view.name}' is not yet supported`,
		});
	}
}
