import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import { isRelationalNode, PlanNode, type RelationalPlanNode, type UpdateSite, type Attribute, type TableDescriptor } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { PhysicalType } from '../../types/logical-type.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import { buildSelectStmt } from '../building/select.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { transformExpr, cloneExpr, combineAnd, makeViewColumnDescend, mapQueryExprUniform } from './single-source.js';
import { readPolicy, readDeleteVia, readTargetNames, readExcludeNames, type ReservedTagMap } from './mutation-tags.js';
import type { DeleteViaValue } from '../../schema/reserved-tags.js';

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
 * Multi-source **`insert`** (Phase 2b) is analysed here (`analyzeMultiSourceInsert`)
 * but *built* by `building/view-mutation-builder.ts` (`buildMultiSourceInsert`),
 * because it needs the plan-level shared-surrogate envelope rather than an AST
 * `BaseOp`: the shared join key is not a view column, so it is minted once per row
 * at the envelope and threaded into both base inserts (§ Mutation Context).
 *
 * **Deferred, rejected here with a structured diagnostic (later phases):**
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
	/** Output (view) column name in its original display spelling (for `returning *`). */
	readonly displayName: string;
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
 * Non-throwing AST shape check — the boolean shadow of {@link collectInnerJoinSources}'s
 * acceptance: `true` iff the body is a single explicit two-table INNER join with
 * an ON predicate over two **distinct plain base tables** (the exact multi-source
 * shape `propagate()` decomposes). Every other multi-table body — cross / outer /
 * comma (implicit) / `> 2`-table / subquery- or function-source / self-join —
 * returns `false`.
 *
 * Shared with the static updateability surfaces (`deriveViewInfo` /
 * `deriveColumnInfo` in `func/builtins/schema.ts`): they gate on this so they
 * agree with what a real mutation through the view accepts, rather than reading
 * `updateLineage` (which carries strict-`base` sites for cross / `> 2`-table
 * bodies — only LEFT/RIGHT/FULL outer joins null-extend — and would otherwise
 * over-report `is_updatable = 'YES'`). The throwing `collectInnerJoinSources`
 * stays the substrate's source of truth; this mirrors only its AST-level shape
 * gate (it does not re-check DISTINCT/LIMIT/`select *`/PK, which are deeper
 * semantic rejects handled downstream).
 */
export function isDecomposableJoinBody(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.from) return false;
	const from = selectAst.from;
	if (from.length !== 1 || from[0].type !== 'join') return false;

	const tables: AST.TableSource[] = [];
	const visit = (fc: AST.FromClause): boolean => {
		switch (fc.type) {
			case 'table':
				tables.push(fc);
				return true;
			case 'join':
				if (fc.joinType !== 'inner' || !fc.condition) return false;
				return visit(fc.left) && visit(fc.right);
			default:
				return false; // subquery / function source — not a plain base table
		}
	};
	if (!visit(from[0])) return false;

	// Exactly two distinct base tables (a self-join references one table under two
	// alias-bound sites, which the substrate also rejects).
	if (tables.length !== 2) return false;
	return tables[0].table.name.toLowerCase() !== tables[1].table.name.toLowerCase();
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
		case 'update': return decomposeUpdate(ctx, view, analysis, req.stmt, req.tags);
		case 'delete': return decomposeDelete(ctx, view, analysis, req.stmt, req.tags);
		case 'insert':
			// Insert needs the plan-level shared-surrogate envelope, so it is built
			// directly by `building/view-mutation-builder.ts` (`buildMultiSourceInsert`,
			// off `analyzeMultiSourceInsert` below), not lowered to AST BaseOps here.
			// `buildViewMutation` routes a join insert there before `propagate` runs,
			// so this case is unreachable on the supported path.
			raiseMutationDiagnostic({
				reason: 'unsupported-multisource-insert',
				table: view.name,
				message: `internal: multi-source insert must be built via buildMultiSourceInsert, not propagate`,
			});
	}
}

// --- INSERT (shared-surrogate envelope analysis) --------------------------

