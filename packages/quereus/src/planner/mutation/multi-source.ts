import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import { isRelationalNode, type PlanNode, type RelationalPlanNode, type UpdateSite } from '../nodes/plan-node.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { buildSelectStmt } from '../building/select.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { transformExpr, cloneExpr, combineAnd } from './single-source.js';

/**
 * Multi-source view-mediated DML decomposition — the **key-preserving inner
 * join** acceptance case of the view-mutation substrate (docs/view-updateability.md
 * § Per-Operator Semantics — Inner Join, § Multi-Base-Table Mutations).
 *
 * Scope (this phase): a view body that is a two-table **inner equi-join** of base
 * tables, written through with `update` / `delete`. The walk is driven off the
 * **planned** body's `PhysicalProperties.updateLineage` (threaded by
 * `view-mutation-physical-lineage`) to route each output column to its owning
 * base table, then lowers a per-base statement back to AST so the ordinary
 * base-table builders are reused verbatim (the documented lower-risk path — the
 * base builders stay untouched). Each per-base operation is identified by a
 * **subquery over the join body**:
 *
 * ```sql
 * -- view: select j1.id as id, j1.a as a, j2.c as c
 * --       from tj1 j1 join tj2 j2 on j2.id = j1.t2id
 * update jv set a = 5, c = 9 where id = 3
 *   ->  update tj1 set a = 5 where id in (select j1.id from <join> where j1.id = 3)
 *       update tj2 set c = 9 where id in (select j2.id from <join> where j1.id = 3)
 * ```
 *
 * The subquery reconstructs the row-identifying predicate (the base PK of the
 * owning side) from the join body, which is exactly the predicate the optimizer
 * already proves a key over — so a side whose own PK is hidden by the projection
 * (`tj2.id` above) is still addressable.
 *
 * **Deferred, rejected here with a structured diagnostic (later phases):**
 * - multi-source `insert` — the shared join key is not a view column; it needs
 *   the per-row shared-surrogate mutation-context envelope (a new runtime
 *   surface). Rejected `unsupported-multisource-insert`.
 * - outer / cross / set-op / aggregate / window bodies — `unsupported-*`.
 * - `> 2` base tables, self-joins, composite-PK sides, comma (implicit) joins,
 *   `select *` join bodies, and cross-side `set` value references — each a
 *   precise diagnostic.
 */

// --- shape model ----------------------------------------------------------

/** One base-table side of the join. */
interface JoinSide {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	/** AST alias (lowercased) the body uses for this source, or the table name. */
	readonly alias: string;
}

/** One output column of the join view body, by backward lineage. */
interface OutColumn {
	/** Output (view) column name, lowercased. */
	readonly name: string;
	/** Index into `sides` of the owning base table (base-writable columns only). */
	readonly sideIndex?: number;
	/** Owning base column name (base-writable columns only). */
	readonly baseColumn?: string;
	/** True for an identity/rename projection of a base column (writable on update). */
	readonly writable: boolean;
}

interface JoinViewAnalysis {
	readonly sel: AST.SelectStmt;
	/** The two base-table sides, in AST source order. */
	readonly sides: readonly [JoinSide, JoinSide];
	/** View column name (lowercased) -> its base-term replacement expression. */
	readonly viewColToBaseRef: ReadonlyMap<string, AST.Expression>;
	readonly outColumns: readonly OutColumn[];
}

// --- entry ----------------------------------------------------------------

/**
 * True when the view body is a join (and so routes to this multi-source path
 * rather than the single-source spine). Cheap AST peek — no plan built.
 */
export function isJoinBody(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.from) return false;
	return selectAst.from.length > 1 || selectAst.from.some(f => f.type === 'join');
}

/**
 * Decompose a multi-source (two-table inner-join) view mutation into an ordered
 * `BaseOp[]`. Throws a structured diagnostic for any unsupported shape.
 */
