import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { TableSchema } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type TableDescriptor } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { PhysicalType } from '../../types/logical-type.js';
import { TableReferenceNode } from '../nodes/reference.js';
import { InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import { analyzeBodyLineage } from './backward-body.js';
import { buildExpression } from '../building/expression.js';
import { JoinNode } from '../nodes/join-node.js';
import { FilterNode } from '../nodes/filter.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { combineAnd, makeViewColumnDescend, assertTopLevelViewColumns, raiseUnknownViewColumn } from './single-source.js';
import { transformExpr, cloneExpr, mapQueryExprUniform } from './scope-transform.js';
import { readPolicy, readDeleteVia, readTargetNames, readExcludeNames, type ReservedTagMap } from './mutation-tags.js';
import type { DeleteViaValue } from '../../schema/reserved-tags.js';

/**
 * Multi-source view-mediated DML decomposition — the **key-preserving inner
 * join** acceptance case of the view-mutation substrate (docs/view-updateability.md
 * § Per-Operator Semantics — Inner Join, § Multi-Base-Table Mutations).
 *
 * Scope (this phase): a view body that is a two-table **inner equi-join** of base
 * tables, written through with `update` / `delete`. The body is **planned once**
 * (`analyzeJoinView`); its `PhysicalProperties.updateLineage` (threaded by
 * `view-mutation-physical-lineage`) routes each output column to its owning base
 * table. Each per-base SET/value is still lowered to an AST `BaseOp` so the ordinary
 * base-table builders are reused verbatim (the documented lower-risk path — the base
 * builders stay untouched), but **row identification no longer round-trips through a
 * re-planned AST body**: every affected view row's base-PK identities are captured
 * ONCE up-front, built as plan nodes directly over the already-planned join body
 * (`Project_{k<side>}(Filter_{idPred}(joinNode))` — the derived backward walk the
 * docs name, § Round-Trip Laws and the Derived Backward Walk), materialized before
 * any base op fires, and each base op reads its identifying values back from that
 * `__vmupd_keys` set:
 *
 * ```sql
 * -- view: select j1.id as id, j1.a as a, j2.c as c
 * --       from tj1 j1 join tj2 j2 on j2.id = j1.t2id
 * update jv set a = 5, c = 9 where id = 3
 *   -- capture (plan nodes over the planned join body, materialized once):
 *   --   __vmupd_keys = π_{j1.id as k0, j2.id as k1}( σ_{id = 3}( tj1 ⋈ tj2 ) )
 *   ->  update tj1 set a = 5 where id in (select k0 from __vmupd_keys)
 *       update tj2 set c = 9 where id in (select k1 from __vmupd_keys)
 * ```
 *
 * The capture reconstructs the row-identifying predicate (each owning side's base PK)
 * from the planned join body — exactly the predicate the optimizer already proves a
 * key over — so a side whose own PK is hidden by the projection (`tj2.id` above) is
 * still addressable, and a both-sides write is mutation-order-independent (the
 * FK-parent op cannot rewrite a predicate column out from under the FK-child op).
 * UPDATE RETURNING re-queries the same planned `joinNode` (post-mutation, restricted
 * to the captured identities); DELETE RETURNING projects the planned body `root` (the
 * `pre` OLD image). The body is planned once and reused — no second `buildSelectStmt`
 * / `cloneFromClause` of it for identification or RETURNING.
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

/**
 * The shared identity-capture CTE name + its `(k0, k1)` column names for a
 * multi-source UPDATE / multi-side DELETE fan-out. Each affected view row's base-PK
 * identities are materialized ONCE — *before* any base op fires — into
 * `rctx.tableContexts` under a shared descriptor. When more than one base op runs
 * against live state (an update assigning **both** sides, or a lenient delete fanned
 * out to both candidate sides) each per-side base op reads its identifying values
 * back from this set (`<pk> in (select k<side> from __vmupd_keys)`) instead of a live
 * re-query of the join body, so the first op cannot empty the join — or rewrite a
 * predicate column — out from under the second op's identifying subquery (a
 * mutation-order-independent identity). The same capture backs the UPDATE RETURNING
 * re-query (docs/view-updateability.md § Inner Join, § `returning`).
 */
export const MS_UPDATE_KEYS_CTE = '__vmupd_keys';
export const MS_UPDATE_KEY_COLUMNS = ['k0', 'k1'] as const;

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
	/**
	 * True for a `base` lineage site — an identity/rename projection OR a
	 * non-identity invertible transform (`inverse` present). Writable on update: an
	 * `inverse` column lowers its assigned value through {@link inverse} (§ Scalar
	 * Invertibility). A `computed` / `null-extended` site is read-only (`false`).
	 */
	readonly writable: boolean;
	/**
	 * Backward inverse closure for a non-identity invertible base site — maps a
	 * *written* (view-domain) value to the base column's value (e.g. `cv + 1` ⇒
	 * `w ↦ w - 1`). Absent for an identity/rename column. Insert through such a
	 * column is NOT supported (the shared-surrogate envelope writes raw values) —
	 * see {@link analyzeMultiSourceInsert}.
	 */
	readonly inverse?: (written: AST.Expression) => AST.Expression;
	/**
	 * Domain predicate (base terms) an `inverse` profile restricts to; conjoined
	 * into the row-identifying predicate on update (§ Scalar Invertibility). No
	 * shipped profile produces one yet (`x ± k` is unrestricted), so it is
	 * currently always absent.
	 */
	readonly domain?: AST.Expression;
}

