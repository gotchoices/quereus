import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import type { Scope } from '../scopes/scope.js';
import type { TableSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { resolveReferencedColumns } from '../../schema/table.js';
import type { ColumnSchema } from '../../schema/column.js';
import { PlanNode, type RelationalPlanNode, type Attribute, type TableDescriptor } from '../nodes/plan-node.js';
import type { RelationType, ScalarType } from '../../common/datatype.js';
import { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';
import { InternalRecursiveCTERefNode } from '../nodes/internal-recursive-cte-ref-node.js';
import { analyzeBodyLineage } from './backward-body.js';
import { buildExpression } from '../building/expression.js';
import { JoinNode } from '../nodes/join-node.js';
import { FilterNode } from '../nodes/filter.js';
import { ProjectNode, type Projection } from '../nodes/project-node.js';
import { raiseMutationDiagnostic } from './mutation-diagnostic.js';
import type { BaseOp, MutableViewLike, MutationRequest } from './propagate.js';
import { combineAnd, flattenAnd, makeViewColumnDescend, assertTopLevelViewColumns, raiseUnknownViewColumn } from './single-source.js';
import { transformExpr, cloneExpr, mapQueryExprUniform } from './scope-transform.js';
import { readPolicy, readDeleteVia, readTargetNames, readExcludeNames, type ReservedTagMap } from './mutation-tags.js';
import type { DeleteViaValue } from '../../schema/reserved-tags.js';

/**
 * Multi-source view-mediated DML decomposition — the **key-preserving join**
 * acceptance case of the view-mutation substrate (docs/view-updateability.md
 * § Per-Operator Semantics — Inner Join, § Outer Joins, § Multi-Base-Table Mutations).
 *
 * Scope: a view body that is an **n-way (≥2) equi-join** of base tables — `inner`,
 * `left`, `right`, or `full` — including composite-PK sides and **self-joins** (one base
 * table under two or more distinct aliases) — written through with `update` / `delete` /
 * `insert`. Outer joins are admitted for the **statically-expressible** cases:
 * preserved-side update passthrough, delete-to-the-preserved-side, and insert routing
 * (both-side / preserved-only / presence-gated non-preserved member). The one
 * outer-join case that needs new runtime — an UPDATE of a **non-preserved** column (a
 * per-row matched-update / null-extended-insert branch) — defers with
 * `unsupported-outer-join-update` (`view-write-optional-member-transitions`). The body is
 * **planned once**
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
 * Multi-source **`insert`** is analysed here (`analyzeMultiSourceInsert`) but *built* by
 * `building/view-mutation-builder.ts` (`buildMultiSourceInsert`), because it needs the
 * plan-level shared-surrogate envelope rather than an AST `BaseOp`: the shared join key is
 * not a view column, so it is sourced from the anchor key column's declared `default` once
 * per row at the envelope and threaded into the active base inserts via the equivalence
 * class (§ Mutation Context). For an outer join the **non-preserved** side is an *optional*
 * member of the fan-out — dropped when its columns are absent (the preserved-only insert),
 * presence-gated per row when supplied (the both-side insert).
 *
 * **Deferred, rejected here with a structured diagnostic:**
 * - UPDATE of a non-preserved outer-join column — `unsupported-outer-join-update`.
 * - INSERT of only non-preserved columns with no preserved anchor — `null-extended-create-conflict`.
 * - cross / set-op / aggregate / window bodies — `unsupported-*`.
 * - comma (implicit) joins, `select *` join bodies, and cross-side `set` value
 *   references — each a precise diagnostic.
 * - composite **shared-key insert** (the surrogate envelope threads a single-column
 *   key) — `unsupported-decomposition-key`. (Composite-PK *identification* on the
 *   update/delete capture path IS supported here; only the insert envelope's shared
 *   key stays single-column.)
 */

/**
 * The shared identity-capture CTE name for a multi-source (n-way inner-join) UPDATE /
 * multi-side DELETE fan-out. Each affected view row's base-PK identities are
 * materialized ONCE — *before* any base op fires — into `rctx.tableContexts` under a
 * shared descriptor. *Every* per-side base op reads its identifying values back from
 * this set via a correlated EXISTS (`exists (select 1 from __vmupd_keys k where
 * k.k<side>_<j> = <side>.<pk<j>> …)`) instead of a live re-query of the join body, so
 * the first op cannot empty the join — or rewrite a predicate column — out from under
 * a later op's identifying subquery (a mutation-order-independent identity). The same
 * capture backs the UPDATE RETURNING re-query (docs/view-updateability.md § Inner Join,
 * § `returning`).
 *
 * The capture relation carries one column **per side per PK column**, named
 * `k<sideIndex>_<pkColumnOrdinal>` ({@link keyColumnName}) — so a composite-PK side
 * contributes `k<side>_0, k<side>_1, …`. This flattened per-side-per-column shape is
 * what generalizes the substrate past the retired single-column `(k0, k1)` tuple.
 */
export const MS_UPDATE_KEYS_CTE = '__vmupd_keys';

/**
 * The capture column name for side `sideIndex`'s `j`-th PK column. A single-column-PK
 * side yields just `k<side>_0`; a composite-PK side yields `k<side>_0, k<side>_1, …`.
 */
export function keyColumnName(sideIndex: number, j: number): string {
	return `k${sideIndex}_${j}`;
}

// --- shape model ----------------------------------------------------------

/** One base-table side of the join. */
interface JoinSide {
	readonly table: TableReferenceNode;
	readonly schema: TableSchema;
	/** AST alias (lowercased) the body uses for this source, or the table name. */
	readonly alias: string;
	/**
	 * True when this side is **preserved** by the join shape — an inner-join side, or
	 * the preserved side of a LEFT/RIGHT outer join (the left of `left`, the right of
	 * `right`). A **non-preserved** side (`preserved: false`) is potentially
	 * null-extended: the right of a `left`, the left of a `right`, and *both* sides of
	 * a `full` outer join (§ Outer Joins). The per-op routing keys off this: an UPDATE
	 * defers a non-preserved-column write, a DELETE routes to preserved side(s), an
	 * INSERT treats a non-preserved side as an optional (presence-gated) member.
	 */
	readonly preserved: boolean;
	/**
	 * The enclosing outer join's ON predicate — the *guard* under which this
	 * non-preserved side's columns are real (the row is null-extended when the guard
	 * fails). Absent for a preserved side, and for an outer join expressed with USING
	 * (no AST `Expression` guard). Surfaced from the planned join shape for future
	 * per-row materialization; v1 routing does not consume it.
	 */
	readonly guard?: AST.Expression;
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
	 * True when the owning site is an outer-join **non-preserved** (null-extended)
	 * base column. Distinguishes a deferred outer-join column (base lineage present,
	 * but the write needs per-row materialization — `unsupported-outer-join-update`)
	 * from a genuinely computed column (no base lineage — `no-inverse`). A
	 * null-extended base column is still **insertable** (the both-sides envelope
	 * supplies it), so it carries {@link sideIndex} / {@link baseColumn}.
	 */
	readonly nullExtended: boolean;
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
	/** The base-table sides (≥2), in AST source order; routing is keyed by index 0..n-1. */
	readonly sides: readonly JoinSide[];
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
 * Non-throwing AST shape check — the boolean shadow of {@link collectJoinSources}'s
 * acceptance: `true` iff the body is a single explicit **n-way (≥2) equi-join** — `inner`,
 * `left`, `right`, or `full` — with an ON (or USING) predicate over plain base tables (the
 * exact multi-source shape `propagate()` decomposes), including **composite-PK sides** and
 * **self-joins** (one base table under two or more distinct aliases). Every other
 * multi-table body — cross / comma (implicit) / subquery- or function-source — returns
 * `false`.
 *
 * Shared with the static updateability surfaces (`deriveViewInfo` /
 * `deriveColumnInfo` in `func/builtins/schema.ts`): they gate on this so they
 * agree with what a real mutation through the view accepts. An outer join is now
 * **partially** writable (preserved-side update, delete-to-preserved, insert), so it is
 * decomposable here; those surfaces read per-column `null-extended` lineage to report a
 * non-preserved column non-updatable (the matching deferral). The throwing
 * {@link collectJoinSources} stays the substrate's source of truth; this mirrors only its
 * AST-level shape gate (it does not re-check DISTINCT/LIMIT/`select *`, which are deeper
 * semantic rejects handled downstream — PK shape is no longer a reject now that composite
 * keys are admitted).
 */
export function isDecomposableJoinBody(selectAst: AST.QueryExpr): boolean {
	if (selectAst.type !== 'select' || !selectAst.from) return false;
	const from = selectAst.from;
	if (from.length !== 1 || from[0].type !== 'join') return false;

	let tableCount = 0;
	const visit = (fc: AST.FromClause): boolean => {
		switch (fc.type) {
			case 'table':
				tableCount += 1;
				return true;
			case 'join': {
				// INNER/LEFT/RIGHT/FULL join with an explicit ON predicate or a USING column list.
				const accepted = fc.joinType === 'inner' || fc.joinType === 'left' || fc.joinType === 'right' || fc.joinType === 'full';
				if (!accepted || (!fc.condition && !(fc.columns && fc.columns.length > 0))) return false;
				return visit(fc.left) && visit(fc.right);
			}
			default:
				return false; // subquery / function source — not a plain base table
		}
	};
	if (!visit(from[0])) return false;

	// ≥2 plain base tables. A self-join (the same base table under distinct aliases) is
	// now accepted; routing is alias-keyed downstream, so the table names need not be
	// distinct here.
	return tableCount >= 2;
}

/**
 * Decompose a multi-source (n-way `inner`/`left`/`right`/`full` join) view mutation into
 * an ordered `BaseOp[]`. Throws a structured diagnostic for any unsupported shape.
 */
export function propagateMultiSource(ctx: PlanningContext, view: MutableViewLike, req: MutationRequest): BaseOp[] {
	// Validate the join shape first (this rejects cross/comma joins, non-table sources,
	// etc. with a `cannot write through view` diagnostic), so every unsupported join —
	// including an `insert` through one — surfaces the precise shape reason before the
	// op-specific handling. Outer joins are admitted: an UPDATE of a non-preserved column
	// defers (`unsupported-outer-join-update`), DELETE routes to the preserved side(s).
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
	/**
	 * Envelope indices whose non-null presence gates this side's insert per row — a
	 * non-preserved (outer-join optional) member inserts only for rows that supply ≥1
	 * of its columns (§ Outer Joins — Inserts). Empty ⇒ unconditional (a preserved /
	 * inner side, always inserted). Reuses the decomposition fan-out's presence gate
	 * (`buildDecompositionMemberInsert`).
	 */
	readonly presenceGateIndices: readonly number[];
}

/**
 * The plan-agnostic decomposition of a multi-source inner-join INSERT, consumed
 * by `buildMultiSourceInsert`. The **envelope** is the per-row augmented source:
 * its leading columns are the supplied view columns (`suppliedColumns`, in
 * user-source order), optionally followed by a surrogate shared key sourced from
 * the anchor key column's declared `default` (`keyDefault`). Each side reads its
 * values back out of that one materialized envelope, so the default is evaluated
 * exactly once per row and the value threads across both base inserts via the
 * equivalence class (docs/view-updateability.md § Mutation Context).
 */
export interface MsInsertAnalysis {
	readonly suppliedColumns: readonly { readonly name: string; readonly type: ScalarType }[];
	/** Sides ordered FK-parent before FK-child (the FK-safe insert order). */
	readonly orderedSides: readonly MsInsertSide[];
	/**
	 * The anchor key column's declared `default`, evaluated once per produced row at
	 * the envelope (with `mutation_ordinal()` in scope) and threaded into every side's
	 * key column via the equivalence class. Set only when the shared key is **not**
	 * directly supplied; absent ⇒ a supplied view column threads the key.
	 */
	readonly keyDefault?: AST.Expression;
}

/**
 * Decompose an n-way key-preserving INSERT into the per-side base inserts plus the
 * shared-surrogate envelope they fan out from. Throws a structured diagnostic for any
 * unsupported shape (computed target column, a not-null base column with no value, a
 * non-equi-join key, …). The shared key remains **single-column**: a side contributing a
 * composite shared key to the join's equivalence class is rejected with
 * `unsupported-decomposition-key` (the envelope threads one key value per row).
 *
 * **Outer joins** (§ Outer Joins — Inserts): a **non-preserved** side is an *optional*
 * member of the fan-out. A side whose columns are all absent emits no insert (it is
 * dropped); a non-preserved side that IS supplied is presence-gated per row (it inserts
 * only for rows supplying ≥1 of its columns). The shared key is minted/threaded only when
 * ≥2 sides are active (the preserved-only case is a single preserved insert — the row
 * reads back null-extended); an insert supplying *only* non-preserved columns, with no
 * preserved anchor row to attach to, is rejected `null-extended-create-conflict` (v1).
 */
export function analyzeMultiSourceInsert(ctx: PlanningContext, view: MutableViewLike, stmt: AST.InsertStmt): MsInsertAnalysis {
	rejectReturning(view, stmt.returning);
	const analysis = analyzeJoinView(ctx, view);
	const { sides, outColumns } = analysis;
	const keyColumns = extractJoinKeyColumns(view, analysis.sel, sides);

	// Supplied view columns: the explicit list, or every base-routed (identity, rename,
	// or outer-join null-extended) view output column. An `inverse`-profile column
	// (writable on the UPDATE path) is NOT insertable — the shared-surrogate envelope
	// writes supplied values to base columns verbatim, with no hook to apply the column's
	// inverse, so an inserted `cv1` would land raw in `cv`. Excluding it from the implicit
	// set lets it fall to its base default / not-null check; an explicit supply is
	// rejected below. A non-preserved (null-extended) base column IS insertable here (the
	// both-sides envelope supplies it), so it is included even though it is read-only on
	// the UPDATE path.
	const suppliedNames = stmt.columns && stmt.columns.length > 0
		? stmt.columns
		: outColumns.filter(c => c.sideIndex !== undefined && c.baseColumn !== undefined && !c.inverse).map(c => c.name);

	interface Supplied { readonly name: string; readonly sideIndex: number; readonly baseColumn: string; readonly type: ScalarType; readonly isKey: boolean; }
	const supplied: Supplied[] = suppliedNames.map((rawName): Supplied => {
		const name = rawName.toLowerCase();
		const out = outColumns.find(c => c.name === name);
		// A base-routed column (identity/rename or outer-join null-extended) carries
		// `sideIndex` + `baseColumn`; a computed column does not, and an `inverse` column
		// cannot store a raw value. Either of the latter is non-insertable.
		if (!out || out.inverse || out.sideIndex === undefined || !out.baseColumn) {
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

	// A FULL outer join has no preserved anchor side to mint/thread the shared key from
	// (every side is null-extended per row), so a statically-routed insert is not
	// expressible — defer it (the static `view_info` surface short-circuits the same body
	// to all-`NO`).
	const hasPreservedSide = sides.some(s => s.preserved);
	if (!hasPreservedSide) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': a FULL outer join has no preserved anchor side to mint/thread the shared key from; inserting through a full-outer view is deferred`,
		});
	}

	// Active sides: a preserved (or inner) side is always inserted (the anchor row); a
	// non-preserved (outer) side is active only when ≥1 of its columns is supplied — an
	// absent non-preserved side emits no insert (the per-row null-extension semantics).
	const suppliedSides = new Set(supplied.map(s => s.sideIndex));
	const isActive = (i: number): boolean => sides[i].preserved || suppliedSides.has(i);
	const activeIndices = sides.map((_, i) => i).filter(isActive);

	// Non-preserved-only reject (§ Outer Joins — Inserts): supplying only a non-preserved
	// side's columns, with no preserved anchor row to mint/thread the shared key from, is
	// not yet expressible (the envelope sources the key from the preserved anchor).
	const anyNonPreservedActive = sides.some((s, i) => !s.preserved && suppliedSides.has(i));
	const anyPreservedSupplied = supplied.some(s => sides[s.sideIndex].preserved);
	if (anyNonPreservedActive && !anyPreservedSupplied) {
		raiseMutationDiagnostic({
			reason: 'null-extended-create-conflict',
			table: view.name,
			message: `cannot insert through view '${view.name}': only non-preserved-side columns were supplied through the outer join, with no preserved-side row to attach to; supply the preserved side's columns too (the shared key is minted/threaded from the preserved anchor)`,
		});
	}

	// The shared key relates two or more active sides; with only one active side (the
	// preserved-only insert) no key is needed — the single side inserts and the row reads
	// back null-extended.
	const needsSharedKey = activeIndices.length >= 2;

	// The shared key is either directly supplied (a supplied view column maps to a
	// join-key base column) or sourced from the anchor key column's declared `default`,
	// evaluated once per row at the envelope and EC-threaded into the active sides. The
	// engine mints nothing of its own — the basis author declares the policy
	// (docs/view-updateability.md § Mutation Context).
	const suppliedKeys = supplied.filter(s => s.isKey);
	if (suppliedKeys.length > 1) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the shared join key is exposed by more than one view column (${suppliedKeys.map(s => `'${s.name}'`).join(', ')}); supply it through a single view column`,
		});
	}
	const suppliedKeyIndex = supplied.findIndex(s => s.isKey);
	let keyDefault: AST.Expression | undefined;
	let keyEnvelopeIndex = -1;
	if (needsSharedKey) {
		if (suppliedKeyIndex >= 0) {
			keyEnvelopeIndex = suppliedKeyIndex;
		} else {
			keyEnvelopeIndex = supplied.length; // the default-sourced column is appended last
			// The anchor is the FK-root among the **active** sides (so a dropped optional
			// member never seeds the surrogate); its key column's declared default sources
			// the minted value.
			const anchorIndex = orderSides(sides).find(isActive)!;
			const anchorKeyCol = columnByName(sides[anchorIndex].schema, keyColumns[anchorIndex]);
			keyDefault = requireKeyDefault(view, sides[anchorIndex].schema, anchorKeyCol);
		}
	}

	// Per active side: the shared key (when needed) plus the supplied view columns it
	// owns. A non-preserved active side carries a presence gate over its supplied columns.
	//
	// v1 caveat: when a non-preserved side IS active but a *given row's* supplied values are
	// all null (its presence gate fails for that row), that row's non-preserved insert is
	// dropped while the preserved side still threads the minted key into its join column —
	// so a preserved row whose optional partner is absent for that row points its FK column
	// at a key with no partner row (it reads back correctly null-extended, but with FK
	// enforcement on this is a dangling reference). The tested path is single-row inserts
	// with FK off; the per-row conditional key thread (`pr = case when <present> then key
	// else null`) is deferred. The *statically* absent case (a non-preserved side with NO
	// supplied columns) is handled cleanly above: it is inactive ⇒ no key is threaded.
	const specByIndex = new Map<number, MsInsertSide>();
	for (const sideIndex of activeIndices) {
		const side = sides[sideIndex];
		const targetColumns: string[] = [];
		const envelopeIndices: number[] = [];
		if (needsSharedKey) {
			targetColumns.push(keyColumns[sideIndex]);
			envelopeIndices.push(keyEnvelopeIndex);
		}
		const presenceGateIndices: number[] = [];
		supplied.forEach((s, idx) => {
			if (s.sideIndex !== sideIndex) return;
			if (needsSharedKey && s.isKey) return; // the key is threaded above
			targetColumns.push(s.baseColumn);
			envelopeIndices.push(idx);
			if (!side.preserved) presenceGateIndices.push(idx);
		});
		assertNoMissingNotNull(view, side.schema, targetColumns);
		specByIndex.set(sideIndex, { table: side.table, schema: side.schema, targetColumns, envelopeIndices, presenceGateIndices });
	}

	const order = orderSides(sides).filter(i => specByIndex.has(i));
	return {
		suppliedColumns: supplied.map(s => ({ name: s.name, type: s.type })),
		orderedSides: order.map(i => specByIndex.get(i)!),
		keyDefault,
	};
}

/** One cross-side `column = column` equality recovered from a join ON / USING clause. */
interface CrossSideEquality { readonly sideA: number; readonly colA: string; readonly sideB: number; readonly colB: string; }

/**
 * Walk every nested `JoinClause`'s ON predicate (flattened on AND) and USING column
 * list across the n-way join tree, collecting cross-side `column = column` equalities
 * (each operand resolving to a *different* side via {@link resolveColumnSide}). The
 * shared backward read the insert envelope's shared-key extraction relies on — it must
 * see ALL conjunctions (not just the outermost join's ON), since for `a join b on …
 * join c on …` only the last ON is on `from[0]`.
 */
function collectCrossSideEqualities(from: readonly AST.FromClause[], sides: readonly JoinSide[]): CrossSideEquality[] {
	const out: CrossSideEquality[] = [];
	const sidesUnder = (fc: AST.FromClause): number[] => {
		switch (fc.type) {
			case 'table': {
				const alias = (fc.alias ?? fc.table.name).toLowerCase();
				const idx = sides.findIndex(s => s.alias === alias);
				return idx >= 0 ? [idx] : [];
			}
			case 'join':
				return [...sidesUnder(fc.left), ...sidesUnder(fc.right)];
			default:
				return [];
		}
	};
	const visit = (fc: AST.FromClause): void => {
		if (fc.type !== 'join') return;
		visit(fc.left);
		visit(fc.right);
		if (fc.condition) {
			for (const conj of flattenAnd(fc.condition)) {
				if (conj.type !== 'binary' || conj.operator !== '=') continue;
				if (conj.left.type !== 'column' || conj.right.type !== 'column') continue;
				const sa = resolveColumnSide(conj.left, sides);
				const sb = resolveColumnSide(conj.right, sides);
				if (sa === undefined || sb === undefined || sa === sb) continue;
				out.push({ sideA: sa, colA: conj.left.name, sideB: sb, colB: conj.right.name });
			}
		}
		// USING (c, …): each named column equates the same-named column on the left and
		// right operands. The operands may be nested joins, so locate the unique owning
		// side under each (a column present on exactly one side of each operand subtree).
		if (fc.columns) {
			const ownerUnder = (operand: AST.FromClause, col: string): number | undefined => {
				const owners = sidesUnder(operand).filter(i => sides[i].schema.columns.some(c => c.name.toLowerCase() === col.toLowerCase()));
				return owners.length === 1 ? owners[0] : undefined;
			};
			for (const colName of fc.columns) {
				const sa = ownerUnder(fc.left, colName);
				const sb = ownerUnder(fc.right, colName);
				if (sa === undefined || sb === undefined || sa === sb) continue;
				out.push({ sideA: sa, colA: colName, sideB: sb, colB: colName });
			}
		}
	};
	visit(from[0]);
	return out;
}

/**
 * The per-side shared-key base columns of an n-way inner equi-join, aligned to `sides`
 * by index. Walks every ON conjunction / USING column ({@link collectCrossSideEqualities})
 * and requires they connect all sides into a **single** shared-key equivalence class
 * with exactly one key column per side (the surrogate the decomposition threads through
 * the envelope's equivalence class). A side contributing more than one column to the EC
 * is the deferred multi-column-surrogate shape — rejected `unsupported-decomposition-key`;
 * a join that does not relate every side through one shared value (a chained / multi-key
 * join) is rejected `unsupported-join`.
 */
function extractJoinKeyColumns(view: MutableViewLike, sel: AST.SelectStmt, sides: readonly JoinSide[]): string[] {
	const equalities = collectCrossSideEqualities(sel.from!, sides);
	if (equalities.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot insert through view '${view.name}': the join must carry an explicit equi-join ON/USING predicate naming the shared key`,
		});
	}

	// Per side: the distinct columns it contributes to a cross-side equality.
	const perSideCols: Array<Set<string>> = sides.map(() => new Set<string>());
	// Union-find over `<side>:<col>` keys — proves a single shared-key equivalence class.
	const parent = new Map<string, string>();
	const ensure = (k: string): void => { if (!parent.has(k)) parent.set(k, k); };
	const find = (k: string): string => { ensure(k); let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
	const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };
	const nodeKey = (side: number, col: string): string => `${side}:${col.toLowerCase()}`;
	for (const eq of equalities) {
		perSideCols[eq.sideA].add(eq.colA);
		perSideCols[eq.sideB].add(eq.colB);
		union(nodeKey(eq.sideA, eq.colA), nodeKey(eq.sideB, eq.colB));
	}

	const keyCols = sides.map((side, i): string => {
		const cols = [...perSideCols[i]];
		if (cols.length === 0) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `cannot insert through view '${view.name}': base table '${side.schema.name}' is not related to the shared join key by any equi-join predicate`,
			});
		}
		if (cols.length > 1) {
			raiseMutationDiagnostic({
				reason: 'unsupported-decomposition-key',
				table: view.name,
				message: `cannot insert through view '${view.name}': base table '${side.schema.name}' contributes a composite shared key (${cols.join(', ')}); a multi-column shared-key insert envelope is not yet supported`,
			});
		}
		return cols[0];
	});

	// All sides' key columns must belong to ONE equivalence class — a single shared value
	// threaded into every side via the EC. A chain (`a.x=b.y join … b.z=c.w`) yields
	// disjoint key classes that no single surrogate can thread.
	const root0 = find(nodeKey(0, keyCols[0]));
	for (let i = 1; i < sides.length; i++) {
		if (find(nodeKey(i, keyCols[i])) !== root0) {
			raiseMutationDiagnostic({
				reason: 'unsupported-join',
				table: view.name,
				message: `cannot insert through view '${view.name}': the join does not relate all base tables through a single shared key (a chained / multi-key join insert is not yet supported)`,
			});
		}
	}
	return keyCols;
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

/**
 * The anchor key column's declared `default` — the surrogate's per-row source —
 * evaluated once per produced row at the envelope (with `mutation_ordinal()` in
 * scope) and threaded into both sides via the equivalence class. The engine no
 * longer invents a surrogate: a key that is neither supplied nor defaulted raises
 * `no-default` with the migration recipe.
 */
function requireKeyDefault(view: MutableViewLike, schema: TableSchema, keyCol: ColumnSchema): AST.Expression {
	if (keyCol.defaultValue === null) {
		raiseMutationDiagnostic({
			reason: 'no-default',
			column: keyCol.name,
			table: view.name,
			message: `cannot insert through view '${view.name}': the shared key '${schema.name}.${keyCol.name}' is neither supplied nor declares a DEFAULT; declare a default (e.g. \`default (coalesce((select max(${keyCol.name}) from ${schema.name}), 0) + mutation_ordinal())\`) or supply the key through a view column`,
			suggestion: `declare a DEFAULT on '${schema.name}.${keyCol.name}', or expose the key as a supplied view column`,
		});
	}
	return keyCol.defaultValue;
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

	const sources = collectJoinSources(view, sel.from!);

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

	// Map each AST source's **alias** to its planned `TableReferenceNode` by resolving
	// the alias-qualified PK column through the join's combined scope (the same scope the
	// body's own projections resolved against) to the producing attribute → its owning
	// `TableReferenceNode`. A by-table-NAME match is ambiguous for a self-join (two
	// sources share one table name); the alias is the discriminator, and each alias is a
	// distinct scan node post-plan, so resolving through the scope pins the right ref.
	// `attrToTableRef` inverts every base ref's attribute ids (which the inner join
	// preserves up to its output) so a resolved column reference identifies its source.
	const attrToTableRef = new Map<number, TableReferenceNode>();
	for (const ref of tableRefsById.values()) {
		for (const attr of ref.getAttributes()) attrToTableRef.set(attr.id, ref);
	}
	const schemaByTableName = new Map<string, TableSchema>();
	for (const ref of tableRefsById.values()) schemaByTableName.set(ref.tableSchema.name.toLowerCase(), ref.tableSchema);

	const sides: JoinSide[] = sources.map((src): JoinSide => {
		const alias = (src.source.alias ?? src.source.table.name).toLowerCase();
		const schema = schemaByTableName.get(src.source.table.name.toLowerCase());
		if (!schema) {
			raiseMutationDiagnostic({
				reason: 'no-base-lineage',
				table: view.name,
				message: `cannot write through view '${view.name}': base table '${src.source.table.name}' did not resolve in the planned body`,
			});
		}
		const ref = resolveSourceTableRef(ctx, joinScope, schema, alias, attrToTableRef, view);
		return { table: ref, schema: ref.tableSchema, alias, preserved: src.preserved, ...(src.guard ? { guard: src.guard } : {}) };
	});

	const sideByTableId = new Map<number, number>();
	sides.forEach((s, idx) => sideByTableId.set(Number(s.table.id), idx));

	// Route each shared backward column onto its owning join side. An inner-join body
	// never null-extends (`nullExtended` always false); an outer-join body marks the
	// non-preserved side's columns `nullExtended: true` (the join-predicate-guarded
	// site `deriveJoinUpdateLineage` wraps) — still base-routed, but read-only on
	// update (the deferred materialization) and insertable as an optional member.
	const outColumns: OutColumn[] = columns.map((bc): OutColumn => {
		if (bc.baseTableId !== undefined && bc.baseColumn !== undefined) {
			const sideIndex = sideByTableId.get(bc.baseTableId);
			return {
				name: bc.name,
				displayName: bc.displayName,
				sideIndex,
				baseColumn: bc.baseColumn,
				writable: sideIndex !== undefined && !bc.nullExtended,
				nullExtended: bc.nullExtended,
				...(bc.inverse ? { inverse: bc.inverse } : {}),
				...(bc.domain ? { domain: bc.domain } : {}),
			};
		}
		return { name: bc.name, displayName: bc.displayName, writable: false, nullExtended: false };
	});

	return { sel, sides, viewColToBaseRef, outColumns, root, joinNode, joinScope };
}

/**
 * Resolve one AST join source (by its `alias`) to its planned `TableReferenceNode`.
 * Probes with the source's first PK column (or first column if keyless) qualified by
 * the alias, resolved through the join's combined `joinScope` — the inner join
 * preserves the producing base scan's attribute id up to its output, so the resolved
 * `ColumnReferenceNode`'s attribute id pins the alias's owning `TableReferenceNode`
 * via `attrToTableRef`. This is what disambiguates a **self-join** (two sources sharing
 * one table name but distinct aliases → distinct scan nodes).
 */
function resolveSourceTableRef(
	ctx: PlanningContext,
	joinScope: Scope,
	schema: TableSchema,
	alias: string,
	attrToTableRef: ReadonlyMap<number, TableReferenceNode>,
	view: MutableViewLike,
): TableReferenceNode {
	const pk = schema.primaryKeyDefinition;
	const probeColName = (pk.length > 0 ? schema.columns[pk[0].index] : schema.columns[0])?.name;
	if (!probeColName) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': base table '${schema.name}' (alias '${alias}') has no columns to resolve its join side`,
		});
	}
	const probe = buildExpression({ ...ctx, scope: joinScope }, { type: 'column', name: probeColName, table: alias } as AST.ColumnExpr);
	if (!(probe instanceof ColumnReferenceNode)) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': join source alias '${alias}' did not resolve to a base column reference in the planned body`,
		});
	}
	const ref = attrToTableRef.get(probe.attributeId);
	if (!ref) {
		raiseMutationDiagnostic({
			reason: 'no-base-lineage',
			table: view.name,
			message: `cannot write through view '${view.name}': join source alias '${alias}' did not resolve to a base table in the planned body`,
		});
	}
	return ref;
}