/**
 * One base side of a multi-source insert, fully resolved: the base columns it
 * writes (shared key first, then the supplied view columns it owns) and, for
 * each, the index into the materialized envelope row supplying the value.
 */
export interface MsInsertSide {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	readonly targetColumns: readonly string[];
	readonly envelopeIndices: readonly number[];
}

/**
 * The plan-agnostic decomposition of a multi-source inner-join INSERT, consumed
 * by `buildMultiSourceInsert`. The **envelope** is the per-row augmented source:
 * its leading columns are the supplied view columns (`suppliedColumns`, in
 * user-source order), optionally followed by a minted surrogate shared key
 * (`mint`). Each side reads its values back out of that one materialized
 * envelope, so a generated key is minted exactly once per row and threaded
 * across both base inserts (docs/view-updateability.md § Mutation Context).
 */
export interface MsInsertAnalysis {
	readonly suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[];
	/** Sides ordered FK-parent before FK-child (the FK-safe insert order). */
	readonly orderedSides: readonly MsInsertSide[];
	/** Set when the shared key is not directly supplied — mint `seed + ordinal`. */
	readonly mint?: { readonly seedTable: TableReferenceNode; readonly seedColumn: string };
}

/**
 * Decompose a two-table key-preserving inner-join INSERT into the per-side base
 * inserts plus the shared-surrogate envelope they fan out from. Throws a
 * structured diagnostic for any unsupported shape (computed target column, a
 * not-null base column with no value, a non-equi-join key, …).
 */
export function analyzeMultiSourceInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): MsInsertAnalysis {
	rejectReturning(view, stmt.returning);
	const analysis = analyzeJoinView(ctx, view);
	const { sides, outColumns } = analysis;
	const keyColumns = extractJoinKeyColumns(view, analysis.sel, sides);

	// Supplied view columns: the explicit list, or every writable view output column.
	const suppliedNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: outColumns.filter(c => c.writable).map(c => c.name);

	interface Supplied { readonly name: string; readonly sideIndex: number; readonly baseColumn: string; readonly type: ScalarType; readonly isKey: boolean; }
	const supplied: Supplied[] = suppliedNames.map((rawName): Supplied => {
		const name = rawName.toLowerCase();
		const out = outColumns.find(c => c.name === name);
		if (!out || !out.writable || out.sideIndex === undefined || !out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert through view '${view.name}': column '${rawName}' is computed (non-invertible) or not a base column, so it cannot receive an inserted value`,
			});
		}
		const sideIndex = out.sideIndex;
		const baseCol = columnByName(sides[sideIndex].schema, out.baseColumn);
		const isKey = out.baseColumn.toLowerCase() === keyColumns[sideIndex].toLowerCase();
		return { name, sideIndex, baseColumn: out.baseColumn, type: columnScalarType(baseCol), isKey };
	});

	// The shared key is a single value threaded into both sides. If the view exposes
	// it more than once (both sides of the equi-join key, or the same side's key
	// twice), an insert cannot honor divergent supplied values without either
	// breaking the join invariant or silently dropping one — reject, directing the
	// user to supply the shared key through a single view column.
	const suppliedKeys = supplied.filter(s => s.isKey);
	if (suppliedKeys.length > 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the shared join key is exposed by more than one view column (${suppliedKeys.map(s => `'${s.name}'`).join(', ')}); supply it through a single view column`,
		});
	}

	// The shared key is either directly supplied (a supplied view column maps to a
	// join-key base column) or minted once per row at the envelope.
	const suppliedKeyIndex = supplied.findIndex(s => s.isKey);
	let mint: MsInsertAnalysis['mint'] | undefined;
	let keyEnvelopeIndex: number;
	if (suppliedKeyIndex >= 0) {
		keyEnvelopeIndex = suppliedKeyIndex;
	} else {
		keyEnvelopeIndex = supplied.length; // the minted column is appended last
		const anchorIndex = anchorSideIndex(sides);
		const anchorKeyCol = columnByName(sides[anchorIndex].schema, keyColumns[anchorIndex]);
		requireIntegerSurrogate(view, sides[anchorIndex].schema, anchorKeyCol);
		mint = { seedTable: sides[anchorIndex].table, seedColumn: keyColumns[anchorIndex] };
	}

	// Per-side: the shared key (every side) plus the supplied view columns it owns.
	const sideSpecs: MsInsertSide[] = sides.map((side, sideIndex): MsInsertSide => {
		const targetColumns: string[] = [keyColumns[sideIndex]];
		const envelopeIndices: number[] = [keyEnvelopeIndex];
		supplied.forEach((s, idx) => {
			if (s.sideIndex !== sideIndex || s.isKey) return; // the key is already threaded above
			targetColumns.push(s.baseColumn);
			envelopeIndices.push(idx);
		});
		assertNoMissingNotNull(view, side.schema, targetColumns);
		return { table: side.table, schema: side.schema, targetColumns, envelopeIndices };
	});

	const order = orderSides(sides);
	return {
		suppliedColumns: supplied.map(s => ({ name: s.name, type: s.type })),
		orderedSides: order.map(i => sideSpecs[i]),
		mint,
	};
}