export interface JoinViewAnalysis {
	readonly sel: AST.SelectStmt;
	/** The two base-table sides, in AST source order. */
	readonly sides: readonly [JoinSide, JoinSide];
	/** View column name (lowercased) -> its base-term replacement expression. */
	readonly viewColToBaseRef: ReadonlyMap<string, AST.Expression>;
	readonly outColumns: readonly OutColumn[];
	/**
	 * The planned view body (the source of `updateLineage`). Reused by the DELETE
	 * RETURNING re-query (the OLD view image, projected `pre` over `root`) — so the
	 * body is planned **once** rather than re-expanded through the view name.
	 */
	readonly root: RelationalPlanNode;
	/**
	 * The raw `JoinNode` inside {@link root} (the ON-condition join, *before* the
	 * body's σ/projection). The capture's identifying relation and the UPDATE
	 * RETURNING re-query are built directly on top of it (Filter + Project plan
	 * nodes) instead of re-planning a cloned AST body — the derived backward walk
	 * the docs name (§ Round-Trip Laws and the Derived Backward Walk).
	 */
	readonly joinNode: JoinNode;
	/**
	 * The join's combined column scope (`ctx.outputScopes.get(joinNode)`), which
	 * resolves both alias-qualified (`j1.id`) and unqualified base columns — the
	 * exact scope `buildSelectStmt` used when planning the body. Reused to build the
	 * identifying predicate / PK projections / RETURNING columns as `ScalarPlanNode`s
	 * over {@link joinNode}, so resolution is byte-identical to the retired re-plan.
	 */
	readonly joinScope: Scope;
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

	// Supplied view columns: the explicit list, or every IDENTITY-writable view
	// output column. An `inverse`-profile column (writable on the UPDATE path) is
	// NOT insertable here — the shared-surrogate envelope writes supplied values to
	// base columns verbatim, with no hook to apply the column's inverse, so an
	// inserted `cv1` would land raw in `cv`. Excluding it from the implicit set lets
	// it fall to its base default / not-null check (the pre-inverse behavior); an
	// explicit supply is rejected below.
	const suppliedNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: outColumns.filter(c => c.writable && !c.inverse).map(c => c.name);