export function propagateMultiSource(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): BaseOp[] {
	// Validate the join shape first (this rejects outer/cross/comma joins, > 2
	// tables, non-table sources, etc. with a `cannot write through view`
	// diagnostic), so every unsupported join — including an `insert` through one —
	// surfaces the precise shape reason before the op-specific handling.
	const analysis = analyzeJoinView(ctx, view);
	switch (req.op) {
		case 'update': return decomposeUpdate(view, analysis, req.stmt);
		case 'delete': return decomposeDelete(view, analysis, req.stmt);
		case 'insert':
			raiseMutationDiagnostic({
				reason: 'unsupported-multisource-insert',
				table: view.name,
				message: `cannot write through view '${view.name}': insert into a multi-source (join) view needs the per-row shared-surrogate mutation context, which is a later phase`,
			});
	}
}

// --- analysis -------------------------------------------------------------

function analyzeJoinView(ctx: PlanningContext, view: MutableViewLike): JoinViewAnalysis {
	if (view.selectAst.type !== 'select') {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' has a ${view.selectAst.type.toUpperCase()} body, which has no recoverable base operation`,
		});
	}
	const sel = view.selectAst;

	// LIMIT / OFFSET / DISTINCT escape the predicate-conjoin rewrite — reject (as
	// the single-source spine does) rather than silently widen the write.
	if (sel.limit || sel.offset) {
		raiseMutationDiagnostic({
			reason: 'unsupported-limit',
			table: view.name,
			message: `cannot write through view '${view.name}': a LIMIT/OFFSET join body is not decomposable (a mutation would escape the limited window)`,
		});
	}
	if (sel.distinct) {
		raiseMutationDiagnostic({
			reason: 'unsupported-distinct',
			table: view.name,
			message: `cannot write through view '${view.name}': a DISTINCT join body has no 1:1 base-row lineage`,
		});
	}

	const sources = collectInnerJoinSources(view, sel.from!);

	// Build the planned body and read its backward lineage (threaded by
	// view-mutation-physical-lineage). The logical tree built here keeps the clean
	// Project/Join/TableReference operator structure with `updateLineage` intact.
	const bodyPlan = buildSelectStmt(ctx, sel);
	if (!isRelationalNode(bodyPlan)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `view '${view.name}' body did not produce a relation`,
		});
	}
	const root = bodyPlan as RelationalPlanNode;
	const tableRefsById = collectTableRefs(root);

	// Match each AST source to its planned TableReferenceNode by name (self-joins
	// are rejected, so the table name is unambiguous among the two sources).
	const sides = sources.map((src): JoinSide => {
		const name = src.table.name.toLowerCase();
		const ref = [...tableRefsById.values()].find(r => r.tableSchema.name.toLowerCase() === name);
		if (!ref) {
			raiseMutationDiagnostic({
				reason: 'no-base-lineage',
				table: view.name,
				message: `cannot write through view '${view.name}': base table '${src.table.name}' did not resolve in the planned body`,
			});
		}
		return { table: ref, schema: ref.tableSchema, alias: (src.alias ?? src.table.name).toLowerCase() };
	}) as [JoinSide, JoinSide];

	const sideByTableId = new Map<number, number>();
	sides.forEach((s, idx) => sideByTableId.set(Number(s.table.id), idx));

	const attrs = root.getAttributes();
	const lineage = root.physical.updateLineage;

	// Explicit projections only: `select *` over a join is rejected (column→base
	// routing relies on a 1:1 projection list).
	const projections = sel.columns;
	if (projections.some(c => c.type === 'all')) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': list the join's output columns explicitly (a 'select *' join body is not yet decomposable)`,
		});
	}
	if (projections.length !== attrs.length) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': projection/attribute arity mismatch (${projections.length} vs ${attrs.length})`,
		});
	}

	const viewColToBaseRef = new Map<string, AST.Expression>();
	const outColumns: OutColumn[] = [];
	projections.forEach((rc, i) => {
		const attr = attrs[i];
		const outName = (view.columns?.[i] ?? attr.name).toLowerCase();
		// The projection's source expression is already in base terms (it lives in
		// the body's own FROM scope), so it is the substitution target for user
		// predicates/assignments written against this view column.
		viewColToBaseRef.set(outName, (rc as AST.ResultColumnExpr).expr);

		const site = lineage?.get(attr.id);
		const writableBase = identityBaseSite(site);
		if (writableBase) {
			const sideIndex = sideByTableId.get(writableBase.table);
			outColumns.push({ name: outName, sideIndex, baseColumn: writableBase.baseColumn, writable: sideIndex !== undefined });
		} else {
			outColumns.push({ name: outName, writable: false });
		}
	});

	return { sel, sides, viewColToBaseRef, outColumns };
}