/**
 * The per-side shared-key base columns of a two-table inner equi-join, aligned to
 * `sides` by index. Requires a single `a.col = b.col` ON predicate naming one
 * column on each side (the surrogate the decomposition stitches on).
 */
function extractJoinKeyColumns(view: MutableViewLike, sel: AST.SelectStmt, sides: readonly [JoinSide, JoinSide]): [string, string] {
	const join = sel.from?.[0];
	if (!join || join.type !== 'join' || !join.condition) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the join must carry an explicit ON predicate naming the shared key`,
		});
	}
	const cond = join.condition;
	if (cond.type !== 'binary' || cond.operator !== '=' || cond.left.type !== 'column' || cond.right.type !== 'column') {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': only a single equi-join 'a.col = b.col' identifies the shared key for an insert (composite / expression join keys are a later phase)`,
		});
	}
	const sideOf = (col: AST.ColumnExpr): number => {
		const qualifier = col.table?.toLowerCase();
		if (qualifier === undefined) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `cannot insert through view '${view.name}': the join key column '${col.name}' must be qualified by its base table/alias`,
			});
		}
		const idx = sides.findIndex(s => s.alias === qualifier || s.schema.name.toLowerCase() === qualifier);
		if (idx < 0) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `cannot insert through view '${view.name}': the join key references '${qualifier}', which is not a base table of the join`,
			});
		}
		return idx;
	};
	const leftSide = sideOf(cond.left);
	const rightSide = sideOf(cond.right);
	if (leftSide === rightSide) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the join key must relate the two distinct base tables`,
		});
	}
	const keys: [string, string] = ['', ''];
	keys[leftSide] = cond.left.name;
	keys[rightSide] = cond.right.name;
	return keys;
}

/** The side whose key seeds a minted surrogate: the FK-parent, else the left source. */
function anchorSideIndex(sides: readonly [JoinSide, JoinSide]): number {
	const child = fkChildIndex(sides);
	return child === undefined ? 0 : 1 - child;
}

/** Reject a not-null base column with no declared default that no envelope value covers. */
function assertNoMissingNotNull(view: MutableViewLike, schema: TableSchema, targetColumns: readonly string[]): void {
	const covered = new Set(targetColumns.map(c => c.toLowerCase()));
	for (const col of schema.columns) {
		if (col.generated || !col.notNull || col.defaultValue !== null) continue;
		if (covered.has(col.name.toLowerCase())) continue;
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: col.name,
			table: view.name,
			message: `cannot insert through view '${view.name}': base table '${schema.name}' column '${col.name}' is NOT NULL with no default and no value supplied through the view`,
		});
	}
}

/** The surrogate generator (`integer-auto`) mints integers — reject a non-integer key. */
function requireIntegerSurrogate(view: MutableViewLike, schema: TableSchema, keyCol: ColumnSchema): void {
	if (keyCol.logicalType.physicalType !== PhysicalType.INTEGER) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: keyCol.name,
			table: view.name,
			message: `cannot insert through view '${view.name}': the shared key '${schema.name}.${keyCol.name}' is not supplied and is not an integer surrogate the engine can auto-generate; supply the key as a view column`,
		});
	}
}

function columnByName(schema: TableSchema, name: string): ColumnSchema {
	const col = schema.columns.find(c => c.name.toLowerCase() === name.toLowerCase());
	if (!col) {
		raiseMutationDiagnostic({ reason: 'no-base-lineage', table: schema.name, column: name, message: `column '${name}' not found on base table '${schema.name}'` });
	}
	return col;
}

function columnScalarType(col: ColumnSchema): ScalarType {
	return { typeClass: 'scalar', logicalType: col.logicalType, nullable: !col.notNull, isReadOnly: false };
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
		const displayName = view.columns?.[i] ?? attr.name;
		const outName = displayName.toLowerCase();
		// The projection's source expression is already in base terms (it lives in
		// the body's own FROM scope), so it is the substitution target for user
		// predicates/assignments written against this view column.
		viewColToBaseRef.set(outName, (rc as AST.ResultColumnExpr).expr);

		const site = lineage?.get(attr.id);
		const writableBase = identityBaseSite(site);
		if (writableBase) {
			const sideIndex = sideByTableId.get(writableBase.table);
			outColumns.push({ name: outName, displayName, sideIndex, baseColumn: writableBase.baseColumn, writable: sideIndex !== undefined });
		} else {
			outColumns.push({ name: outName, displayName, writable: false });
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

function decomposeUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.UpdateStmt, tags?: ReservedTagMap): BaseOp[] {
	// RETURNING through a multi-source update is supported, but the rows are not
	// recoverable from the per-side base ops (the view row spans both tables), so
	// the builder (`view-mutation-builder.ts`) supplies them via a re-query of the
	// view; the base ops themselves carry no RETURNING.

	// `target` / `exclude` narrow the writable base set (compose AFTER predicate
	// dispatch — they only restrict, never broaden). For an update the side set is
	// already pinned per-assignment by lineage, so the tag acts as a guard: an
	// assignment to an excluded side is a structured conflict, not a silent drop.
	const allowedSides = applyTargetExclude([0, 1], analysis.sides, tags, view);

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
			substituteViewColumns(ctx, asg.value, analysis.viewColToBaseRef, view),
			view, side, other,
		);
		perSide[out.sideIndex].push({ column: out.baseColumn, value: baseValue });
	}

	// Shared identifying predicate: the user WHERE rewritten to base terms,
	// conjoined with the view body's own WHERE.
	const idPredicate = buildIdentifyingPredicate(ctx, analysis, stmt.where, view);

	// Order parent-before-child where the FK is provable (matches insert ordering
	// intent and avoids surprising mid-statement FK states); arbitrary otherwise.
	const order = orderSides(analysis.sides);
	const ops: BaseOp[] = [];
	for (const sideIndex of order) {
		const assignments = perSide[sideIndex];
		if (assignments.length === 0) continue;
		if (!allowedSides.includes(sideIndex)) {
			raiseMutationDiagnostic({
				reason: 'tag-conflict',
				table: view.name,
				message: `cannot write through view '${view.name}': the update assigns a column owned by base table '${analysis.sides[sideIndex].schema.name}', but a 'quereus.update.target'/'exclude' tag excludes that table`,
			});
		}
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

// --- UPDATE RETURNING (per-row identity capture) --------------------------

/**
 * Build the per-row identity-capture RETURNING substrate for a multi-source
 * (two-table inner-join) UPDATE (docs/view-updateability.md § `returning`
 * Clauses). A post-mutation re-query that matched by the *user predicate* cannot
 * recapture a row whose predicate column the update itself rewrote (the changed
 * row no longer matches). Instead we capture each affected view row's base-PK
 * identity `(k0, k1)` **before** the base ops fire, then re-query the join body
 * **after** the mutation restricted to those captured identities — so a row the
 * update pushed out of the view's filter is still returned (matching single-source
 * NEW semantics).
 *
 * Returns:
 *  - `source`: the capture SELECT `select s0.pk0 as k0, s1.pk1 as k1 from <body>
 *    where <idPredicate>` — the emitter materializes it into context **before** the
 *    base ops run.
 *  - `descriptor`: the identity stitch shared between the materialized capture rows
 *    and the {@link InternalRecursiveCTERefNode} the re-query reads them back through.
 *  - `returning`: the post-mutation re-query — the view-spelled, base-term RETURNING
 *    projection over the join body, filtered by `exists (select 1 from __vmret_keys
 *    k where k.k0 = s0.pk0 and k.k1 = s1.pk1)`. It keeps only the structural join
 *    ON-condition (in the body FROM); the body/user WHERE is intentionally NOT
 *    re-applied.
 *
 * Requires a **single-column PK on both** join sides (the captured identity is both
 * sides' PKs); a composite-PK side is rejected with `unsupported-join` by
 * {@link requireSingleColumnPk}.
 */
export function buildMultiSourceUpdateReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.UpdateStmt,
): { source: RelationalPlanNode; descriptor: TableDescriptor; returning: RelationalPlanNode } {
	const analysis = analyzeJoinView(ctx, view);
	const returningCols = stmt.returning!;
	const [side0, side1] = analysis.sides;
	const pk0 = requireSingleColumnPk(view, side0);
	const pk1 = requireSingleColumnPk(view, side1);
	const pk0Type = columnScalarType(columnByName(side0.schema, pk0));
	const pk1Type = columnScalarType(columnByName(side1.schema, pk1));

	// (1) Capture source: the affected view rows' base-PK identities, by the same
	// identifying predicate the base ops route on (user WHERE → base ∧ body WHERE).
	// preserveInputColumns=false ⇒ the output is exactly `[k0, k1]`, positionally
	// aligned to the key ref's attributes the re-query reads back from context.
	const idPredicate = buildIdentifyingPredicate(ctx, analysis, stmt.where, view);
	const captureAst: AST.SelectStmt = {
		type: 'select',
		columns: [
			{ type: 'column', expr: { type: 'column', name: pk0, table: side0.alias }, alias: 'k0' },
			{ type: 'column', expr: { type: 'column', name: pk1, table: side1.alias }, alias: 'k1' },
		],
		from: analysis.sel.from!.map(cloneFromClause),
		where: idPredicate,
	};
	const source = buildSelectStmt(ctx, captureAst, new Map(), false);
	if (!isRelationalNode(source)) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `cannot project RETURNING through view '${view.name}': the identity-capture query did not produce a relation`,
		});
	}

	// (2) The context-backed key relation the re-query's EXISTS scans. Its descriptor
	// identity is shared with the rows the emitter materializes (the working-table-in-
	// context pattern recursive CTEs / the insert envelope reuse).
	const descriptor: TableDescriptor = {};
	const keyAttrs: Attribute[] = [
		{ id: PlanNode.nextAttrId(), name: 'k0', type: pk0Type, sourceRelation: '__vmret_keys' },
		{ id: PlanNode.nextAttrId(), name: 'k1', type: pk1Type, sourceRelation: '__vmret_keys' },
	];
	const keyRelType: RelationType = {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false,
		columns: [{ name: 'k0', type: pk0Type }, { name: 'k1', type: pk1Type }],
		keys: [],
		rowConstraints: [],
	};
	const keyRef = new InternalRecursiveCTERefNode(ctx.scope, '__vmret_keys', keyAttrs, keyRelType, descriptor);

	// (4) Post re-query: project the view-spelled, base-term RETURNING columns against
	// the post-mutation join body, restricted to the captured identities by EXISTS.
	const existsPredicate: AST.Expression = {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: '__vmret_keys' }, alias: 'k' }],
			where: combineAnd(
				{ type: 'binary', operator: '=', left: { type: 'column', name: 'k0', table: 'k' }, right: { type: 'column', name: pk0, table: side0.alias } },
				{ type: 'binary', operator: '=', left: { type: 'column', name: 'k1', table: 'k' }, right: { type: 'column', name: pk1, table: side1.alias } },
			),
		},
	};
	const requeryAst: AST.SelectStmt = {
		type: 'select',
		columns: buildReturningProjection(ctx, view, analysis, returningCols),
		from: analysis.sel.from!.map(cloneFromClause),
		where: existsPredicate,
	};
	const returning = buildSelectStmt(ctx, requeryAst, new Map([['__vmret_keys', keyRef]]), false);
	if (!isRelationalNode(returning)) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `cannot project RETURNING through view '${view.name}': the post-mutation re-query did not produce a relation`,
		});
	}

	return { source, descriptor, returning };
}

/**
 * Lower a multi-source UPDATE's RETURNING result columns to base terms over the
 * join body, preserving the **view spelling** of each output column. A bare view-
 * column ref substitutes to its base term aliased to the column's written spelling
 * (so a renamed view col `eid`→base `id` still surfaces as `eid`); a computed
 * RETURNING expression has its nested view-column refs substituted; `returning *`
 * expands to every view output column's base term aliased to its display name.
 */
function buildReturningProjection(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: JoinViewAnalysis,
	returningCols: readonly AST.ResultColumn[],
): AST.ResultColumn[] {
	const out: AST.ResultColumn[] = [];
	for (const rc of returningCols) {
		if (rc.type === 'all') {
			for (const col of analysis.outColumns) {
				const baseExpr = analysis.viewColToBaseRef.get(col.name);
				if (!baseExpr) {
					raiseMutationDiagnostic({
						reason: 'returning-through-view',
						table: view.name,
						message: `cannot expand 'returning *' through view '${view.name}': no base term for column '${col.displayName}'`,
					});
				}
				out.push({ type: 'column', expr: cloneExpr(baseExpr), alias: col.displayName });
			}
		} else {
			const substituted = substituteViewColumns(ctx, rc.expr, analysis.viewColToBaseRef, view);
			// Preserve the user's view spelling as the output name: an explicit alias
			// wins; a bare column ref keeps its own name; otherwise leave it unnamed.
			const alias = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : undefined);
			out.push({ type: 'column', expr: substituted, alias });
		}
	}
	return out;
}

// --- DELETE ---------------------------------------------------------------

function decomposeDelete(ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.DeleteStmt, tags?: ReservedTagMap): BaseOp[] {
	// RETURNING through a multi-source delete is supported via a re-query of the
	// view captured *before* the base delete fires (the builder); the base op
	// itself carries no RETURNING.

	const sideIndex = chooseDeleteSide(view, analysis, tags);
	const side = analysis.sides[sideIndex];
	const pk = requireSingleColumnPk(view, side);
	const idPredicate = buildIdentifyingPredicate(ctx, analysis, stmt.where, view);
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

/**
 * Pick the single base side a join delete routes to (§ Inner Join — Deletes).
 * Deleting one side of an inner equi-join removes the joined row from the view,
 * so a delete resolves to exactly one side; the tags decide which.
 *
 * Resolution order (tags compose AFTER predicate dispatch — they only restrict):
 * 1. `target` / `exclude` narrow the candidate sides (`tag-target-not-found` on
 *    an unknown name; `tag-conflict` if they remove every side).
 * 2. An explicit `delete_via` picks a side directly (`parent` → the FK-parent,
 *    `left_delete` → the left source); it must lie within the candidates.
 * 3. Otherwise the **default**: if `target`/`exclude` already left exactly one
 *    side, that side. Else if a foreign key proves the FK-many (child) side, that
 *    side (deleting the child leaves the parent — the documented FK-style
 *    default). Else the delete is ambiguous: `policy=strict` rejects it with a
 *    `policy-strict-ambiguity` diagnostic; the default `lenient` policy rejects
 *    it as `delete-ambiguous` (the predicate-honest multi-side fan-out is
 *    deferred — it needs snapshot-consistent base-op execution, see the handoff)
 *    — both directing the user to a `delete_via` / `target` override.
 */
function chooseDeleteSide(view: MutableViewLike, analysis: JoinViewAnalysis, tags?: ReservedTagMap): number {
	const candidates = applyTargetExclude([0, 1], analysis.sides, tags, view);

	const deleteVia = readDeleteVia(tags);
	if (deleteVia) {
		const picked = resolveDeleteViaSide(deleteVia, analysis.sides, view);
		if (!candidates.includes(picked)) {
			raiseMutationDiagnostic({
				reason: 'tag-conflict',
				table: view.name,
				message: `cannot delete through view '${view.name}': 'quereus.update.delete_via' picks base table '${analysis.sides[picked].schema.name}', but a 'target'/'exclude' tag excludes it`,
			});
		}
		return picked;
	}

	if (candidates.length === 1) return candidates[0];

	const policy = readPolicy(tags);
	if (policy === 'strict') {
		raiseMutationDiagnostic({
			reason: 'policy-strict-ambiguity',
			table: view.name,
			message: `cannot delete through view '${view.name}': the deletion side is ambiguous and 'quereus.update.policy' = 'strict' forbids guessing; pin it with 'quereus.update.delete_via' or 'quereus.update.target'`,
		});
	}

	const childIndex = fkChildIndex(analysis.sides);
	if (childIndex !== undefined && candidates.includes(childIndex)) return childIndex;

	raiseMutationDiagnostic({
		reason: 'delete-ambiguous',
		table: view.name,
		message: `cannot delete through view '${view.name}': no declared foreign key proves which side is the FK-many (child) to delete; pin it with 'quereus.update.delete_via' or 'quereus.update.target'`,
	});
}

/**
 * The single base side an explicit `delete_via` names for a join. `'parent'`
 * selects the FK-parent (requires a provable foreign key); `'left_delete'`
 * selects the left join source. `'right_insert'` is an `except`-branch value
 * with no join meaning — rejected with a pointer to the join-valid forms.
 */
function resolveDeleteViaSide(deleteVia: DeleteViaValue, sides: readonly [JoinSide, JoinSide], view: MutableViewLike): number {
	switch (deleteVia) {
		case 'parent': {
			const child = fkChildIndex(sides);
			if (child === undefined) {
				raiseMutationDiagnostic({
					reason: 'tag-target-not-found',
					table: view.name,
					message: `cannot delete through view '${view.name}': 'quereus.update.delete_via' = 'parent' needs a declared foreign key to identify the parent side, but none is provable; name the side with 'quereus.update.target' instead`,
				});
			}
			return 1 - child;
		}
		case 'left_delete':
			return 0;
		case 'right_insert':
			raiseMutationDiagnostic({
				reason: 'tag-target-not-found',
				table: view.name,
				message: `cannot delete through view '${view.name}': 'quereus.update.delete_via' = 'right_insert' applies to an 'except' branch, not a join; use 'left_delete', 'parent', or 'quereus.update.target'`,
			});
	}
}

/**
 * Indices of `sides` permitted by `target` / `exclude` (each a CSV of base-table
 * names or aliases). An unknown name is a hard `tag-target-not-found`; removing
 * every side is a `tag-conflict`. With neither tag present the candidate list is
 * returned unchanged.
 */
function applyTargetExclude(
	candidates: number[],
	sides: readonly [JoinSide, JoinSide],
	tags: ReservedTagMap | undefined,
	view: MutableViewLike,
): number[] {
	const target = readTargetNames(tags);
	const exclude = readExcludeNames(tags);
	if (!target && !exclude) return candidates;

	const nameToIndex = new Map<string, number>();
	sides.forEach((s, i) => {
		nameToIndex.set(s.schema.name.toLowerCase(), i);
		nameToIndex.set(s.alias, i); // alias is already lowercased
	});
	const requireKnown = (names: readonly string[], tagName: string): void => {
		for (const name of names) {
			if (!nameToIndex.has(name)) {
				raiseMutationDiagnostic({
					reason: 'tag-target-not-found',
					table: view.name,
					message: `cannot write through view '${view.name}': 'quereus.update.${tagName}' names '${name}', which is not a base table of the join`,
				});
			}
		}
	};

	let result = candidates;
	if (target) {
		requireKnown(target, 'target');
		const allowed = new Set(target.map(n => nameToIndex.get(n)!));
		result = result.filter(i => allowed.has(i));
	}
	if (exclude) {
		requireKnown(exclude, 'exclude');
		const excluded = new Set(exclude.map(n => nameToIndex.get(n)!));
		result = result.filter(i => !excluded.has(i));
	}
	if (result.length === 0) {
		raiseMutationDiagnostic({
			reason: 'tag-conflict',
			table: view.name,
			message: `cannot write through view '${view.name}': 'quereus.update.target'/'exclude' tags exclude every base table of the join`,
		});
	}
	return result;
}

// --- predicate / subquery construction ------------------------------------

/**
 * The combined base-term identifying predicate: the user's WHERE (rewritten from
 * view columns to base terms) conjoined with the view body's own WHERE (already
 * in base terms). Either may be absent.
 */
function buildIdentifyingPredicate(
	ctx: PlanningContext,
	analysis: JoinViewAnalysis,
	userWhere: AST.Expression | undefined,
	view: MutableViewLike,
): AST.Expression | undefined {
	const userBase = userWhere ? substituteViewColumns(ctx, userWhere, analysis.viewColToBaseRef, view) : undefined;
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
 * qualified by a base alias are left untouched. A view-column reference nested
 * inside a `subquery` / `exists` / `in`-subquery operand is rewritten too, via
 * the scope-aware {@link makeViewColumnDescend} descent — the base-term
 * replacements are alias-qualified (`p.label`), so they correlate correctly to
 * the join body that becomes the FROM of the generated identifying subquery.
 * Hence no `baseQualify` is threaded into the descent (that single-source-only
 * re-qualification would be redundant here, and there is no single base-table
 * correlation name to use against a two-source join body).
 */
function substituteViewColumns(
	ctx: PlanningContext,
	expr: AST.Expression,
	viewColToBaseRef: ReadonlyMap<string, AST.Expression>,
	view: MutableViewLike,
): AST.Expression {
	const viewName = view.name.toLowerCase();
	const descend = makeViewColumnDescend(ctx, viewColToBaseRef, view.name, view);
	return transformExpr(expr, (col) => {
		if (col.table && col.table.toLowerCase() !== viewName) return undefined;
		const repl = viewColToBaseRef.get(col.name.toLowerCase());
		return repl ? cloneExpr(repl) : undefined;
	}, descend);
}

/**
 * Strip the owning side's alias qualifier from a base-term assignment value (so
 * it targets the single-table UPDATE directly), rejecting any reference to the
 * other side (which a single-table SET cannot express). The strip is threaded
 * into any subquery embedded in the value (the qualifier rule is purely about a
 * column's own table qualifier, so it applies uniformly at every nesting depth);
 * a nested owning-side reference is correlated to the target row of the lowered
 * UPDATE just like a top-level one.
 */
function stripSideQualifier(
	expr: AST.Expression,
	view: MutableViewLike,
	owning: JoinSide,
	other: JoinSide,
): AST.Expression {
	const owningQuals = new Set([owning.alias, owning.schema.name.toLowerCase()]);
	const otherQuals = new Set([other.alias, other.schema.name.toLowerCase()]);
	const substitute = (col: AST.ColumnExpr): AST.Expression | undefined => {
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
	};
	return transformExpr(expr, substitute, (q) => mapQueryExprUniform(q, substitute));
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

/**
 * RETURNING through a multi-source **insert** is not yet supported: it would need
 * the per-row minted shared surrogate threaded into the projected rows, which the
 * envelope materialization does not yet expose to a RETURNING projection. Reject
 * with a structured diagnostic (single- and multi-source update/delete RETURNING
 * are supported; see the builder).
 */
function rejectReturning(view: MutableViewLike, returning: AST.ResultColumn[] | undefined): void {
	if (returning && returning.length > 0) {
		raiseMutationDiagnostic({
			reason: 'returning-through-view',
			table: view.name,
			message: `RETURNING through a multi-source (join) insert into view '${view.name}' is not yet supported`,
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