	interface Supplied { readonly name: string; readonly sideIndex: number; readonly baseColumn: string; readonly type: ScalarType; readonly isKey: boolean; }
	const supplied: Supplied[] = suppliedNames.map((rawName): Supplied => {
		const name = rawName.toLowerCase();
		const out = outColumns.find(c => c.name === name);
		if (!out || !out.writable || out.inverse || out.sideIndex === undefined || !out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: rawName,
				table: view.name,
				message: `cannot insert through view '${view.name}': column '${rawName}' is computed (non-invertible), a transformed (invertible) column, or not a base column, so it cannot receive an inserted value`,
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

export function analyzeJoinView(ctx: PlanningContext, view: MutableViewLike): JoinViewAnalysis {
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

	// Explicit projections only: a `select *` over a join is rejected here (before
	// the shared backward read) so it surfaces the join-specific diagnostic rather
	// than the generic projection/attribute arity mismatch (column→base routing
	// relies on a 1:1 projection list).
	if (sel.columns.some(c => c.type === 'all')) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': list the join's output columns explicitly (a 'select *' join body is not yet decomposable)`,
		});
	}

	// Plan the body ONCE and read its threaded `updateLineage` through the shared
	// backward-walk consumer (`analyzeBodyLineage`) — the same n-way reader the
	// decomposition fan-out consumes (§ Round-Trip Laws and the Derived Backward
	// Walk). The raw JoinNode + its column scope and the per-side routing layer on
	// top.
	const { root, tableRefsById, viewColToBaseRef, columns } = analyzeBodyLineage(ctx, view);

	// The raw JoinNode + its combined column scope, captured from the SINGLE plan of
	// the body above. The identity capture and RETURNING re-query build their
	// identifying / projection plan nodes directly on top of these (no AST re-plan of
	// the join body for row identification — § Round-Trip Laws and the Derived
	// Backward Walk). `joinScope` is the exact scope `buildSelectStmt` resolved the
	// body's own predicate/projections against (set into `ctx.outputScopes` during
	// `buildJoin`), so reusing it makes base-term resolution byte-identical to the
	// retired re-plan.
	const joinNode = findJoinNode(view, root);
	const joinScope = ctx.outputScopes.get(joinNode);
	if (!joinScope) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the planned join body did not expose a resolvable column scope`,
		});
	}

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

	// Route each shared backward column onto its owning join side. An inner-join body
	// never null-extends, so `nullExtended` is always false for the multi-source
	// acceptance shape (it is the defensive guard the n-way reader needs for the
	// decomposition outer-joined optional members).
	const outColumns: OutColumn[] = columns.map((bc): OutColumn => {
		if (bc.baseTableId !== undefined && bc.baseColumn !== undefined) {
			const sideIndex = sideByTableId.get(bc.baseTableId);
			return {
				name: bc.name,
				displayName: bc.displayName,
				sideIndex,
				baseColumn: bc.baseColumn,
				writable: sideIndex !== undefined && !bc.nullExtended,
				...(bc.inverse ? { inverse: bc.inverse } : {}),
				...(bc.domain ? { domain: bc.domain } : {}),
			};
		}
		return { name: bc.name, displayName: bc.displayName, writable: false };
	});

	return { sel, sides, viewColToBaseRef, outColumns, root, joinNode, joinScope };
}

/**
 * The single `JoinNode` inside a planned two-table inner-join body. The body is a
 * `select <cols> from <a join b on p> [where w]`, so its plan is
 * `Project(Filter?(Join))` — there is exactly one join. Walks relations from the
 * root, returning the outermost (only) `JoinNode`. Reused (not re-planned) as the
 * source the identifying-capture / RETURNING relations build on.
 */
function findJoinNode(view: MutableViewLike, root: PlanNode): JoinNode {
	let found: JoinNode | undefined;
	const visit = (n: PlanNode): void => {
		if (found) return;
		if (n instanceof JoinNode) { found = n; return; }
		for (const child of n.getRelations()) visit(child);
	};
	visit(root);
	if (!found) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': the planned body did not contain a join node`,
		});
	}
	return found;
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

/**
 * Scope guard for the multi-source path — parity with the single-source spine
 * (`single-source.ts` § `assertTopLevelViewColumns`). A top-level `where` / `set`
 * reference that is not a join-view output column would otherwise pass through
 * `substituteViewColumns` unmapped and re-bind against a base table in the
 * identifying subquery's join body (the same encapsulation leak). `outColumns`
 * already enumerates every projected view column (computed ones included, marked
 * non-writable), so it is the view's exposed column set.
 */
function guardTopLevelScope(expr: AST.Expression, analysis: JoinViewAnalysis, view: MutableViewLike): void {
	assertTopLevelViewColumns(
		expr,
		new Set(analysis.outColumns.map(c => c.name)),
		analysis.outColumns.map(c => c.displayName),
		view,
	);
}

// --- UPDATE ---------------------------------------------------------------