/**
 * The single `JoinNode` inside a planned n-way inner-join body — the outermost
 * `JoinNode` reached from the root (the body's plan is `Project(Filter?(Join…))`; for
 * an n-way join the outermost JoinNode transitively contains the nested ones). Reused
 * (not re-planned) as the source the identifying-capture / RETURNING relations build
 * on; the nested joins ride inside it via its own `getRelations()`.
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

/** One base-table source of the join body, with its preserved/guard classification. */
interface JoinSourceInfo {
	readonly source: AST.TableSource;
	/** False when an enclosing outer join potentially null-extends this source. */
	readonly preserved: boolean;
	/** The conjoined ON predicate(s) of the enclosing outer join(s) that null-extend it. */
	readonly guard?: AST.Expression;
}

/**
 * Collect the join's base-table sources (in AST declaration order), validating the body
 * is an **n-way (≥2) equi-join** over plain base tables — `inner`, `left`, `right`, or
 * `full` (no comma/implicit cross join, no subquery or function sources). A **self-join**
 * — the same base table under distinct aliases — is accepted (routing is alias-keyed
 * downstream); USING joins are accepted alongside ON joins. The declaration order is the
 * alias-declaration order the substrate serializes per-side ops in (§ Cycles, Self-Joins).
 *
 * Each source is tagged **preserved** / **non-preserved** by walking the join tree and
 * tracking which branch each table sits on: the right of a `left`, the left of a `right`,
 * and both sides of a `full` are non-preserved (potentially null-extended), carrying the
 * enclosing outer join's ON predicate as their guard (§ Outer Joins). An inner join
 * propagates its parents' classification unchanged. This is the AST-shape dual of the
 * planned body's `null-extended` lineage (which `analyzeJoinView` cross-checks per column).
 */