/** The base column of an identity (bare-column / rename) UpdateSite, else undefined. */
function identityBaseSite(site: UpdateSite | undefined): { table: number; baseColumn: string } | undefined {
	if (site && site.kind === 'base' && site.inverse === undefined) {
		return { table: site.table, baseColumn: site.baseColumn };
	}
	return undefined;
}

/**
 * Collect the join's base-table sources, validating the body is a two-table
 * inner equi-join over plain base tables (no outer/cross/comma joins, subquery
 * or function sources, self-joins, or > 2 tables).
 */
function collectInnerJoinSources(view: MutableViewLike, from: readonly AST.FromClause[]): AST.TableSource[] {
	if (from.length !== 1 || from[0].type !== 'join') {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': only an explicit two-table 'JOIN ... ON' body is decomposable (a comma/implicit cross join is not)`,
		});
	}

	const out: AST.TableSource[] = [];
	const visit = (fc: AST.FromClause): void => {
		switch (fc.type) {
			case 'table':
				out.push(fc);
				return;
			case 'join': {
				if (fc.joinType !== 'inner' || !fc.condition) {
					raiseMutationDiagnostic({
						reason: 'unsupported-join',
						table: view.name,
						message: `cannot write through view '${view.name}': only INNER joins with an ON predicate are decomposable (got '${fc.joinType}'${fc.condition ? '' : ' without ON'})`,
					});
				}
				visit(fc.left);
				visit(fc.right);
				return;
			}
			default:
				raiseMutationDiagnostic({
					reason: 'nested-view',
					table: view.name,
					message: `cannot write through view '${view.name}': join sources must be plain base tables (a subquery / function source in the join is not yet supported)`,
				});
		}
	};
	visit(from[0]);

	if (out.length !== 2) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': only a two-table join is decomposable (found ${out.length} base tables)`,
		});
	}
	if (out[0].table.name.toLowerCase() === out[1].table.name.toLowerCase()) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': a self-join is not yet decomposable (its lineage references one table under two alias-bound sites)`,
		});
	}
	return out;
}

// --- UPDATE ---------------------------------------------------------------

function decomposeUpdate(view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.UpdateStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);

	// Route each assignment to its owning base side.
	const perSide: Array<{ column: string; value: AST.Expression }[]> = [[], []];
	for (const asg of stmt.assignments) {
		const out = analysis.outColumns.find(c => c.name === asg.column.toLowerCase());
		if (!out || !out.writable || out.sideIndex === undefined || !out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': column '${asg.column}' is a computed (non-invertible) expression and is read-only`,
			});
		}
		const side = analysis.sides[out.sideIndex];
		const other = analysis.sides[1 - out.sideIndex];
		// Rewrite the assigned value into base terms, then strip the owning side's
		// qualifier (the base UPDATE targets that table directly). A reference to
		// the other side cannot be expressed as a single-table SET — reject.
		const baseValue = stripSideQualifier(
			substituteViewColumns(asg.value, analysis.viewColToBaseRef, view),
			view, side, other,
		);
		perSide[out.sideIndex].push({ column: out.baseColumn, value: baseValue });
	}

	// Shared identifying predicate: the user WHERE rewritten to base terms,
	// conjoined with the view body's own WHERE.
	const idPredicate = buildIdentifyingPredicate(analysis, stmt.where, view);

	// Order parent-before-child where the FK is provable (matches insert ordering
	// intent and avoids surprising mid-statement FK states); arbitrary otherwise.
	const order = orderSides(analysis.sides);
	const ops: BaseOp[] = [];
	for (const sideIndex of order) {
		const assignments = perSide[sideIndex];
		if (assignments.length === 0) continue;
		const side = analysis.sides[sideIndex];
		const pk = requireSingleColumnPk(view, side);
		const where: AST.InExpr = {
			type: 'in',
			expr: { type: 'column', name: pk },
			subquery: buildIdentifyingSubquery(analysis, side, pk, idPredicate),
		};
		const statement: AST.UpdateStmt = {
			type: 'update',
			table: tableIdentifier(side.schema),
			assignments,
			where,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		ops.push({ table: side.table, op: 'update', statement });
	}

	if (ops.length === 0) {
		// No assignment routed (e.g. only computed columns) — caught above as
		// no-inverse, so this is unreachable; guard for safety.
		raiseMutationDiagnostic({
			reason: 'no-inverse',
			table: view.name,
			message: `cannot write through view '${view.name}': no writable base column targeted by the update`,
		});
	}
	return ops;
}