export function decomposeUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.UpdateStmt, tags?: ReservedTagMap): BaseOp[] {
	// RETURNING through a multi-source update is supported, but the rows are not
	// recoverable from the per-side base ops (the view row spans both tables), so
	// the builder (`view-mutation-builder.ts`) supplies them via a re-query of the
	// planned join body; the base ops themselves carry no RETURNING.

	// `target` / `exclude` narrow the writable base set (compose AFTER predicate
	// dispatch — they only restrict, never broaden). For an update the side set is
	// already pinned per-assignment by lineage, so the tag acts as a guard: an
	// assignment to an excluded side is a structured conflict, not a silent drop.
	const allowedSides = applyTargetExclude([0, 1], analysis.sides, tags, view);

	// Scope guard: top-level `where` references must name view columns (parity with
	// the single-source spine — a base-only name must not leak through the join body).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);

	// Route each assignment to its owning base side.
	const perSide: Array<{ column: string; value: AST.Expression }[]> = [[], []];
	for (const asg of stmt.assignments) {
		const out = analysis.outColumns.find(c => c.name === asg.column.toLowerCase());
		if (!out) {
			// Not a view column at all — the same encapsulation-leak guard as the
			// top-level `where` scan (distinct from a computed view column below).
			raiseUnknownViewColumn(asg.column, view, analysis.outColumns.map(c => c.displayName));
		}
		if (!out.writable || out.sideIndex === undefined || !out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': column '${asg.column}' is a computed (non-invertible) expression and is read-only`,
			});
		}
		// The assigned VALUE's top-level references must name view columns too (parity
		// with the single-source spine). On a single-table side a base-only name would
		// otherwise re-bind in that table; across sides it would fail to resolve with a
		// generic error — the structured guard makes the diagnostic uniform either way.
		guardTopLevelScope(asg.value, analysis, view);
		const side = analysis.sides[out.sideIndex];
		const other = analysis.sides[1 - out.sideIndex];
		// Rewrite the assigned value into base terms, then strip the owning side's
		// qualifier (the base UPDATE targets that table directly). A reference to
		// the other side cannot be expressed as a single-table SET — reject.
		const baseValue = stripSideQualifier(
			substituteViewColumns(ctx, asg.value, analysis.viewColToBaseRef, view),
			view, side, other,
		);
		// For an `inverse`-profile column the assigned value is in the VIEW domain;
		// apply the site's inverse to recover the BASE value (`cv1 = cv + 1` ⇒ the
		// write `cv1 = w` stores `cv = w - 1`). The base-term substitution + side-
		// qualifier strip above already produced the written value in base terms; the
		// inverse wraps that last (it expects a value already in base terms).
		const written = out.inverse ? out.inverse(baseValue) : baseValue;
		perSide[out.sideIndex].push({ column: out.baseColumn, value: written });
		// NB: a present `out.domain` (an `inverse`-profile restriction) would conjoin
		// into the identifying predicate. No shipped invertibility profile produces a
		// domain (`x ± k` is unrestricted over integers), and the capture path that now
		// backs EVERY side's identification (`__vmupd_keys`) does not yet thread
		// per-assignment domains — deferred uniformly until a domain-bearing profile
		// lands (§ Scalar Invertibility).
	}

	// Every affected view row's base-PK identities are captured ONCE up-front (before
	// any base op fires) and each per-side op reads its identifying values back from
	// that captured set (`<pk> in (select k<side> from __vmupd_keys)`), a
	// mutation-order-independent identity built from the ALREADY-planned join body
	// (the builder materializes the capture; see `buildMultiSourceKeyCapture`). This
	// unifies the single-side and both-sides paths onto the same identity (no live
	// re-query of a re-planned AST body): a both-sides update's FK-parent op can no
	// longer rewrite a predicate column out from under the FK-child op, and a
	// single-side op — having no ordering hazard — reads the same pre-mutation set it
	// would have re-queried live.

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
			subquery: buildCapturedKeySubquery(sideIndex),
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

/**
 * `select k<sideIndex> from __vmupd_keys` — read this side's captured base-PK
 * identities back from the up-front materialized key set (the both-sides-assigned
 * UPDATE path and the multi-side DELETE fan-out; see {@link MS_UPDATE_KEYS_CTE}). The
 * builder injects `__vmupd_keys` into the base op's planning `cteNodes` (resolving to
 * the context-backed key relation), so this is read by descriptor rather than
 * re-querying the join body.
 */
function buildCapturedKeySubquery(sideIndex: number): AST.SelectStmt {
	return {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'column', name: MS_UPDATE_KEY_COLUMNS[sideIndex] } }],
		from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE } }],
	};
}

// --- identity capture (shared by both-sides UPDATE / multi-side DELETE base ops + UPDATE RETURNING) ---

/**
 * The up-front base-PK identity capture for a multi-source (two-table inner-join)
 * UPDATE or multi-side DELETE fan-out (docs/view-updateability.md § Inner Join,
 * § `returning`). Built ONCE and shared between the multi-side base ops' identifying
 * subqueries and (for an UPDATE with RETURNING) the RETURNING re-query.
 *
 *  - `source`: the capture SELECT `select s0.pk0 as k0, s1.pk1 as k1 from <body>
 *    where <idPredicate>` — the emitter materializes it into `rctx.tableContexts`
 *    under {@link descriptor} **before** any base op runs.
 *  - `descriptor`: the identity stitch shared between the materialized capture rows
 *    and every {@link InternalRecursiveCTERefNode} that reads them back.
 *  - `keyColumns`: the `(k0, k1)` column shape each reader mints a key ref over.
 */
export interface MultiSourceKeyCapture {
	readonly source: RelationalPlanNode;
	readonly descriptor: TableDescriptor;
	readonly keyColumns: readonly { readonly name: string; readonly type: ScalarType }[];
}

/**
 * Mint a context-backed key relation (`InternalRecursiveCTERefNode`) over a
 * capture's descriptor — what a multi-side base op's identifying `in`-subquery or
 * the RETURNING re-query's EXISTS scans `__vmupd_keys` through. Fresh attribute ids
 * per call (each ref lives in its own subtree); the **descriptor** identity is what
 * ties it to the rows the emitter materializes.
 */