function collectJoinSources(view: MutableViewLike, from: readonly AST.FromClause[]): JoinSourceInfo[] {
	if (from.length !== 1 || from[0].type !== 'join') {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': only an explicit 'JOIN ... ON/USING' body is decomposable (a comma/implicit cross join is not)`,
		});
	}

	const out: JoinSourceInfo[] = [];
	// `nonPreserved` is true when an enclosing outer join can null-extend the subtree;
	// `guards` are those outer joins' ON predicates (conjoined onto each leaf's guard).
	const visit = (fc: AST.FromClause, nonPreserved: boolean, guards: readonly AST.Expression[]): void => {
		switch (fc.type) {
			case 'table':
				out.push({
					source: fc,
					preserved: !nonPreserved,
					guard: guards.reduce<AST.Expression | undefined>((acc, g) => combineAnd(acc, g), undefined),
				});
				return;
			case 'join': {
				const hasPredicate = !!fc.condition || (!!fc.columns && fc.columns.length > 0);
				const acceptedType = fc.joinType === 'inner' || fc.joinType === 'left' || fc.joinType === 'right' || fc.joinType === 'full';
				if (!acceptedType || !hasPredicate) {
					raiseMutationDiagnostic({
						reason: 'unsupported-join',
						table: view.name,
						message: `cannot write through view '${view.name}': only INNER/LEFT/RIGHT/FULL joins with an ON/USING predicate are decomposable (got '${fc.joinType}'${hasPredicate ? '' : ' without ON/USING'})`,
					});
				}
				// USING joins carry no AST `Expression` guard — only an explicit ON predicate
				// is surfaced as the null-extension guard (v1 routing does not consume it).
				const guardsWith = fc.condition ? [...guards, fc.condition] : guards;
				switch (fc.joinType) {
					case 'inner':
						visit(fc.left, nonPreserved, guards);
						visit(fc.right, nonPreserved, guards);
						break;
					case 'left':
						visit(fc.left, nonPreserved, guards);
						visit(fc.right, true, guardsWith);
						break;
					case 'right':
						visit(fc.left, true, guardsWith);
						visit(fc.right, nonPreserved, guards);
						break;
					case 'full':
						visit(fc.left, true, guardsWith);
						visit(fc.right, true, guardsWith);
						break;
				}
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
	visit(from[0], false, []);

	if (out.length < 2) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': a decomposable join needs at least two base tables (found ${out.length})`,
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

/**
 * A partner-side base column a cross-source SET value reads (`update v set a.x = b.y`),
 * captured into `__vmupd_keys` so the lowered single-table UPDATE can read it back. The
 * `expr` is the read column in base terms (alias-qualified — `b.y`), projected into the
 * capture over the join body's scope under the stable `alias` (`src0`, `src1`, …); the
 * rewritten value (`select <alias> from __vmupd_keys k where <ownerPk = capture>`) reads
 * it correlated by the owning side's PK. Because the capture materializes **before** any
 * base op fires, the read-back value is the **pre-mutation** partner value — robust to a
 * both-sides update that also rewrites it (docs/view-updateability.md § Inner Join).
 */
export interface CrossSourceValue {
	readonly alias: string;
	readonly expr: AST.Expression;
}

export function decomposeUpdate(ctx: PlanningContext, view: MutableViewLike, analysis: JoinViewAnalysis, stmt: AST.UpdateStmt, tags?: ReservedTagMap, sourceValues?: CrossSourceValue[]): BaseOp[] {
	// RETURNING through a multi-source update is supported, but the rows are not
	// recoverable from the per-side base ops (the view row spans both tables), so
	// the builder (`view-mutation-builder.ts`) supplies them via a re-query of the
	// planned join body; the base ops themselves carry no RETURNING.

	// `target` / `exclude` narrow the writable base set (compose AFTER predicate
	// dispatch — they only restrict, never broaden). For an update the side set is
	// already pinned per-assignment by lineage, so the tag acts as a guard: an
	// assignment to an excluded side is a structured conflict, not a silent drop.
	const allowedSides = applyTargetExclude(allSideIndices(analysis.sides), analysis.sides, tags, view);

	// Scope guard: top-level `where` references must name view columns (parity with
	// the single-source spine — a base-only name must not leak through the join body).
	if (stmt.where) guardTopLevelScope(stmt.where, analysis, view);

	// Cross-source SET values (`set a.x = b.y`) ride the same `__vmupd_keys` capture:
	// each partner-side base column the SET reads is projected into the capture under a
	// stable `srcN` alias, and the reference is rewritten to a correlated scalar read of
	// it (keyed by the owning side's PK). The carrier is the `sourceValues` out-param the
	// builder threads into `buildMultiSourceKeyCapture`; absent it (the legacy
	// `propagateMultiSource` path, unreachable from build) cross-source values stay
	// rejected by `stripSideQualifier`'s throw.
	const srcDedup = new Map<string, string>();
	const registerCrossSource = sourceValues
		? (col: AST.ColumnExpr): string => {
			const key = `${(col.table ?? '').toLowerCase()}.${col.name.toLowerCase()}`;
			const existing = srcDedup.get(key);
			if (existing) return existing;
			const alias = `src${sourceValues.length}`;
			srcDedup.set(key, alias);
			sourceValues.push({ alias, expr: { type: 'column', name: col.name, table: col.table } });
			return alias;
		}
		: undefined;

	// Route each assignment to its owning base side (one entry per side, index 0..n-1).
	const perSide: Array<{ column: string; value: AST.Expression }[]> = analysis.sides.map(() => []);
	for (const asg of stmt.assignments) {
		const out = analysis.outColumns.find(c => c.name === asg.column.toLowerCase());
		if (!out) {
			// Not a view column at all — the same encapsulation-leak guard as the
			// top-level `where` scan (distinct from a computed view column below).
			raiseUnknownViewColumn(asg.column, view, analysis.outColumns.map(c => c.displayName));
		}
		// A non-preserved (outer-join null-extended) base column: the row is either matched
		// (→ a normal base update) or null-extended (→ an insert on the missing side), a
		// per-row branch not statically decidable here (§ Outer Joins — Updates on a
		// non-preserved-side column). Defer to `view-write-optional-member-transitions` with
		// a precise diagnostic — distinct from the genuinely-computed `no-inverse` below
		// (the column DOES have base lineage; it just needs the materialization fan-out).
		if (out.nullExtended && out.sideIndex !== undefined && out.baseColumn) {
			raiseMutationDiagnostic({
				reason: 'unsupported-outer-join-update',
				column: asg.column,
				table: view.name,
				message: `cannot write through view '${view.name}': column '${asg.column}' is backed by the non-preserved side of an outer join (base table '${analysis.sides[out.sideIndex].schema.name}'); updating it needs the per-row matched-update / null-extended-insert materialization (deferred to the optional-member transitions fan-out)`,
			});
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
		// Gate cross-source reads: a value that reads a partner-side view column is
		// admitted only when that column has `base` lineage (its value is recoverable
		// from a captured base column). A computed (non-base) partner column stays
		// rejected (`no-inverse`); a same-side read keeps the qualifier-strip path. Run
		// only when a capture carrier is threaded — the legacy path rejects wholesale.
		if (registerCrossSource) gateCrossSourceReads(asg.value, out.sideIndex, analysis, view);
		const side = analysis.sides[out.sideIndex];
		const others = analysis.sides.filter((_, i) => i !== out.sideIndex);
		// Rewrite the assigned value into base terms, then strip the owning side's
		// qualifier (the base UPDATE targets that table directly). A reference to a
		// partner side is rewritten to a correlated read of its captured pre-mutation
		// value (`registerCrossSource`); absent the carrier it is rejected.
		const baseValue = stripSideQualifier(
			substituteViewColumns(ctx, asg.value, analysis.viewColToBaseRef, view),
			view, side, out.sideIndex, others, registerCrossSource,
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
	// that captured set via a correlated EXISTS over `__vmupd_keys` (matching all of the
	// side's PK columns — composite keys included), a mutation-order-independent identity
	// built from the ALREADY-planned join body (the builder materializes the capture; see
	// `buildMultiSourceKeyCapture`). This unifies the single-side and both-sides paths
	// onto the same identity (no live re-query of a re-planned AST body): a both-sides
	// update's FK-parent op can no longer rewrite a predicate column out from under the
	// FK-child op, and a single-side op — having no ordering hazard — reads the same
	// pre-mutation set it would have re-queried live.

	// Order FK-parent before FK-child by the n-way FK topological sort (matches insert
	// ordering intent and avoids surprising mid-statement FK states); source order within
	// an FK-equivalence class (and for self-joins, whose mutual edges fall back to
	// alias-declaration order — § Cycles, Self-Joins).
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
		const where = buildCapturedKeyPredicate(view, side, sideIndex);
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

/** All side indices `0..n-1` — the default candidate set for `target`/`exclude`. */
function allSideIndices(sides: readonly JoinSide[]): number[] {
	return sides.map((_, i) => i);
}

/**
 * The **preserved** side indices — the default DELETE candidate set (§ Outer Joins —
 * Deletes: "deleting from the preserved side is the only way for the joined row to
 * disappear from the view"). For an inner join every side is preserved, so this is
 * `allSideIndices` (unchanged routing). For a LEFT/RIGHT outer join it is the single
 * preserved side. A `full` outer join has *no* preserved side; the caller falls back to
 * the full candidate set there (every side is both preserved and non-preserved).
 */
function preservedSideIndices(sides: readonly JoinSide[]): number[] {
	return sides.flatMap((s, i) => s.preserved ? [i] : []);
}

/**
 * The correlated EXISTS identifying predicate a per-side base op routes on:
 * `exists (select 1 from __vmupd_keys k where k.k<side>_0 = <pk0> [and k.k<side>_1 =
 * <pk1> …])` — matching ALL of the side's PK columns (composite keys included) against
 * the up-front materialized key set (the both-sides-assigned UPDATE path, every
 * single-side update/delete, and the multi-side DELETE fan-out; see
 * {@link MS_UPDATE_KEYS_CTE}). The right-hand `<pk_j>` are unqualified, so they bind to
 * the base op's own target table; `k.k<side>_<j>` reads the captured column. The builder
 * injects `__vmupd_keys` into the base op's planning `cteNodes` (resolving to the
 * context-backed key relation), so this is read by descriptor rather than re-querying
 * the join body. (EXISTS — not a row-value `IN` — to reuse the UPDATE RETURNING
 * re-query's correlation shape; one pattern.)
 */
function buildCapturedKeyPredicate(view: MutableViewLike, side: JoinSide, sideIndex: number): AST.Expression {
	const keyCols = requireKeyColumns(view, side);
	const conds = keyCols.map((pkCol, j): AST.Expression => ({
		type: 'binary',
		operator: '=',
		left: { type: 'column', name: keyColumnName(sideIndex, j), table: 'k' },
		right: { type: 'column', name: pkCol },
	}));
	return {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
			where: conds.reduce((acc, c) => combineAnd(acc, c)!),
		},
	};
}

// --- identity capture (shared by both-sides UPDATE / multi-side DELETE base ops + UPDATE RETURNING) ---

/**
 * The up-front base-PK identity capture for a multi-source (n-way inner-join) UPDATE or
 * multi-side DELETE fan-out (docs/view-updateability.md § Inner Join, § `returning`).
 * Built ONCE and shared between the per-side base ops' identifying subqueries and (for
 * an UPDATE with RETURNING) the RETURNING re-query.
 *
 *  - `source`: the capture SELECT `select s0.pk0 as k0_0[, s0.pk1 as k0_1], s1.pk0 as
 *    k1_0, … from <body> where <idPredicate>` — the emitter materializes it into
 *    `rctx.tableContexts` under {@link descriptor} **before** any base op runs.
 *  - `descriptor`: the identity stitch shared between the materialized capture rows
 *    and every {@link InternalRecursiveCTERefNode} that reads them back.
 *  - `keyColumns`: the flattened `k<side>_<j>` column shape (one entry per requested
 *    side per PK column) each reader mints a key ref over.
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
 * (`analysis.joinNode` + `analysis.joinScope`) — `Project_{k<side>_<j>}(Filter_{idPred}
 * (joinNode))` — instead of re-planning a cloned AST FROM, so the body is planned
 * ONCE (§ Round-Trip Laws and the Derived Backward Walk). `preserveInputColumns=false`
 * ⇒ the materialized rows are exactly the requested key columns, positionally aligned
 * to the `k<side>_<j>` columns every reader scans back (`keyColumns` and the projection
 * derive from the same `sideIndices` order; a composite-PK side contributes one column
 * per PK column).
 *
 * `sideIndices` selects which sides' PKs to capture (each requires ≥1 PK column via
 * {@link requireKeyColumns}; a keyless side is rejected with `unsupported-join`). The
 * builder passes exactly the sides whose base ops read the capture (plus all sides, for
 * an UPDATE with RETURNING whose EXISTS correlates the full joined row), so a single-
 * side write never forces a PK on an untouched side.
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
	sourceValues?: readonly CrossSourceValue[],
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

	// One capture column per requested side per PK column: `k<side>_<j>`. A composite-PK
	// side projects all its PK columns; the readers' EXISTS correlate on the same set.
	const keyColumns: { name: string; type: ScalarType }[] = [];
	const projections: Projection[] = [];
	for (const i of sideIndices) {
		const side = analysis.sides[i];
		const pkCols = requireKeyColumns(view, side);
		pkCols.forEach((pk, j) => {
			const name = keyColumnName(i, j);
			keyColumns.push({ name, type: columnScalarType(columnByName(side.schema, pk)) });
			projections.push({
				node: buildExpression({ ...ctx, scope: analysis.joinScope }, { type: 'column', name: pk, table: side.alias }),
				alias: name,
			});
		});
	}

	// Cross-source SET read values: project each partner base column the SET reads under
	// its stable `srcN` alias (over the same join-body scope), so every per-side base op's
	// correlated `select srcN from __vmupd_keys k where …` reads the captured pre-mutation
	// value. Appended AFTER the per-side PK columns, positionally aligned with the readers'
	// `keyColumns` (which are pushed in the same order).
	for (const sv of sourceValues ?? []) {
		const node = buildExpression({ ...ctx, scope: analysis.joinScope }, sv.expr);
		keyColumns.push({ name: sv.alias, type: node.getType() });
		projections.push({ node, alias: sv.alias });
	}

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
 * (select 1 from __vmupd_keys k where k.k0_0 = s0.pk0 [and k.k0_1 = s0.pk1] and k.k1_0
 * = s1.pk0 …)` (every side × PK column) — so a row the update pushed *out* of the
 * view's filter (or whose predicate column it rewrote) is still returned (single-source
 * NEW semantics). It keeps only the structural join ON-condition; the body/user WHERE is
 * intentionally NOT re-applied.
 *
 * Reads the shared {@link MultiSourceKeyCapture} the builder materializes
 * before the base ops fire (via its own freshly-minted key ref over the same
 * descriptor). The capture covers ALL sides for an UPDATE with RETURNING, so this
 * correlates the full joined row's identity.
 */
export function buildMultiSourceUpdateReturning(
	ctx: PlanningContext,
	view: MutableViewLike,
	stmt: AST.UpdateStmt,
	capture: MultiSourceKeyCapture,
	analysis: JoinViewAnalysis,
): RelationalPlanNode {
	const returningCols = stmt.returning!;

	// Restrict the POST-mutation join body to the captured identities, built as plan
	// nodes over the ALREADY-planned `joinNode` (its structural ON-condition only —
	// the body/user WHERE is intentionally NOT re-applied) — no AST re-plan of the
	// body. The EXISTS subquery resolves `__vmupd_keys` via `cteNodes` to a fresh key
	// ref over the shared capture descriptor; `s<side>.pk<j>` correlate to the outer
	// join row through `joinScope`. Conjoin one equality per side per PK column.
	const conds: AST.Expression[] = [];
	analysis.sides.forEach((side, sideIndex) => {
		requireKeyColumns(view, side).forEach((pk, j) => {
			conds.push({
				type: 'binary',
				operator: '=',
				left: { type: 'column', name: keyColumnName(sideIndex, j), table: 'k' },
				right: { type: 'column', name: pk, table: side.alias },
			});
		});
	});
	const keyRef = makeMultiSourceKeyRef(ctx.scope, capture);
	const existsPredicateAst: AST.Expression = {
		type: 'exists',
		subquery: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'literal', value: 1 } }],
			from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
			where: conds.reduce((acc, c) => combineAnd(acc, c)!),
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
	// ONCE before any base op fires (a correlated EXISTS over `__vmupd_keys` matching
	// the side's PK columns), a mutation-order-independent set built from the
	// ALREADY-planned join body. So the first side's delete cannot empty the join out
	// from under a later side's identifying set (the predicate-honest multi-side
	// fan-out), and a single-side delete — having no ordering hazard — reads the same
	// pre-mutation set it would have re-queried live. (No live re-query of a re-planned
	// AST body.)

	// Order the base deletes. The **two-side fan-out over a 2-table join** orders by ON
	// DELETE action so the side whose removal clears the other's reference runs first
	// (`orderDeleteFanout`); a mutual FK whose actions no side order can satisfy under
	// immediate enforcement raises `mutual-fk-restrict-delete` at plan time — but ONLY
	// when the join provably correlates a mutual FK edge (the joined rows necessarily
	// cross-reference, so a RESTRICT necessarily fires). When the join correlates neither
	// edge (e.g. a join on non-FK columns), the schema-only reject is a data-independent
	// over-rejection: fall back to the fixed `[0, 1]` fan-out and defer to the runtime
	// RESTRICT pre-check (`runtime/foreign-key-actions.ts`) on the actual data.
	//
	// This plan-time mutual-FK analysis is **deliberately NOT generalized past two
	// sides** (§ Out of scope): an n-way (>2) delete uses the **reverse** FK-topological
	// order (FK-child before FK-parent) over the chosen sides — the FK-safe delete
	// direction — and defers any mutual-FK cycle wholesale to the runtime RESTRICT
	// pre-check. A single-side delete has no ordering hazard, so it keeps its trivial
	// order.
	let order: readonly number[];
	if (analysis.sides.length === 2 && sides.length === 2) {
		const fanoutOrder = orderDeleteFanout(analysis.sides);
		if (fanoutOrder === undefined) {
			if (joinCorrelatesMutualFk(analysis)) {
				const [a, b] = analysis.sides;
				raiseMutationDiagnostic({
					reason: 'mutual-fk-restrict-delete',
					table: view.name,
					message: `cannot delete through view '${view.name}': the joined row spans a mutual foreign key ('${a.schema.name}'↔'${b.schema.name}') whose ON DELETE actions cannot be satisfied in either order under immediate FK enforcement (deleting either side trips the other's RESTRICT, directly or transitively through a cascade); break the cycle outside the view — null out the referencing column(s) first, or restructure the offending ON DELETE action — before deleting through the view (a 'deferrable initially deferred' declaration does not help: RESTRICT is enforced immediately regardless)`,
				});
			}
			// No mutual FK edge is correlated by the join — defer to the runtime
			// RESTRICT pre-check on the real data via the fixed fan-out order.
			order = [0, 1];
		} else {
			order = fanoutOrder;
		}
	} else {
		// Single side, or an n-way (>2) fan-out. Delete in **reverse** FK-topological
		// order — FK-CHILD before FK-parent — so a child's referencing row is gone before
		// its parent row is deleted (the canonical columnar-split shape: each member's PK
		// references the anchor's). The forward (parent-first) order trips the parent's
		// inbound RESTRICT/NO-ACTION under immediate FK enforcement and aborts the whole
		// statement. Child-first is unconditionally FK-safe (deleting a referencing row
		// never trips a constraint on the referenced row, for any ON DELETE action), so it
		// is the right default for both RESTRICT and CASCADE; a mutual-FK cycle still
		// defers wholesale to the runtime RESTRICT pre-check. A single-side delete reverses
		// a one-element order (a no-op). The eager up-front key capture makes the order
		// purely an FK-enforcement concern — identity is fixed before any op fires.
		order = orderSides(analysis.sides).filter(i => sides.includes(i)).reverse();
	}
	const ops: BaseOp[] = [];
	for (const sideIndex of order) {
		const side = analysis.sides[sideIndex];
		const where = buildCapturedKeyPredicate(view, side, sideIndex);
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
 * candidate side ("make this joined row not exist"). Returns 1 or more sides.
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
	// The candidate set defaults to the **preserved** side(s) — deleting the preserved
	// side is the only way the joined row leaves the view (§ Outer Joins — Deletes).
	// Inner joins are all-preserved (⇒ the full set, unchanged). A `full` outer join has
	// no preserved side (each side is both preserved and non-preserved per row), so a
	// statically-routed delete is not expressible — defer it.
	const preserved = preservedSideIndices(analysis.sides);
	if (preserved.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot delete through view '${view.name}': a FULL outer join has no preserved side to route the delete to (each side is both preserved and non-preserved per row); deleting through a full-outer view is deferred`,
		});
	}
	const candidates = applyTargetExclude(preserved, analysis.sides, tags, view);

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

	// lenient + ≥2 residual candidates + no provable single-direction FK-child default +
	// no side tag: fan out to every candidate side (the predicate-honest multi-side
	// delete). `fkChildIndex` is binary, so for an n-way (>2) join it is undefined and
	// the fan-out is the whole candidate set.
	return candidates;
}

/**
 * The single base side an explicit `delete_via` names for a join. `'parent'`
 * selects the FK-parent (requires a provable foreign key); `'left_delete'`
 * selects the left join source. `'right_insert'` is an `except`-branch value
 * with no join meaning — rejected with a pointer to the join-valid forms.
 */
function resolveDeleteViaSide(deleteVia: DeleteViaValue, sides: readonly JoinSide[], view: MutableViewLike): number {
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
	sides: readonly JoinSide[],
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
 * Strip the owning side's alias qualifier from a base-term assignment value (so it
 * targets the single-table UPDATE directly). A reference to **any other side** cannot
 * be expressed as a single-table SET, so it is either captured-and-rewritten (when a
 * `registerCrossSource` carrier is supplied — § Inner Join, cross-source `set`) or
 * rejected (`cross-source-assignment`, the legacy path). The strip is threaded into any
 * subquery embedded in the value (the qualifier rule is purely about a column's own
 * table qualifier, so it applies uniformly at every nesting depth); a nested owning-side
 * reference is correlated to the target row of the lowered UPDATE just like a top-level
 * one.
 *
 * The owning-side qualifier set is checked **first**, so a self-join (where an `other`
 * side shares the owning side's table name) still strips an owning-alias reference; only
 * a reference qualified by a *different alias* is the cross-source case.
 *
 * A cross-source read is rewritten to `(select <srcN> from __vmupd_keys k where
 * k.k<owningSide>_0 = <pk0> [and …])`: `registerCrossSource` projects the partner column
 * into the capture under `srcN` and returns the alias; the unqualified `<pk_j>` bind to
 * the lowered UPDATE's own target row, so each row reads the captured pre-mutation
 * partner value of its joined row. The cross-source gate (`gateCrossSourceReads`) has
 * already proved every reached partner column has `base` lineage.
 */
function stripSideQualifier(
	expr: AST.Expression,
	view: MutableViewLike,
	owning: JoinSide,
	owningSideIndex: number,
	others: readonly JoinSide[],
	registerCrossSource: ((col: AST.ColumnExpr) => string) | undefined,
): AST.Expression {
	const owningQuals = new Set([owning.alias, owning.schema.name.toLowerCase()]);
	const otherQuals = new Set<string>();
	for (const o of others) {
		otherQuals.add(o.alias);
		otherQuals.add(o.schema.name.toLowerCase());
	}
	// The owning side's PK — the correlation a captured cross-source read binds on.
	// Resolved lazily (only a cross-source rewrite needs it).
	let owningPk: readonly string[] | undefined;
	const substitute = (col: AST.ColumnExpr): AST.Expression | undefined => {
		if (!col.table) return undefined;
		const t = col.table.toLowerCase();
		if (owningQuals.has(t)) return { type: 'column', name: col.name };
		if (otherQuals.has(t)) {
			if (!registerCrossSource) {
				raiseMutationDiagnostic({
					reason: 'cross-source-assignment',
					column: col.name,
					table: view.name,
					message: `cannot write through view '${view.name}': an update value references column '${col.name}' on a different base table than the column it assigns; cross-source assignment is not supported`,
				});
			}
			const srcAlias = registerCrossSource(col);
			owningPk ??= requireKeyColumns(view, owning);
			return capturedValueSubquery(srcAlias, owningSideIndex, owningPk);
		}
		return undefined;
	};
	return transformExpr(expr, substitute, (q) => mapQueryExprUniform(q, substitute));
}

/**
 * The correlated scalar read a cross-source SET value lowers to:
 * `(select <srcAlias> from __vmupd_keys k where k.k<owningSide>_0 = <pk0> [and …])`
 * — `<srcAlias>` is the capture projection of the partner base column; the unqualified
 * `<pk_j>` bind to the lowered UPDATE's own target row (the owning side), matching the
 * per-side identifying EXISTS so each target row reads the captured pre-mutation partner
 * value of its joined row. Composite owning keys conjoin one equality per PK column.
 */
function capturedValueSubquery(srcAlias: string, owningSideIndex: number, owningPk: readonly string[]): AST.Expression {
	const conds = owningPk.map((pk, j): AST.Expression => ({
		type: 'binary',
		operator: '=',
		left: { type: 'column', name: keyColumnName(owningSideIndex, j), table: 'k' },
		right: { type: 'column', name: pk },
	}));
	return {
		type: 'subquery',
		query: {
			type: 'select',
			columns: [{ type: 'column', expr: { type: 'column', name: srcAlias, table: 'k' } }],
			from: [{ type: 'table', table: { type: 'identifier', name: MS_UPDATE_KEYS_CTE }, alias: 'k' }],
			where: conds.reduce((acc, c) => combineAnd(acc, c)!),
		},
	};
}

/**
 * Reject a cross-source value read whose partner-side view column is **not** `base`
 * (computed / non-invertible) — its value is not recoverable from a captured base
 * column, so the cross-source rewrite cannot carry it (`no-inverse`; an outer-join
 * `null-extended` partner is already rejected wholesale upstream). A same-side read (the
 * column reads only the assigned side) is left to the qualifier strip; a `base` partner
 * column is admitted and captured. Walks only the value's top-level column references
 * (the scope `guardTopLevelScope` already proved are view columns); a reference nested in
 * a value subquery is left to the qualifier strip's per-leaf handling.
 */
function gateCrossSourceReads(value: AST.Expression, owningSideIndex: number, analysis: JoinViewAnalysis, view: MutableViewLike): void {
	forEachTopLevelColumnRef(value, (col) => {
		const vco = analysis.outColumns.find(c => c.name === col.name.toLowerCase());
		if (!vco) return; // guardTopLevelScope already proved top-level refs are view columns
		const readSides = viewColumnReadSides(vco, analysis);
		const crossSource = [...readSides].some(s => s !== owningSideIndex);
		if (crossSource && !vco.writable) {
			raiseMutationDiagnostic({
				reason: 'no-inverse',
				column: vco.displayName,
				table: view.name,
				message: `cannot write through view '${view.name}': the update value reads computed column '${vco.displayName}' on a different base table than the column it assigns; a cross-source read requires the partner column to have base lineage`,
			});
		}
	});
}

/**
 * The set of join-side indices a view column's value reads. A `base` site reads only
 * its owning side; a computed site reads every side its base-term expression's column
 * leaves resolve to (so a same-side computed read stays admissible while a cross-source
 * computed read is rejected).
 */
function viewColumnReadSides(vco: OutColumn, analysis: JoinViewAnalysis): Set<number> {
	if (vco.writable && vco.sideIndex !== undefined) return new Set([vco.sideIndex]);
	const sides = new Set<number>();
	const expr = analysis.viewColToBaseRef.get(vco.name);
	if (expr) {
		forEachColumnRefDeep(expr, (col) => {
			const s = resolveColumnSide(col, analysis.sides);
			if (s !== undefined) sides.add(s);
		});
	}
	return sides;
}

/** Observe every TOP-LEVEL column reference in an expression (no subquery descent). */
function forEachTopLevelColumnRef(expr: AST.Expression, fn: (col: AST.ColumnExpr) => void): void {
	transformExpr(expr, (col) => { fn(col); return undefined; });
}

/** Observe every column reference in an expression, descending into subqueries. */
function forEachColumnRefDeep(expr: AST.Expression, fn: (col: AST.ColumnExpr) => void): void {
	const observe = (col: AST.ColumnExpr): AST.Expression | undefined => { fn(col); return undefined; };
	transformExpr(expr, observe, (q) => mapQueryExprUniform(q, observe));
}

// --- helpers --------------------------------------------------------------

function tableIdentifier(table: TableSchema): AST.IdentifierExpr {
	return { type: 'identifier', name: table.name, schema: table.schemaName };
}

/**
 * The side's primary-key column names (≥1), in declaration order — the per-side
 * identifying key the capture projects and the base ops' EXISTS correlates on.
 * Composite keys are admitted (each PK column contributes a `k<side>_<j>` capture
 * column); a keyless table is the only reject (`unsupported-join`).
 */
function requireKeyColumns(view: MutableViewLike, side: JoinSide): string[] {
	const pk = side.schema.primaryKeyDefinition;
	if (pk.length === 0) {
		raiseMutationDiagnostic({
			reason: 'unsupported-join',
			table: view.name,
			message: `cannot write through view '${view.name}': base table '${side.schema.name}' has no primary key; multi-source identifying predicates need a key`,
		});
	}
	return pk.map(def => side.schema.columns[def.index].name);
}

/**
 * True when `fk` (declared on `child`) targets `parent` — the shared FK-match
 * predicate: case-insensitive `referencedTable` against the parent's name, with an
 * absent `referencedSchema` defaulting to the child's own schema. The single source
 * of truth for "does this declared FK reference that side", reused by
 * {@link fkChildIndex}, {@link inboundDeleteAction}, and {@link edgeCorrelated}.
 */
function fkTargetsSide(fk: ForeignKeyConstraintSchema, child: JoinSide, parent: JoinSide): boolean {
	return fk.referencedTable.toLowerCase() === parent.schema.name.toLowerCase()
		&& (fk.referencedSchema ?? child.schema.schemaName).toLowerCase() === parent.schema.schemaName.toLowerCase();
}

/** True when `child` declares any foreign key onto `parent`. */
function sideDeclaresFkOnto(child: JoinSide, parent: JoinSide): boolean {
	return (child.schema.foreignKeys ?? []).some(fk => fkTargetsSide(fk, child, parent));
}

/**
 * Index of the FK-child (many) side of a **two-side** join: the side declaring a
 * foreign key onto the other. `undefined` when no FK is provable, both sides reference
 * each other (mutual), or the join is not two-sided (the binary FK-child concept does
 * not generalize past two sides — the n-way delete fan-out / `orderSides` topo sort
 * handle >2). Used by the two-side delete routing (`chooseDeleteSides`,
 * `resolveDeleteViaSide`).
 */
function fkChildIndex(sides: readonly JoinSide[]): number | undefined {
	if (sides.length !== 2) return undefined;
	const zeroRefsOne = sideDeclaresFkOnto(sides[0], sides[1]);
	const oneRefsZero = sideDeclaresFkOnto(sides[1], sides[0]);
	if (zeroRefsOne && !oneRefsZero) return 0;
	if (oneRefsZero && !zeroRefsOne) return 1;
	return undefined;
}

/**
 * Side execution order: an FK **topological sort** over the n sides — every FK-parent
 * precedes its FK-child — stable by source order within an FK-equivalence class. A
 * mutual FK (each side referencing the other, e.g. a self-join's two aliases of one
 * self-referencing table) forms a cycle with no zero-in-degree head; it is broken by
 * lowest source index, i.e. it falls back to **alias-declaration order** (§ Cycles,
 * Self-Joins). The two-side binary order (`[parent, child]` / `[0, 1]`) is the n=2
 * specialization of this.
 */
function orderSides(sides: readonly JoinSide[]): number[] {
	const n = sides.length;
	// parents[child] = set of side indices the child must follow (its declared FK parents).
	const parents: Array<Set<number>> = sides.map(() => new Set<number>());
	for (let child = 0; child < n; child++) {
		for (let parent = 0; parent < n; parent++) {
			if (child !== parent && sideDeclaresFkOnto(sides[child], sides[parent])) parents[child].add(parent);
		}
	}
	const placed = new Set<number>();
	const order: number[] = [];
	while (order.length < n) {
		// Lowest-index unplaced side all of whose (non-self, unplaced-cycle-aside) parents
		// are already placed.
		let pick = -1;
		for (let i = 0; i < n; i++) {
			if (placed.has(i)) continue;
			if ([...parents[i]].every(p => placed.has(p))) { pick = i; break; }
		}
		// A cycle (mutual FK) leaves no ready node — break it by lowest unplaced index
		// (source / alias-declaration order).
		if (pick === -1) {
			for (let i = 0; i < n; i++) if (!placed.has(i)) { pick = i; break; }
		}
		order.push(pick);
		placed.add(pick);
	}
	return order;
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
	let governing: AST.ForeignKeyAction | undefined;
	for (const fk of child.schema.foreignKeys ?? []) {
		if (!fkTargetsSide(fk, child, parent)) continue;
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
function orderDeleteFanout(sides: readonly JoinSide[]): readonly number[] | undefined {
	const inbound0 = inboundDeleteAction(sides[1], sides[0]); // governs deleting side0
	const inbound1 = inboundDeleteAction(sides[0], sides[1]); // governs deleting side1
	if (deletableFirst(inbound0, inbound1)) return [0, 1];
	if (deletableFirst(inbound1, inbound0)) return [1, 0];
	return undefined;
}

/**
 * Canonical (order-independent) key for a cross-side column equality, so a join
 * conjunct written either way (`b.aref = a.aid` or `a.aid = b.aref`) hashes the
 * same and an edge lookup need not know which operand the join named first.
 */
function crossEqualityKey(sideA: number, colA: string, sideB: number, colB: string): string {
	const a = `${sideA}:${colA.toLowerCase()}`;
	const b = `${sideB}:${colB.toLowerCase()}`;
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Resolve a join-condition column operand to its owning side index (`0..n-1`), or
 * `undefined` when the reference cannot be pinned to exactly one side. An explicit
 * `.table` qualifier matches a side's `alias` (already lowercased) or `schema.name`
 * (alias preferred, so a self-join's distinct aliases resolve unambiguously even
 * though the table names collide); an unqualified ref resolves by **unique** ownership
 * of `col.name` across the sides' columns. An ambiguous / unresolved ref returns
 * `undefined` (conservative — a term that cannot be placed cannot prove correlation).
 */
function resolveColumnSide(col: AST.ColumnExpr, sides: readonly JoinSide[]): number | undefined {
	const qualifier = col.table?.toLowerCase();
	if (qualifier !== undefined) {
		const idx = sides.findIndex(s => s.alias === qualifier || s.schema.name.toLowerCase() === qualifier);
		return idx < 0 ? undefined : idx;
	}
	const colName = col.name.toLowerCase();
	const owners = sides.flatMap((s, i) => s.schema.columns.some(c => c.name.toLowerCase() === colName) ? [i] : []);
	return owners.length === 1 ? owners[0] : undefined;
}

/**
 * True when the FK on side `childIdx` referencing side `parentIdx` is **correlated**
 * by the join — i.e. the join's cross-side equalities force the child's FK column(s)
 * equal to the parent's referenced column(s) for *every* `(childCol, refCol)` pair,
 * so a joined partner necessarily references the deleted row (a RESTRICT necessarily
 * fires). Matches the same `referencedTable` / `referencedSchema` predicate as
 * {@link fkChildIndex}; any one matching FK whose whole column pairing is equated
 * makes the edge correlated.
 */
function edgeCorrelated(
	childIdx: number,
	parentIdx: number,
	crossEqualities: ReadonlySet<string>,
	sides: readonly JoinSide[],
): boolean {
	const child = sides[childIdx];
	const parent = sides[parentIdx];
	return (child.schema.foreignKeys ?? []).some(fk => {
		if (!fkTargetsSide(fk, child, parent)) return false;
		const refIndices = resolveReferencedColumns(fk, parent.schema);
		if (refIndices.length !== fk.columns.length) return false;
		return fk.columns.every((childColIdx, i) => {
			const childCol = child.schema.columns[childColIdx].name;
			const refCol = parent.schema.columns[refIndices[i]].name;
			return crossEqualities.has(crossEqualityKey(childIdx, childCol, parentIdx, refCol));
		});
	});
}

/**
 * Whether the view's join **provably correlates at least one mutual FK edge** — the
 * gate on the plan-time `mutual-fk-restrict-delete` reject (§ Inner Join — Deletes).
 * Reached only when {@link orderDeleteFanout} found no feasible order (a mutual FK
 * whose actions no order can satisfy). The two mutual edges mirror the
 * {@link fkChildIndex} match: edgeA = the FK on side0 referencing side1, edgeB = the
 * FK on side1 referencing side0. An edge is *correlated* when the join's cross-side
 * column equalities force that FK's child column(s) equal to the parent's referenced
 * column(s) — so the joined partner necessarily references the deleted row and a
 * RESTRICT necessarily fires.
 *
 * Cross-side equalities are collected from the join ON condition (`sel.from[0]` is the
 * single `join`) **and** the body WHERE, flattened on `AND`, keeping each conjunct
 * that is `column = column` with both operands resolving to *different* sides
 * ({@link resolveColumnSide}; an unresolved/ambiguous/same-side term is skipped —
 * conservatively, it cannot prove correlation).
 *
 * Returns `true` iff **at least one** edge is correlated. A non-FK join (or a join on
 * non-FK columns) correlates neither edge ⇒ `false`, and the caller falls back to the
 * fixed-order fan-out, deferring to the runtime RESTRICT pre-check on the real data.
 * This is a strict *reduction* of over-rejection, not perfect precision: a join that
 * correlates one edge whose *other* edge's FK columns happen to be NULL at delete time
 * is still rejected (indistinguishable at plan time from the (fo-h) data-referencing
 * shape — accepted residual conservatism).
 */
function joinCorrelatesMutualFk(analysis: JoinViewAnalysis): boolean {
	const conjuncts: AST.Expression[] = [];
	const join = analysis.sel.from?.[0];
	if (join && join.type === 'join' && join.condition) conjuncts.push(...flattenAnd(join.condition));
	if (analysis.sel.where) conjuncts.push(...flattenAnd(analysis.sel.where));

	const crossEqualities = new Set<string>();
	for (const conj of conjuncts) {
		if (conj.type !== 'binary' || conj.operator !== '=') continue;
		if (conj.left.type !== 'column' || conj.right.type !== 'column') continue;
		const leftSide = resolveColumnSide(conj.left, analysis.sides);
		const rightSide = resolveColumnSide(conj.right, analysis.sides);
		if (leftSide === undefined || rightSide === undefined || leftSide === rightSide) continue;
		crossEqualities.add(crossEqualityKey(leftSide, conj.left.name, rightSide, conj.right.name));
	}

	return edgeCorrelated(0, 1, crossEqualities, analysis.sides)
		|| edgeCorrelated(1, 0, crossEqualities, analysis.sides);
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