// --- DELETE ---------------------------------------------------------------

function decomposeDelete(view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.DeleteStmt): BaseOp[] {
	rejectReturning(view, stmt.returning);

	// Default `delete_via`: the FK-many (child) side — deleting the child removes
	// the joined row from the view while leaving the parent (§ Inner Join). The
	// child is the side that declares a foreign key onto the other.
	const childIndex = fkChildIndex(analysis.sides);
	if (childIndex === undefined) {
		raiseMutationDiagnostic({
			reason: 'delete-ambiguous',
			table: view.name,
			message: `cannot delete through view '${view.name}': no declared foreign key proves which side is the FK-many (child) to delete; the 'quereus.update.delete_via' override is a later phase`,
		});
	}
	const side = analysis.sides[childIndex];
	const pk = requireSingleColumnPk(view, side);
	const idPredicate = buildIdentifyingPredicate(analysis, stmt.where, view);
	const where: AST.InExpr = {
		type: 'in',
		expr: { type: 'column', name: pk },
		subquery: buildIdentifyingSubquery(analysis, side, pk, idPredicate),
	};
	const statement: AST.DeleteStmt = {
		type: 'delete',
		table: tableIdentifier(side.schema),
		where,
		contextValues: stmt.contextValues,
		schemaPath: stmt.schemaPath,
		loc: stmt.loc,
	};
	return [{ table: side.table, op: 'delete', statement }];
}

// --- predicate / subquery construction ------------------------------------

/**
 * The combined base-term identifying predicate: the user's WHERE (rewritten from
 * view columns to base terms) conjoined with the view body's own WHERE (already
 * in base terms). Either may be absent.
 */
function buildIdentifyingPredicate(
	analysis: JoinViewAnalysis,
	userWhere: AST.Expression | undefined,
	view: MutableViewLike,
): AST.Expression | undefined {
	const userBase = userWhere ? substituteViewColumns(userWhere, analysis.viewColToBaseRef, view) : undefined;
	const bodyWhere = analysis.sel.where ? cloneExpr(analysis.sel.where) : undefined;
	return combineAnd(userBase, bodyWhere);
}

/**
 * `select <alias>.<pk> from <view join body> where <idPredicate>` — the subquery
 * whose result set is the owning side's PK values for every joined row matching
 * the mutation. The FROM is a deep clone of the view body's FROM so the two
 * sides' subqueries never share AST nodes.
 */
function buildIdentifyingSubquery(
	analysis: JoinViewAnalysis,
	side: JoinSide,
	pk: string,
	idPredicate: AST.Expression | undefined,
): AST.SelectStmt {
	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: pk, table: side.alias } }],
		from: analysis.sel.from!.map(cloneFromClause),
		where: idPredicate,
	};
}

/**
 * Substitute references to view columns (unqualified, or qualified by the view's
 * own name) with their base-term replacement expression. References already
 * qualified by a base alias are left untouched.
 */
function substituteViewColumns(
	expr: AST.Expression,
	viewColToBaseRef: ReadonlyMap<string, AST.Expression>,
	view: MutableViewLike,
): AST.Expression {
	const viewName = view.name.toLowerCase();
	return transformExpr(expr, (col) => {
		if (col.table && col.table.toLowerCase() !== viewName) return undefined;
		const repl = viewColToBaseRef.get(col.name.toLowerCase());
		return repl ? cloneExpr(repl) : undefined;
	});
}