export function makeMultiSourceKeyRef(scope: Scope, capture: MultiSourceKeyCapture): InternalRecursiveCTERefNode {
	const keyAttrs: Attribute[] = capture.keyColumns.map(c => ({
		id: PlanNode.nextAttrId(),
		name: c.name,
		type: c.type,
		sourceRelation: MS_UPDATE_KEYS_CTE,
	}));
	const keyRelType: RelationType = {
		typeClass: 'relation',
		isReadOnly: true,
		isSet: false,
		columns: capture.keyColumns.map(c => ({ name: c.name, type: c.type })),
		keys: [],
		rowConstraints: [],
	};
	return new InternalRecursiveCTERefNode(scope, MS_UPDATE_KEYS_CTE, keyAttrs, keyRelType, capture.descriptor);
}

/**
 * Build the up-front identity capture: each affected view row's base-PK identities,
 * by the same identifying predicate the base ops route on (user WHERE → base ∧ body
 * WHERE). Built as **plan nodes directly over the ALREADY-planned join body**
 * (`analysis.joinNode` + `analysis.joinScope`) — `Project_{k<side>}(Filter_{idPred}
 * (joinNode))` — instead of re-planning a cloned AST FROM, so the body is planned
 * ONCE (§ Round-Trip Laws and the Derived Backward Walk). `preserveInputColumns=false`
 * ⇒ the materialized rows are exactly the requested key columns, positionally aligned
 * to the `k<side>` columns every reader scans back (`keyColumns` and the projection
 * derive from the same `sideIndices` order).
 *
 * `sideIndices` selects which sides' PKs to capture (each requires a single-column PK
 * via {@link requireSingleColumnPk}; a composite-PK *requested* side is rejected with
 * `unsupported-join`). The builder passes exactly the sides whose base ops read the
 * capture (plus both, for an UPDATE with RETURNING whose EXISTS needs `(k0, k1)`), so
 * a single-side write never forces a single-column PK on the untouched side.
 *
 * Op-agnostic: takes the user `where` directly (an UPDATE's or a DELETE's) — the
 * identifying predicate is the same either way.
 */
export function buildMultiSourceKeyCapture(
	ctx: PlanningContext,
	view: MutableViewLike,
	where: AST.Expression | undefined,
	analysis: JoinViewAnalysis,
	sideIndices: readonly number[],
): MultiSourceKeyCapture {
	// The identifying predicate (user WHERE → base terms ∧ the body's own WHERE), built
	// as a ScalarPlanNode over the planned join body's own scope — the exact scope
	// `buildSelectStmt` resolved the body against. The body WHERE is conjoined
	// explicitly (the source is the raw `joinNode`, before the body's σ), so the
	// captured set is byte-identical to the retired re-plan over the cloned FROM.
	const idPredicateAst = buildIdentifyingPredicate(ctx, analysis, where, view);
	const predicate = idPredicateAst
		? buildExpression({ ...ctx, scope: analysis.joinScope }, idPredicateAst)
		: undefined;
	const filtered: RelationalPlanNode = predicate
		? new FilterNode(analysis.joinScope, analysis.joinNode, predicate)
		: analysis.joinNode;

	const keyColumns: { name: string; type: ScalarType }[] = [];
	const projections: Projection[] = sideIndices.map((i): Projection => {
		const side = analysis.sides[i];
		const pk = requireSingleColumnPk(view, side);
		keyColumns.push({ name: MS_UPDATE_KEY_COLUMNS[i], type: columnScalarType(columnByName(side.schema, pk)) });
		return {
			node: buildExpression({ ...ctx, scope: analysis.joinScope }, { type: 'column', name: pk, table: side.alias }),
			alias: MS_UPDATE_KEY_COLUMNS[i],
		};
	});
	const source = new ProjectNode(analysis.joinScope, filtered, projections, undefined, undefined, false);

	return { source, descriptor: {}, keyColumns };
}

/**
 * Build the post-mutation RETURNING re-query for a multi-source UPDATE
 * (docs/view-updateability.md § `returning`). A re-query that matched by the *user
 * predicate* cannot recapture a row whose predicate column the update itself
 * rewrote (the changed row no longer matches), so this matches by the captured
 * **identity** instead: project the view-spelled, base-term RETURNING columns over
 * the post-mutation join body, restricted to the captured identities by `exists
 * (select 1 from __vmupd_keys k where k.k0 = s0.pk0 and k.k1 = s1.pk1)` — so a row
 * the update pushed *out* of the view's filter (or whose predicate column it
 * rewrote) is still returned (single-source NEW semantics). It keeps only the
 * structural join ON-condition; the body/user WHERE is intentionally NOT re-applied.
 *
 * Reads the shared {@link MultiSourceKeyCapture} the builder materializes
 * before the base ops fire (via its own freshly-minted key ref over the same
 * descriptor).
 */
export function buildMultiSourceUpdateReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.UpdateStmt,
	capture: MultiSourceKeyCapture,
	analysis: JoinViewAnalysis,
): RelationalPlanNode {
	const returningCols = stmt.returning!;
	const [side0, side1] = analysis.sides;
	const pk0 = requireSingleColumnPk(view, side0);
	const pk1 = requireSingleColumnPk(view, side1);

	// Restrict the POST-mutation join body to the captured identities, built as plan
	// nodes over the ALREADY-planned `joinNode` (its structural ON-condition only —
	// the body/user WHERE is intentionally NOT re-applied) — no AST re-plan of the
	// body. The EXISTS subquery resolves `__vmupd_keys` via `cteNodes` to a fresh key
	// ref over the shared capture descriptor; `s0.pk0` / `s1.pk1` correlate to the
	// outer join row through `joinScope`.
	const keyRef = makeMultiSourceKeyRef(ctx.scope, capture);
	const existsPredicateAst: AST.Expression = {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
			where: combineAnd(
				{ type: 'binary', operator: '=', left: { type: 'column', name: 'k0', table: 'k' }, right: { type: 'column', name: pk0, table: side0.alias } },
				{ type: 'binary', operator: '=', left: { type: 'column', name: 'k1', table: 'k' }, right: { type: 'column', name: pk1, table: side1.alias } },
			),
		},
	};
	const cteNodes = new Map(ctx.cteNodes ?? []);
	cteNodes.set(MS_UPDATE_KEYS_CTE, keyRef);
	const existsNode = buildExpression({ ...ctx, scope: analysis.joinScope, cteNodes }, existsPredicateAst);
	const filtered = new FilterNode(analysis.joinScope, analysis.joinNode, existsNode);

	// Project the view-spelled, base-term RETURNING columns over the filtered join.
	return buildMultiSourceReturningProjection(ctx, view, analysis, filtered, returningCols);
}

/**
 * Build the multi-source RETURNING projection over a `filtered` join relation: lower
 * each RETURNING result column to its view-spelled, base-term form
 * ({@link buildReturningProjection}) and project it as a `ScalarPlanNode` over the
 * input through `analysis.joinScope`. `preserveInputColumns=false` ⇒ the output is
 * exactly the RETURNING columns. Shared by the UPDATE re-query (filter = the
 * post-mutation EXISTS-over-capture join) and the DELETE re-query (filter = the
 * pre-mutation identifying predicate over the raw join), which differ only in the
 * `filtered` input relation they pass.
 */
function buildMultiSourceReturningProjection(
	ctx: PlanningContext,
	view: MutableViewLike,
	analysis: JoinViewAnalysis,
	filtered: RelationalPlanNode,
	returningCols: readonly AST.ResultColumn[],
): RelationalPlanNode {
	const projections: Projection[] = buildReturningProjection(ctx, view, analysis, returningCols).map((rc): Projection => {
		const col = rc as AST.ResultColumnExpr;
		return {
			node: buildExpression({ ...ctx, scope: analysis.joinScope }, col.expr),
			alias: col.alias,
		};
	});
	return new ProjectNode(analysis.joinScope, filtered, projections, undefined, undefined, false);
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
			// Scope guard: a top-level RETURNING reference must name a view column —
			// otherwise it would pass through `substituteViewColumns` unmapped and
			// re-bind against a base table in the re-query's join body (the same leak
			// the where/set guard closes). Parity with the single-source RETURNING guard.
			guardTopLevelScope(rc.expr, analysis, view);
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

/**
 * Build the pre-mutation RETURNING re-query for a multi-source DELETE
 * (docs/view-updateability.md § `returning`). The OLD view image of the rows about
 * to vanish: project the view-spelled, base-term RETURNING columns over the raw
 * `analysis.joinNode` restricted to the identifying predicate (user WHERE → base ∧
 * body WHERE — the same predicate the key capture and base ops route on). Captured
 * `pre` (before the base ops fire) so it reads the live base tables through the join.
 *
 * Building the projection in **base terms** (rather than referencing the planned
 * body `root`'s output attribute ids) is what fixes a computed view column: a
 * computed column has no surviving intermediate attribute id after project-merge, so
 * a by-id reference dangles — recomputing from base columns has nothing fragile to
 * reference. Mirrors {@link buildMultiSourceUpdateReturning}; they differ only in the
 * filter + timing.
 */
export function buildMultiSourceDeleteReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.DeleteStmt,
	analysis: JoinViewAnalysis,
): RelationalPlanNode {
	const idPredicateAst = buildIdentifyingPredicate(ctx, analysis, stmt.where, view);
	const predicate = idPredicateAst
		? buildExpression({ ...ctx, scope: analysis.joinScope }, idPredicateAst)
		: undefined;
	const filtered: RelationalPlanNode = predicate
		? new FilterNode(analysis.joinScope, analysis.joinNode, predicate)
		: analysis.joinNode;
	return buildMultiSourceReturningProjection(ctx, view, analysis, filtered, stmt.returning!);
}

export function decomposeDelete(ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.DeleteStmt, tags?: ReservedTagMap): BaseOp[] {
	// RETURNING through a multi-source delete is supported via a re-query of the
	// planned view body captured *before* the base delete fires (the builder); the
	// base op itself carries no RETURNING.

	// Scope guard: top-level `where` references must name view columns (parity with
	// the single-source spine).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);

	const sides = chooseDeleteSides(view, analysis, tags);

	// Every base delete (single-side and multi-side fan-out alike) reads its
	// identifying values from the up-front identity capture the builder materializes
	// ONCE before any base op fires (`<pk> in (select k<side> from __vmupd_keys)`), a
	// mutation-order-independent set built from the ALREADY-planned join body. So the
	// first side's delete cannot empty the join out from under the second side's
	// identifying set (the predicate-honest multi-side fan-out), and a single-side
	// delete — having no ordering hazard — reads the same pre-mutation set it would
	// have re-queried live. (No live re-query of a re-planned AST body.)

	// Order the base deletes. The two-side fan-out (reached only when no single-
	// direction FK is provable — `fkChildIndex` is undefined, i.e. no FK or a mutual
	// FK) orders by ON DELETE action so the side whose removal clears the other's
	// reference runs first (`orderDeleteFanout`); a mutual FK whose actions no side
	// order can satisfy under immediate enforcement raises `mutual-fk-restrict-delete`
	// at plan time rather than letting the raw transitive-FK error surface at runtime.
	// A single-side delete has no ordering hazard, so it keeps its trivial order.
	let order: readonly number[];
	if (sides.length === 2) {
		const fanoutOrder = orderDeleteFanout(analysis.sides);
		if (fanoutOrder === undefined) {
			const [a, b] = analysis.sides;
			raiseMutationDiagnostic({
				reason: 'mutual-fk-restrict-delete',
				table: view.name,
				message: `cannot delete through view '${view.name}': the joined row spans a mutual foreign key ('${a.schema.name}'↔'${b.schema.name}') whose ON DELETE actions cannot be satisfied in either order under immediate FK enforcement (deleting either side trips the other's RESTRICT, directly or transitively through a cascade); break the cycle outside the view — null out the referencing column(s) first, or restructure the offending ON DELETE action — before deleting through the view (a 'deferrable initially deferred' declaration does not help: RESTRICT is enforced immediately regardless)`,
			});
		}
		order = fanoutOrder;
	} else {
		order = sides;
	}
	const ops: BaseOp[] = [];
	for (const sideIndex of order) {
		const side = analysis.sides[sideIndex];
		const pk = requireSingleColumnPk(view, side);
		const where: AST.InExpr = {
			type: 'in',
			expr: { type: 'column', name: pk },
			subquery: buildCapturedKeySubquery(sideIndex),
		};
		const statement: AST.DeleteStmt = {
			type: 'delete',
			table: tableIdentifier(side.schema),
			where,
			contextValues: stmt.contextValues,
			schemaPath: stmt.schemaPath,
			loc: stmt.loc,
		};
		ops.push({ table: side.table, op: 'delete', statement });
	}
	return ops;
}

/**
 * Pick the base side(s) a join delete routes to (§ Inner Join — Deletes). Deleting
 * one side of an inner equi-join already removes the joined row from the view, so the
 * common case resolves to a single side; the maximal-lenient case fans out to every
 * candidate side ("make this joined row not exist"). Returns 1 or 2 sides.
 *
 * Resolution order (tags compose AFTER predicate dispatch — they only restrict):
 * 1. `target` / `exclude` narrow the candidate sides (`tag-target-not-found` on
 *    an unknown name; `tag-conflict` if they remove every side).
 * 2. An explicit `delete_via` picks a single side directly (`parent` → the FK-parent,
 *    `left_delete` → the left source); it must lie within the candidates.
 * 3. Otherwise the **default**: if `target`/`exclude` already left exactly one side,
 *    that side. Else if a foreign key proves the FK-many (child) side, that single
 *    side (deleting the child leaves the parent — the documented FK-style default;
 *    the FK resolves the ambiguity, so it is NOT a fan-out). Else the deletion side is
 *    ambiguous: `policy=strict` rejects it with a `policy-strict-ambiguity`
 *    diagnostic; the default `lenient` policy **fans out to every candidate side**
 *    (the predicate-honest multi-side delete — see {@link decomposeDelete}'s eager
 *    key capture).
 */