/**
 * Strip the owning side's alias qualifier from a base-term assignment value (so
 * it targets the single-table UPDATE directly), rejecting any reference to the
 * other side (which a single-table SET cannot express).
 */
function stripSideQualifier(
	expr: AST.Expression,
	view: MutableViewLike,
	owning: JoinSide,
	other: JoinSide,
): AST.Expression {
	const owningQuals = new Set([owning.alias, owning.schema.name.toLowerCase()]);
	const otherQuals = new Set([other.alias, other.schema.name.toLowerCase()]);
	return transformExpr(expr, (col) => {
		if (!col.table) return undefined;
		const t = col.table.toLowerCase();
		if (otherQuals.has(t)) {
			raiseMutationDiagnostic({
				reason: 'cross-source-assignment',
				column: col.name,
				table: view.name,
				message: `cannot write through view '${view.name}': an update value references column '${col.name}' on a different base table than the column it assigns; cross-source assignment is not supported`,
			});
		}
		if (owningQuals.has(t)) return { type: 'column', name: col.name };
		return undefined;
	});
}

// --- helpers --------------------------------------------------------------

function tableIdentifier(table: TableSchema): AST.IdentifierExpr {
	return { type: 'identifier', name: table.name, schema: table.schemaName };
}

function requireSingleColumnPk(view: MutableViewLike, side: JoinSide): string {
	const pk = side.schema.primaryKeyDefinition;
	if (pk.length !== 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': base table '${side.schema.name}' has a ${pk.length === 0 ? 'missing' : 'composite'} primary key; multi-source identifying predicates need a single-column key`,
		});
	}
	return side.schema.columns[pk[0].index].name;
}

/**
 * Index of the FK-child (many) side: the side declaring a foreign key onto the
 * other. `undefined` when no FK is provable or both sides reference each other.
 */
function fkChildIndex(sides: readonly [JoinSide, JoinSide]): number | undefined {
	const refs = (child: JoinSide, parent: JoinSide): boolean =>
		(child.schema.foreignKeys ?? []).some(fk =>
			fk.referencedTable.toLowerCase() === parent.schema.name.toLowerCase()
			&& (fk.referencedSchema ?? child.schema.schemaName).toLowerCase() === parent.schema.schemaName.toLowerCase());
	const zeroRefsOne = refs(sides[0], sides[1]);
	const oneRefsZero = refs(sides[1], sides[0]);
	if (zeroRefsOne && !oneRefsZero) return 0;
	if (oneRefsZero && !zeroRefsOne) return 1;
	return undefined;
}

/** Side execution order: FK-parent before FK-child where provable, else as-is. */
function orderSides(sides: readonly [JoinSide, JoinSide]): number[] {
	const child = fkChildIndex(sides);
	if (child === undefined) return [0, 1];
	return child === 0 ? [1, 0] : [0, 1];
}

/** Deep-clone a FROM clause (table sources and inner joins only). */
function cloneFromClause(fc: AST.FromClause): AST.FromClause {
	switch (fc.type) {
		case 'table':
			return { ...fc };
		case 'join':
			return {
				...fc,
				left: cloneFromClause(fc.left),
				right: cloneFromClause(fc.right),
				condition: fc.condition ? cloneExpr(fc.condition) : undefined,
			};
		default:
			// Unreachable: collectInnerJoinSources rejects non-table/join sources.
			return { ...fc };
	}
}

function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through view '${view.name}' is not yet supported`,
		});
	}
}

/** Collect every `TableReferenceNode` in a planned body, indexed by plan-node id. */
function collectTableRefs(root: PlanNode): Map<number, TableReferenceNode> {
	const out = new Map<number, TableReferenceNode>();
	const visit = (n: PlanNode): void => {
		if (n instanceof TableReferenceNode) {
			out.set(Number(n.id), n);
			return;
		}
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	return out;
}