function chooseDeleteSides(view: MutableViewLike, analysis: JoinViewAnalysis, tags?: ReservedTagMap): number[] {
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
		return [picked];
	}

	if (candidates.length === 1) return candidates;

	const policy = readPolicy(tags);
	if (policy === 'strict') {
		raiseMutationDiagnostic({
			reason: 'policy-strict-ambiguity',
			table: view.name,
			message: `cannot delete through view '${view.name}': the deletion side is ambiguous and 'quereus.update.policy' = 'strict' forbids guessing; pin it with 'quereus.update.delete_via' or 'quereus.update.target'`,
		});
	}

	const childIndex = fkChildIndex(analysis.sides);
	if (childIndex !== undefined && candidates.includes(childIndex)) return [childIndex];

	// lenient + 2 residual candidates + no provable single-direction FK + no side tag:
	// fan out to every candidate side. Reached only when `fkChildIndex` is undefined
	// (no FK, or a mutual-FK edge), so the candidate list is both sides.
	return candidates;
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

/**
 * The governing ON DELETE action of FK(s) declared on `child` that reference
 * `parent` — i.e. the action that fires when a `parent` row is deleted. When more
 * than one such FK runs between the same ordered pair, the **most-blocking** action
 * governs (immediate enforcement fires every referencing FK): `restrict` over
 * `cascade` over `setNull`/`setDefault` over absent (`undefined` — no FK on `child`
 * references `parent`). Mirrors the FK-match predicate in {@link fkChildIndex} (same
 * `referencedTable` / `referencedSchema` comparison).
 */
function inboundDeleteAction(child: JoinSide, parent: JoinSide): AST.ForeignKeyAction | undefined {
	const parentName = parent.schema.name.toLowerCase();
	const parentSchema = parent.schema.schemaName.toLowerCase();
	let governing: AST.ForeignKeyAction | undefined;
	for (const fk of child.schema.foreignKeys ?? []) {
		if (fk.referencedTable.toLowerCase() !== parentName) continue;
		if ((fk.referencedSchema ?? child.schema.schemaName).toLowerCase() !== parentSchema) continue;
		if (fk.onDelete === 'restrict') return 'restrict';        // most-blocking — governs outright
		if (fk.onDelete === 'cascade') governing = 'cascade';
		else if (governing !== 'cascade') governing = fk.onDelete;  // setNull / setDefault, unless a cascade already won
	}
	return governing;
}

/**
 * True when deleting side `X` first (then the other side `Y`) does **not** abort
 * under immediate FK enforcement + the transitive RESTRICT pre-walk
 * (`runtime/foreign-key-actions.ts` `assertTransitiveRestrictsForParentMutation`).
 * `inboundX` governs deleting X (the action of the FK referencing X); `inboundY`
 * governs deleting Y. Deleting X first is feasible iff X carries no inbound
 * reference, or its inbound action *clears* Y's reference without tripping a RESTRICT:
 *  - `inboundX` absent — nothing references X, so its delete is unconstrained;
 *  - `inboundX ∈ {setNull, setDefault}` — Y's reference is cleared (no cascade, no RESTRICT);
 *  - `inboundX === cascade` **and** `inboundY !== restrict` — the cascade into Y does
 *    not recurse into a RESTRICT (Y's only inbound child here is X, the root, via `inboundY`).
 * `inboundX === restrict` ⇒ Y still references X ⇒ NOT deletable-first.
 */
function deletableFirst(inboundX: AST.ForeignKeyAction | undefined, inboundY: AST.ForeignKeyAction | undefined): boolean {
	if (inboundX === undefined) return true;
	if (inboundX === 'setNull' || inboundX === 'setDefault') return true;
	return inboundX === 'cascade' && inboundY !== 'restrict';
}

/**
 * The feasible base-delete order for the two-side DELETE fan-out, or `undefined`
 * when a mutual FK's ON DELETE actions cannot be satisfied in *any* order under
 * immediate enforcement (the caller raises `mutual-fk-restrict-delete`). Reached
 * only at `fkChildIndex(sides) === undefined` (no FK either way, or a mutual FK): a
 * no-FK pair has both inbound actions absent ⇒ side0 deletable-first ⇒ `[0, 1]`
 * (unchanged); a both-cascade mutual FK likewise keeps `[0, 1]`. Prefers `[0, 1]`
 * when side0 is deletable-first so the no-FK / symmetric paths stay order-stable.
 */
function orderDeleteFanout(sides: readonly [JoinSide, JoinSide]): readonly number[] | undefined {
	const inbound0 = inboundDeleteAction(sides[1], sides[0]); // governs deleting side0
	const inbound1 = inboundDeleteAction(sides[0], sides[1]); // governs deleting side1
	if (deletableFirst(inbound0, inbound1)) return [0, 1];
	if (deletableFirst(inbound1, inbound0)) return [1, 0];
	return undefined;
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
