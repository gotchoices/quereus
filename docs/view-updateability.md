# View Updateability

## Status

This document is the decided design (the source of truth for *intent*). What has
actually shipped:

| Phase | Scope | State |
|---|---|---|
| **Phase 1** | Single-source projection-and-filter views: `insert` / `update` / `delete` route to the base table. Constant-FD defaults from equality selection predicates, base-column defaults, identity/rename projection lineage, `OR`-clause conflict resolution, and the `no-inverse` / `predicate-contradiction` / `recursive-cte` / body-shape diagnostics. | **Shipped** |
| **Phase 1b** | Per-statement mutation-context threading through the view boundary (one captured value stamped across every base row of the statement). Single-base per-row generator cadence rides the base table's column defaults. | **Shipped (single-base)** |
| **Phase 2a** | Multi-source **key-preserving inner-join** bodies: `update` / `delete` write-through. Decomposes to an ordered multi-element `BaseOp[]` (one per owning side, FK-parent before FK-child), routing each output column to its owning base table via the planned body's `updateLineage`, and identifying rows by a subquery over the join body. `delete` routes to the FK-many (child) side by default. | **Shipped (update / delete)** |
| **Phase 3.4** | The `quereus.update.*` **tag override surface**: `target` / `exclude` narrow the multi-source candidate base set; `delete_via` (`parent` / `left_delete`) picks the deletion side; `default_for.<col>` supplies an omitted-insert default; `policy` selects strict-vs-lenient ambiguity handling. Read + site-validated through the typed registry (`schema/reserved-tags.ts`), collected at the view-DDL and DML-statement sites (`WITH TAGS (...)`), merged statement-over-view. | **Shipped** (the lenient predicate-honest *multi-side delete fan-out* is deferred — see § Inner Join) |
| **Phase 2b** | Multi-source **key-preserving inner-join `insert`** write-through, plus the per-row **shared-surrogate mutation-context envelope** it requires. The shared join key is not a view column, so an insert mints a surrogate **once per produced logical row at the envelope, before propagation fans out**, and threads the one captured value into both base inserts (FK-parent before FK-child). The key is either **directly supplied** (a view column maps to a join-key base column) or **minted** (`integer-auto` / `per-row`: `seed + ordinal`, `seed = max(anchor.key)` captured once). Realized by materializing the augmented source once (`ViewMutationNode.envelope` + `EnvelopeScanNode`) so every base op reads the identical rows. | **Shipped (two-table inner join)** |
| **Phase 3.7** | **RETURNING-through-views.** `insert` / `update` / `delete … returning` returns rows projected through the **view's** column list, evaluated against the post-mutation base state (computed view columns re-evaluated). Single-source: the clause is rewritten into base terms and rides the base op's RETURNING (NEW for insert/update, OLD for delete) — `ViewMutationNode` becomes relational and surfaces it. Multi-source inner-join `update` / `delete`: the rows are produced by a re-query of the view restricted to the mutation's predicate (captured before a delete, after an update). `returning *` expands to the view's columns. | **Shipped (single-source all ops; multi-source update / delete)** |
| Phase 2b+ | Multi-source-**`insert`** RETURNING (needs the minted surrogate threaded into the projection), outer-join / optional-member insert, set-ops, aggregates, nested/recursive CTE bodies, composite-key and `> 2`-table joins, self-joins, cross-source `set` values, `declared-default`-expression and non-integer surrogate generators, multi-source-`insert` `default_for`. | Not shipped — rejected at plan time with a structured diagnostic. |

**Implementation note (Phase 1).** Phase 1 ships **via the view-mutation
substrate** (single-source = one base op). A view-targeted DML whose body
classifies as a single-source projection-and-filter (gate in
`planner/mutation/propagate.ts`) is **decomposed** by `propagate(ctx, view, req)`
into an ordered `BaseOp[]` — exactly one for the single-source spine — whose
`.statement` is the equivalent base-table DML. `planner/building/view-mutation-builder.ts`
re-plans each base op through the ordinary base-table builder and wraps the
results in a `ViewMutationNode` (`planner/nodes/view-mutation-node.ts`, emitter
`runtime/emit/view-mutation.ts`). The single-source rewrite itself lives in
`planner/mutation/single-source.ts`. All constraint / conflict / FK /
mutation-context machinery — and `getChangeScope()` / `Database.watch` — are
therefore reused verbatim with no view-specific runtime (the wrapped subtree is
byte-identical to what the retired AST rewrite re-planned). The standalone AST
rewrite (`planner/building/view-mutation.ts`) is **removed**; the substrate is
the single propagation path for all view mutations. The shipped lineage model
lives in `planner/analysis/update-lineage.ts` and
`planner/analysis/scalar-invertibility.ts`.

The plan-node-threaded `updateLineage` / `AttributeDefault` surface on
`PhysicalProperties` (§ Implementation Surface) **has landed** as the *annotation
layer* — `view-mutation-physical-lineage` threads it as the derived dual of each
operator's forward FD walk (TableReference / Project / Filter / Join, plus
pass-through on the access / Retrieve / Alias boundary nodes), surfaces it through
`query_plan()`, and exposes the predicate-honest complement (`viewComplement`).
The `ViewMutationNode` substrate **has landed** as the single propagation path
for all view mutations: the single-source case decomposes to exactly one base op
(parity-equivalent to the retired AST rewrite). The **multi-source** backward
walk — the substrate emitting *more than one* base op — **has landed for the
key-preserving inner-join `update` / `delete` case** (`planner/mutation/multi-source.ts`):
a join body routes here, where the planned body's `updateLineage` decides each
output column's owning base table and a subquery over the join body reconstructs
the per-side row-identifying predicate (lowered back to AST so the base builders
are reused untouched). RETURNING through a multi-source `update` / `delete` is
supported via a re-query of the view (see § `returning` Clauses); the per-side
base ops carry no RETURNING. What the surface is **not yet** consumed by is the
multi-source **insert** RETURNING (which needs the shared-surrogate key threaded
into the projection) and the broader join shapes (outer / set-op / aggregate /
`> 2`-table / self-join), all still rejected. The retire-or-keep
decision is settled under `view-mutation-plan-node-substrate`: the AST rewrite is
**retired** in favor of the substrate; `building/view-mutation.ts` has been
removed (the single-source rewrite it held now lives in
`planner/mutation/single-source.ts`, behind `propagate`).

> **Surface authority.** `updateLineage` is computed in `computePhysical`, so it
> is available on the **logical** operator tree (Project / Filter / Join /
> TableReference) the substrate walks. It survives optimization through the
> pass-through boundary nodes (access scans, Retrieve, Alias) but **not** through
> operators that rewrite structure (physical `HashJoin` / `MergeJoin`, aggregates,
> set-ops, Sort/Limit/Distinct), which do not yet thread it. EXPLAIN /
> `query_plan()` therefore shows full lineage for single-source projection-filter
> shapes and on every TableReference; a join's optimized top node shows degraded
> (`computed`) lineage. The logical operator tree is authoritative.

**Write-through materialized views** are **delivered** for the passthrough /
projection-filter shape (`materialized-view-dml-write-through`): DML targeting an MV
name is routed through this same substrate (rewritten to its source table, one base op),
then the row-time maintenance hook syncs the backing within the statement
(reads-own-writes; rollback in lockstep). The MV path inherits the per-column lineage
rules verbatim — passthrough/rename columns are writeable, computed columns are
read-only (`no-inverse`), and RETURNING is supported (single-source, so the rewritten
clause rides the base op). An MV whose source is *itself* a materialized view is rejected
for write-through (its rewrite would target a read-only backing table). See
[docs/materialized-views.md § Write boundary](materialized-views.md#write-boundary-write-through).

## Overview

Quereus treats views, CTEs, and subqueries-in-`from` uniformly: any relation expression that can be written as a `select` can also be the target of an `insert`, `update`, or `delete`. The engine derives the required base-table operations from the relation's predicate, its functional-dependency surface, and the per-operator semantics described below.

### View-body forms

A view body is any relation-producing `QueryExpr` except DML:

- **`SELECT`**: the canonical case. Updateability is FD-driven per the rules below.
- **`VALUES (…), …`**: a literal row set. The body has no base-table lineage,
  so the FD walker reaches no `TableReferenceNode`; the view is read-only.
  Insert / update / delete against a `VALUES`-bodied view raises the standard
  "no recoverable base operation" diagnostic.
- **`INSERT/UPDATE/DELETE … RETURNING`**: **rejected at view-creation time.**
  A view body re-evaluates on every reference; a DML body would re-drive the
  write per read, which is incoherent with view semantics. Mutations belong
  in the statement that *references* the view, not in the view body.

There is no `with check option`. There is no `instead of` trigger surface. There is no view-level flag declaring updateability. A relation is updateable iff a deterministic decomposition exists at plan time; if it does not, the mutation surfaces a structured diagnostic naming the operator and column that obstructed propagation.

## Philosophy: Predicates Rule

A mutation against a relation is a predicate over base-table state. The engine finds the smallest set of base-table operations whose post-state satisfies that predicate.

- **Insert** = "make this row exist in the relation"
- **Update** = "for rows matching this predicate, change these columns to these values"
- **Delete** = "make these rows not exist in the relation"

For n-ary operators (union, intersect, except, join), the default policy is **fan out to every branch whose own predicate is consistent with the mutation's row-identifying predicate**. The user controls fan-out by adding predicates (narrowing the rows to a single branch) or by attaching tags (overriding the default routing). The engine never silently drops one of several consistent branches.

The classical view-update ambiguity (Bancilhon–Spyratos) only arises when one chooses to suppress effects on some branches. Quereus does not suppress: a mutation routed to *every* satisfying branch is unambiguous by construction. The cost is that mutations can produce more base-table operations than a one-branch policy would, but this is the honest reading of the predicate.

## The Update Site Model

Every relational `PlanNode` carries an `updateLineage` field mapping each output attribute to one of:

- **`base`** — the column traces to a base-table column through a chain of invertible transformations. The chain is recorded so the engine can compose a setter expression on the base column.
- **`computed`** — the column is the output of a non-invertible expression over inputs; it is read-only. Reads pass through; writes against this column are rejected with a diagnostic naming the originating expression.
- **`null-extended`** — the column is potentially null-extended by an outer join; updates require materialization of the missing side (see §Outer Joins).

Lineage is computed in a single pass that mirrors the optimizer's physical-property pass, reusing the functional-dependency framework (see [Optimizer §Functional Dependency Tracking](optimizer.md#functional-dependency-tracking)) to thread per-column provenance through every operator. Equivalence classes propagate writeability: if `a.x` and `b.y` belong to the same EC, a write to either reaches both bases. Constant FDs (`∅ → c = v`) supply default values without authorial intervention.

## Mutation Propagation

A mutation statement is built like a query: parser → planner → optimizer. After the relation tree is finalized, a **propagation pass** walks the tree from the user-visible top-level relation down to base-table references, emitting a list of base-table operations.

```
UserMutation(M)
   ├─ relation R
   └─ propagate(R, M) → list of BaseOp
```

Each operator implements `propagateMutation(childRelations, op) → childOps` with the per-operator semantics described below. Propagation terminates at `TableReferenceNode`s, each of which receives a fully-resolved per-base operation.

The complete list of base operations executes atomically within the statement's transaction. If any operation fails (constraint, conflict resolution, store error), the entire statement aborts under the prevailing conflict-resolution mode.

### Identifying Predicates

Updates and deletes carry a **row-identifying predicate** built from base-table primary keys traced through the lineage. For a relation whose lineage proves `(b1.pk, b2.pk, ...)` is a superkey at the top, the row-identifying predicate is the equality on those PKs. The propagation pass uses this predicate to bind the per-base operations to specific underlying rows.

Inserts carry an **existence predicate** constructed from the inserted column values: `c1 = v1 ∧ c2 = v2 ∧ ...`. The predicate is symbolic — values may be expressions, parameters, mutation-context bindings, or `default`. It drives branch dispatch at every n-ary operator and supplies values for missing columns via equivalence-class lookup.

### Branch Consistency

When propagation reaches an n-ary operator, it evaluates each branch's accumulated predicate (the conjunction of every selection on the path from this operator to a base table) against the mutation's predicate using the same predicate-normalizer and FD/EC pipeline used by the optimizer:

- **Provably consistent**: the mutation fans out to that branch.
- **Provably inconsistent**: the branch is skipped.
- **Unknown**: the branch is included. The engine prefers honest fan-out over silent suppression.

## Per-Operator Semantics

The rules below apply identically to view bodies, CTE bodies, subqueries in `from`, and the inline target of `update (select ...) set ...`.

### Projection

**Updates** pass through unchanged: assignments are rewritten against the underlying columns named by the projection.

**Inserts** must supply values for every base-table column for which the insert's value list does not. Sources are consulted in order:

1. The insert's value list (after applying the inverse of any scalar transformation in the projection).
2. **Constant FD** — a column constrained to a constant by an upstream selection predicate (i.e., the relation carries the FD `∅ → c = v`) takes that constant.
3. **FD reconstruction** — a column functionally determined by other surviving / supplied columns is reconstructed symbolically from the FD's right-hand side.
4. **EC propagation** — a column in an equivalence class with a supplied column or a constant takes the EC representative's value.
5. The view's `default_for` tag (expression over surviving columns).
6. The base column's declared `default` — including a **generated default** (sequence, surrogate allocator, clock read), which resolves through the mutation-context envelope (§Mutation Context) at per-row cadence and, when the column is a shared join key, threads the one captured value through every branch of the decomposition.
7. For nullable columns, `null`.

If a `not null` column has no value after this chain, the insert is rejected with a structured diagnostic naming the column.

The constant-FD step (#2) is the mechanism by which `where`-clause constants become defaults. It applies whether the constrained column is projected away or survives. Two examples:

```sql
create view GreenMen as select * from Men where Color = 'green';
insert into GreenMen (Name) values ('Bob');   -- Color defaults to 'green'

create view AdultsBare as select Name, Age from Adults where Country = 'US';
insert into AdultsBare values ('Bob', 30);    -- Country defaults to 'US' (projected away)
```

Both cases reduce to the same rule: the selection predicate contributes a constant FD to the relation; the propagation pass reads that FD when filling missing values. Equality-with-constant is the simplest producer of such an FD, but any predicate that the optimizer's existing predicate-normalizer reduces to a constant binding contributes the same way — `where year >= 2026 and year <= 2026`, `where status in ('A')`, and `where coalesce(flag, false) = true and flag is not null` all qualify.

Columns dropped by the projection but functionally determined by surviving columns need no default at all, by the same mechanism applied during the lineage walk.

**Deletes** pass through unchanged.

### Selection (σ)

The selection's predicate is conjoined with the mutation's predicate at every step:

- **Updates** propagate to the child with `parent_predicate ∧ user_predicate`. An update whose assignment would carry a row outside the selection's predicate is not blocked — it succeeds in the base, and the row ceases to be visible through the relation. This is the literal reading: the user wrote a base-level update through a windowed view; the engine performs that update.
- **Inserts** conjoin the selection's predicate into the existence predicate. If the inserted values contradict the selection (provable at plan time via constant folding and EC), the engine rejects with a diagnostic. If they satisfy the predicate, the row is inserted into the base and is visible through the relation. If satisfiability is unknown at plan time, the insert proceeds; visibility is decided by base data. Constant bindings produced by the selection (e.g., `where color = 'green'` ⇒ FD `∅ → color = 'green'`) are picked up by the projection's insert defaulting rule (§Projection), so omitting the constrained column from the insert is permitted and the value is supplied automatically.
- **Deletes** propagate to the child with `parent_predicate ∧ user_predicate`.

> **View columns nested inside a predicate / assigned-value subquery.** A
> view-column reference inside a `subquery` / `exists` / `in`-subquery operand of
> the user predicate (or a `set` value) is rewritten to its base-term lineage
> just like a top-level reference — `mutation/single-source.ts`'s `transformExpr`
> descends into the operand via `transformQueryExpr` (the multi-source spine
> threads the same descent through `substituteViewColumns`). The descent is
> **scope-aware**: a reference is substituted only when it is genuinely correlated
> to the outer view row — qualified by the view name, or unqualified and *not*
> shadowed by a column some source local to the subquery introduces. A
> base-alias-qualified reference, or a name a subquery-local source defines
> (`… in (select note from src)` where `src.note` exists), is left untouched. When
> the subquery's source columns cannot be resolved statically (a `select *`
> subquery source, a table-valued function, an embedded data-modifying subquery),
> the descent cannot prove a nested reference is correlated and rejects it with the
> structured `unsupported-subquery-correlation` diagnostic rather than risk a
> silent mis-bind. (Before this, such a nested reference was passed through
> un-rewritten and could silently re-bind to a same-named base column — a silent
> wrong write.)
>
> **Single-source: the substituted base *term* is correlation-qualified.** Deciding
> *whether* to substitute is only half the fix. The single-source rewrite renames a
> view column to a bare base term (`note` → `lbl`), and an *unqualified* `lbl`
> emitted inside a subquery operand re-binds, by ordinary innermost-scope SQL rules,
> to a same-named source the subquery's own FROM introduces — not to the outer
> UPDATE/DELETE target row. So the single-source descent qualifies the substituted
> term with the base table name (`p1_t.lbl`, via `qualifyUnqualifiedRefs` threaded as
> `baseQualifier` through `makeViewColumnDescend` → `transformQueryExpr` →
> `makeViewSubstitute`), which is exactly the table named by the lowered statement
> (no synthesised alias), so it correlates to the outer row regardless of what the
> subquery FROM defines. This is applied **only** on the subquery-descent path: the
> top-level user WHERE / SET and the RETURNING projection columns resolve against the
> lowered statement's single source unqualified, and the multi-source spine passes no
> `baseQualifier` because its terms are already alias-qualified (`p.label`) and there
> is no single base-table correlation name. Only a *substituted* term (a view column)
> is qualified — a bare base-name reference (`lbl`) is never a view column, so a
> subquery-local source that genuinely defines it keeps binding locally, unchanged.
>
> *Known corner (unfixed):* if the subquery FROM names the **same base table**
> (`update p1_v … where exists (select 1 from p1_t where …)`), the base-table-name
> qualifier (`p1_t.lbl`) binds to the innermost local `p1_t`, not the outer target —
> an inherent SQL self-reference scoping ambiguity the single-source lowering (no
> alias on the target) cannot disambiguate. This is no worse than the pre-fix
> behaviour and is rare; a future hardening could synthesise an alias on the lowered
> target.

### Inner Join

> **Shipped (Phase 2a) — `update` / `delete` only.** A two-table inner equi-join
> body decomposes through `planner/mutation/multi-source.ts`. Each output column is
> routed to its owning base table by the planned body's `updateLineage`; an
> `update` emits one base `update` per touched side (FK-parent before FK-child),
> and a `delete` emits one base `delete` on the FK-many (child) side. Both identify
> rows by a **subquery over the join body** — `<owning>.<pk> in (select <alias>.<pk>
> from <join> where <predicate>)` — which reconstructs the row-identifying predicate
> even when the owning side's PK is hidden by the projection. The base statement is
> lowered back to AST so the ordinary base-table builders (and all their constraint
> / conflict / FK machinery) are reused verbatim. The `quereus.update.*` tag
> override surface (`target` / `exclude` / `delete_via` / `policy`) is **shipped**
> (Phase 3.4 — see § Tags). Multi-source **`insert`** is **shipped** (Phase 2b —
> the shared-surrogate envelope, below). **Still rejected:** composite-PK or
> `> 2`-table joins, self-joins, cross-source `set` values, and `select *` join
> bodies.

The lineage of an inner-join output column traces unambiguously to one of the two child relations (EC propagation makes column membership precise even for equi-join columns).

**Updates** route per-column to the side that owns each column. A `set` clause assigning columns from both sides produces two child operations executed atomically. The row-identifying predicate for each child is the projection of the join's row-identifying predicate onto that child's key columns.

**Inserts** require values for both sides' `not null`-without-default columns and must satisfy the join predicate. The two child inserts execute FK-parent before FK-child where the dependency is provable; otherwise the order is unspecified. The join predicate, combined with the inserted values, supplies missing join-key columns on either side via EC.

> **Shipped (Phase 2b) — two-table inner join.** A multi-source insert decomposes
> through `building/view-mutation-builder.ts` (`buildMultiSourceInsert`, off
> `planner/mutation/multi-source.ts` `analyzeMultiSourceInsert`). Each supplied view
> column routes to its owning side by `updateLineage`; the shared join key (read
> from the single `a.col = b.col` ON predicate) is **directly supplied** when a view
> column maps to it, otherwise **minted** at the envelope (§ Mutation Context). A
> `not null` base column with neither a supplied value nor a declared default raises
> `no-default`; a computed target column raises `no-inverse`. The shared key must
> be exposed by **at most one** view column — a body projecting both sides of the
> equi-join key is over-specified for an insert (it could not honor divergent
> supplied values) and raises `unsupported-join`. **Still rejected:**
> outer-join / optional-member inserts (the worked example's `left join` shape — the
> insert path requires an INNER join in v1), composite-PK or `> 2`-table joins,
> self-joins, a non-integer surrogate that is not directly supplied, a
> `declared-default`-expression generator, `default_for` on a multi-source insert,
> and `select *` join bodies.

**Deletes** are inherently ambiguous — removing the joined row requires deleting from at least one side. The resolution (tags compose *after* the predicate dispatch — they only restrict the candidate sides, never broaden them):

- `quereus.update.target` / `exclude` (CSV of base-table names) first narrow the candidate sides.
- An explicit `quereus.update.delete_via` then picks a side: `'parent'` selects the FK-parent (requires a declared foreign key), `'left_delete'` the left join source. (`'right_insert'` is an `except`-branch value with no join meaning.)
- Absent an explicit side tag: if `target`/`exclude` already left exactly one side, that side; else if a declared foreign key proves the FK-many (child) side, that side (the common FK-style default — deletes the child, leaving the parent in place; the inverse is `with tags ("quereus.update.delete_via" = 'parent')`); else the delete is **ambiguous**.

> **Shipped behavior vs. intent.** An *ambiguous* delete (two candidate sides, no
> foreign key, no resolving tag) is **rejected** with a structured diagnostic
> directing the user to a `delete_via` / `target` override. Under
> `quereus.update.policy = 'strict'` the engine rejects *any* unresolved
> multi-side delete — it will not even fall back to the FK-many heuristic. The
> default `lenient` policy keeps the FK-many fallback. The doc's maximal lenient
> reading — *delete from every side* ("make this row not exist") — is **deferred**:
> a join's two base deletes each address rows via a subquery over the join, and
> the view-mutation substrate runs base ops sequentially against live state, so
> the second delete would re-evaluate the join after the first already removed its
> matching rows. A correct multi-side fan-out needs snapshot-consistent base-op
> execution (or eager key materialization), tracked separately.

### Outer Joins

Outer joins introduce **null-extended** lineage on the non-preserved side(s). For left, right, and full outer joins, every output column from a non-preserved side is annotated with the join predicate as a *guard*: the column is real iff the guard holds.

**Updates on the preserved side** propagate unchanged.

**Updates on a non-preserved-side column** split into two cases:

- *Row is non-null-extended in the matched view row* (guard holds): the propagation is a normal update on the non-preserved base, with row-identifying predicate built from the projected portion of the joined row's identifying predicate.
- *Row is null-extended* (guard fails — the non-preserved side had no matching row): the update is rewritten as an **insert** on the non-preserved side. Values for the join-predicate columns come from the preserved side via EC; values for non-`set` columns come from defaults or `default_for` tags; values for `set` columns come from the user's assignment. If the resulting insert lacks a `not null`-without-default value, the entire propagation fails with a diagnostic.

**Inserts** through an outer-joined view follow the join's structural intent. An insert with values for both sides produces inserts on both sides under the join predicate. An insert with values only for the preserved side produces a single preserved-side insert (the resulting row is null-extended through the view). An insert with values only for the non-preserved side requires the join predicate to be satisfiable against an existing preserved row; otherwise it is rejected.

**Deletes** route to the preserved side by default — this is the only way for the joined row to disappear from the view; deleting from the non-preserved side merely null-extends it, leaving the row visible. Tags override.

`full outer join` is handled as a generalization: every side is both preserved and non-preserved depending on the matched/unmatched status of each row.

### Union All

The user's example illustrates the propagation:

```sql
create view v as
  (select x, isDog from y where isDog) union all
  (select x, isDog from y where not isDog);
```

- `update v set name = 'Rex' where isDog` narrows to the first branch.
- `update v set isDog = true where ...` is consistent with the first branch and inconsistent with the second; routes to the first only.
- `update v set name = 'X' where ...` is consistent with both branches (the assignment does not touch a branch-discriminating column); routes to both. Both target the same base table; both row-identifying predicates resolve to the same `y.pk`, producing one base update per row.
- `insert into v (x, isDog) values (1, true)` is provably inconsistent with the second branch; routes to the first.
- `insert into v (x) values (1)` lacks an `isDog` value. The first branch's predicate `isDog` supplies `isDog = true` via EC; the second's `not isDog` supplies `isDog = false`. Two distinct rows are inserted. The predicate-honest reading: the user said "make this row exist in v"; both branches contribute a row that does.

When same-table fan-out produces multiple operations against the same row, they are merged into a single base operation if their effects are identical, and reported as a conflict otherwise under the prevailing `or` resolution.

### Union (distinct)

Identical to `union all` for propagation. Duplicate elimination is a read-side concern; mutations operate on the underlying multiset.

### Intersect

A view row exists iff present in every branch. By predicate honesty:

- **Inserts** fan out to every branch (otherwise the row does not appear in the view).
- **Updates** fan out to every branch (the row exists on each side and must be kept aligned).
- **Deletes** fan out to every branch by default — the predicate-honest reading of "this fact is no longer true" is "remove from every relation that asserts it". The `delete_via` tag narrows.

### Except

A view row exists iff present in the left and absent from the right.

- **Inserts** insert into the left; if the row is also present in the right (provable via the existence predicate against right's relation), delete from the right.
- **Updates** propagate to the left only.
- **Deletes** delete from the left by default. The tag `"quereus.update.delete_via" = 'right_insert'` switches to inserting into the right, achieving the same view-level effect through the opposite base-level change.

### Distinct

Lineage passthrough. Mutations apply to all base rows that collapse to the affected view row (consistent with predicate-honest fan-out).

### Sort, Limit, Offset

Pure passthrough. `order by` and `limit` do not affect propagation unless the mutation itself carries `order by` / `limit`, in which case they participate in row-identifying-predicate construction.

### Common Table Expressions and Subqueries in `from`

CTE references are inlined; propagation runs on the unfolded plan. Non-recursive CTEs are therefore transparently mutable. Recursive CTEs are read-only and rejected with a `recursive-cte` diagnostic.

A subquery in `from` is structurally identical to an inlined CTE; the propagation pass treats them as the same. `update (select ... from t join s on ...) as v set v.col = ...` works without special-casing.

### Window Functions

The window function's output column is `computed` (read-only). Other columns from the windowed input remain updateable per the normal rules.

### Aggregation

Aggregation is read-only at the column level. Grouping columns are passthrough-updateable in principle (uniquely determined per group), but the surrounding aggregate functions defeat row-level identifying predicates: a single view row corresponds to many base rows, and the engine cannot decompose `set group_col = ...` into per-base operations without an explicit row binding from the user.

Aggregates remain a delta surface via the incremental-maintenance machinery (see [Incremental Maintenance](incremental-maintenance.md)). View-level update propagation through aggregations is reserved for the future extension that consumes that framework.

## Scalar Invertibility

Scalar functions and operators expose an **invertibility profile** in their schema registration. The lineage walker consults the profile when threading a transformation through a column reference.

```typescript
type InvertibilityProfile =
  | { kind: 'passthrough'; arg: number }
  | { kind: 'inverse'; fn: ScalarFn; domain?: PredicateExpr }
  | { kind: 'opaque' };
```

- **`passthrough`** — the named argument is returned with a non-data-altering transformation. The lineage threads the argument's lineage as if the call were not there. Example: `collate(x, 'NOCASE')` is `{ kind: 'passthrough', arg: 0 }`.
- **`inverse`** — the function has a deterministic inverse, optionally restricted to a domain predicate. When inverting an assignment, the engine substitutes the inverse and conjoins `domain` into the row-identifying predicate. Example: integer addition by a constant — `x + k` has inverse `y => y - k` with unrestricted domain over integers.
- **`opaque`** — no inverse known; columns whose lineage passes through this function become `computed` (read-only).

Built-in functions ship with profiles. `cast`-style conversions advertise `inverse` when lossless and `opaque` when lossy. `coalesce(x, default)` is `passthrough` on `arg = 0` when the default branch is provably unreachable on the update path (via FD-driven `not null` proof). String functions are `opaque` by default; the few invertible cases are declared explicitly.

User-defined functions declare their profile at registration. A predicate-typed UDF additionally declares which arguments it sees through (passing lineage through, leaving the row's update site untouched) versus which arguments it consumes opaquely. The same surface is reused by the [assertion-derived-premises](optimizer.md#assertion-derived-premises) pipeline.

## Tags: The Override Surface

Default propagation is deterministic and predicate-honest. When a user wants different behavior, they attach tags via the existing `with tags (...)` syntax (see [SQL Reference §Tags](sql.md#tags)).

The reserved `quereus.update.*` namespace controls propagation. Shape and site
validation for the whole `quereus.*` namespace is centralized in the typed
registry `packages/quereus/src/schema/reserved-tags.ts`
(`validateReservedTags(tags, site)`): each reserved key is matched to a frozen
spec, its position checked against the key's legal `TagSite` set (`view-ddl`,
`union-branch`, `join`, `dml-stmt`, `projection`, `logical-table`,
`logical-constraint`), and its value checked against a `TagValueSchema`
(`csv-of-identifiers`, an enum, an `expression`, …). An unknown or mis-sited key
is a hard **error**; a malformed value is an error too, except an empty
`quereus.lens.ack` rationale, which is only a **warning**. The rows below are the
`quereus.update.*` seeds — the registry validates their shape/site; their **Effect
(semantics) is realized by the view-mutation override surface** (Phase 3.4 —
collection + merge in `planner/mutation/mutation-tags.ts`, consumption in
`planner/mutation/{single-source,multi-source}.ts`), not the registry. Tags are
collected at two sites: the view DDL (`ViewSchema.tags`, validated `view-ddl`) and
the DML statement (`WITH TAGS (...)` → `stmt.tags`, validated `dml-stmt`); a sited
diagnostic is raised before any base op is built:

| Tag | Where | Effect |
|---|---|---|
| `"quereus.update.target"` | view DDL, branch of `union`/`intersect`/`except`, join side, dml statement | Restrict propagation to the listed relation(s). Value is a comma-separated list of base table names or branch identifiers. |
| `"quereus.update.exclude"` | same | Exclude the listed branches; the inverse of `target`. |
| `"quereus.update.default_for.<column>"` | view DDL, projection, dml statement | Default expression for `insert` through the view when the column is omitted. The expression may reference any surviving column. A statement-level binding overrides the view-level default for that statement's duration. |
| `"quereus.update.delete_via"` | `except`, join, dml statement | For `except`: `'left_delete'` (default) or `'right_insert'`. For joins: pick the side whose deletion realizes the view-level delete. A statement-level binding overrides the branch/join default for that statement's duration. |
| `"quereus.update.policy"` | view DDL | `strict` (reject any ambiguity) or `lenient` (default; predicate-honest fan-out). |

Tags compose with the predicate-driven dispatch: predicates always run first, narrowing the candidate set; tags then further restrict, or — for `default_for` — supply missing values. Tags can never broaden the candidate set beyond what predicates allow.

Statement-level tags appear in a `with tags (...)` clause on the statement (the same `with tags` surface as DDL — see [SQL Reference §Tags](sql.md#tags)). It sits where a `with context (...)` clause would (before `set` / the `values` source / `where`, or trailing):

```sql
update v with tags ("quereus.update.target" = 'base_a') set col = 1 where ...;
insert into v with tags ("quereus.update.default_for.created" = 'epoch_ms(''now'')') values (...);
delete from v with tags ("quereus.update.delete_via" = 'left_delete') where ...;
```

A `default_for` value is a TEXT **expression** (parsed as SQL), so a non-literal must be SQL-quoted as shown. Statement-level tags override view-level tags for the duration of the statement.

## Multi-Base-Table Mutations

A view that touches `n` base tables can emit operations against any subset in a single statement. The propagation pass aggregates the per-table operations and the statement-level executor issues them within the statement's transaction.

Order of execution within the statement:

1. FK-parent operations precede FK-child operations where the dependency is provable from declared foreign keys.
2. Within an FK-equivalence class, order is unspecified.
3. All operations see a consistent pre-statement snapshot of the database; intermediate effects are visible only via the trailing constraint pass at end-of-statement.

Constraint enforcement runs at end-of-statement under the prevailing conflict-resolution mode (see [Conflict Resolution](sql.md#conflict-resolution-or-clause)). Deferred CHECKs run at commit per the assertion framework.

`Statement.getChangeScope()` (see [Change-scope Documentation](change-scope.md)) reports the union of all base-table operations a prepared statement may emit, providing accurate dependency information for reactive consumers even when the statement targets a complex view.

## Cycles, Self-Joins, Recursive Composition

**Self-joins.** A view that joins `t` to itself produces lineage referencing `t` under two distinct alias-bound update sites. Updates and deletes route per-alias; the engine executes the per-alias operations sequentially, each operation observing the previous one's effects. Cycles in update propagation (a → b → a via a self-join with mutual references) are detected at plan time and resolved by serializing in alias-declaration order.

**Recursive composition.** Views composed of views are flattened at planning time; propagation operates on the fully-inlined plan. A view whose body references itself (recursive CTE) is read-only.

**View update of a view's base table while the view is open.** Quereus's async iteration model captures a consistent snapshot per cursor (see [Memory Vtab Documentation](memory-table.md)); mutations through a view do not perturb concurrent reads of that view.

## Interaction with Constraints

- **`check` constraints** on base tables apply unchanged to base operations emitted by view mutations. A view selection predicate `σ_p` does *not* become a CHECK constraint — predicates are read-time filters, not write-time invariants. Users who want the converse (reject writes that would carry a row outside the view) attach the predicate as a base-table CHECK or a global `create assertion`.
- **`create assertion`** invariants enforce at commit time across the entire database, including any state produced by view-mediated mutations. This is the supported replacement for `with check option`: it composes across views, contributes premises through the [assertion-derived-premises](optimizer.md#assertion-derived-premises) pipeline, and runs incrementally via `DeltaExecutor`.
- **Foreign keys** with `on delete` / `on update` cascades fire on the base operations emitted by propagation, not on the view-level mutation. A view-mediated delete that emits two base deletes triggers each base's cascade independently.
- **Generated columns** are `computed` lineage; they are read-only at every level. Writes to generated columns through any view are rejected.
- **Conflict resolution (`or` clauses)** applies per base operation. A view mutation with `or ignore` ignores constraint violations on each emitted base operation independently. `or rollback` aborts the enclosing transaction at the first violation, regardless of which base operation triggered it.

## `returning` Clauses

`insert`, `update`, and `delete` through a view support `returning`. The returned rows are projected through the **view's** column list, not the base tables'. The engine evaluates the view body against the post-mutation state to produce returning rows — equivalently, against the captured per-operation results, since the view's lineage maps base rows back to view rows. `returning` columns of `computed` lineage (a view-level computed expression) are evaluated against the post-mutation base values. `returning *` expands to the view's column list.

> **Shipped (single-source all ops; multi-source inner-join `update` / `delete`).**
> When a view mutation carries a `returning` clause, `ViewMutationNode` is
> **relational** — its row type / attributes are the view's projected columns — and
> the `block.ts` result-shadowing exclusion (which drops void view mutations from a
> block's result, alongside `Sink`) admits it. There are two mechanisms:
>
> - **Single-source** (`planner/mutation/single-source.ts`, `rewriteViewReturning`):
>   the clause is rewritten into base terms — each view-column reference substituted
>   to its base-term lineage, the user's view-spelling preserved as the result-column
>   name — and attached to the rewritten base statement, so the base op's own
>   RETURNING machinery yields the rows. Unqualified columns bind to NEW for
>   insert/update and OLD for delete, so the result is the post-mutation (or, for
>   delete, the deleted) view image; computed view columns re-evaluate against those
>   base values. The (sole) base op is now a relational `ReturningNode` and the
>   substrate surfaces it. This is robust against an update that changes a predicate
>   column (it reads NEW/OLD, not a re-query). MV write-through inherits it verbatim.
>
> - **Multi-source** inner-join `update` / `delete` (`building/view-mutation-builder.ts`,
>   `buildMultiSourceReturning`): the view row spans both base tables, so it is not
>   recoverable from the per-side base ops. The rows come from a **re-query of the
>   view** restricted to the mutation's predicate — `select <returning> from <view>
>   [where <user where>]` — captured **before** the base ops fire for a delete (the
>   rows are about to disappear) or **after** for an update (the post-mutation
>   image), threaded as `ViewMutationNode.returning` with a `returningTiming` of
>   `pre`/`post`. *Limitation:* the post-mutation update re-query matches by the user
>   predicate, so an update that **changes a column its own WHERE filters on** could
>   not be recaptured (the changed row no longer matches the predicate). Rather than
>   silently return the wrong/empty set, that exact shape is **rejected** with the
>   `returning-through-view` diagnostic; correct per-row capture is a follow-up. A
>   multi-source `delete` (captured `pre`) and an update predicated on a column it does
>   not assign have no such hazard. The single-source path has no such limitation at
>   all (it reads NEW/OLD).
>
> **Not yet shipped:** multi-source (join) **insert** RETURNING — the minted shared
> surrogate is not yet threaded into a RETURNING projection — is rejected with the
> `returning-through-view` diagnostic. RETURNING through a decomposition-backed
> logical table is likewise still rejected.

## Mutation Context

The `with context` envelope (see [Sequential ID Generation](architecture.md#sequential-id-generation)) wraps the entire view-mediated mutation. It is also the mechanism by which **generated values enter at the propagation boundary while DML stays deterministic**.

Determinism in Quereus means a statement's effect is a pure function of database state and *captured context* — non-deterministic inputs are not forbidden, they are captured once at the envelope, recorded, and replayed identically. A view-mediated mutation frequently needs a value present at neither the user-visible relation nor the inserted row: a surrogate key that several base tables share, a sequence value, a creation timestamp. Such a value is supplied by a **generated default** on the base column (a sequence, a surrogate allocator, a clock read), evaluated through the context envelope and recorded with the statement. The propagation is therefore deterministic-given-context, and the generation is a context concern, identical to how sequential IDs and captured timestamps already work. No layer above introduces non-determinism — it consumes the escape valve the engine already provides.

Bindings have two cadences:

- **Per-statement** — a captured `now`, a bound parameter. Evaluated once; stable across every row and every base operation the statement emits (transaction-time semantics).
- **Per-row** — a sequence, a surrogate allocator. Evaluated once *per top-level row produced*, so a multi-row insert mints a distinct value per row. The captured context records the per-row values, preserving replay.

> **Shipped (Phase 2b — the shared-surrogate worked example below).** A
> multi-source `insert` resolves the shared key once per produced logical row **at
> the envelope, before propagation fans out**, and threads the single captured value
> into both base inserts. The envelope is realized as a **materialized augmented
> source**: `ViewMutationNode.envelope` holds the per-row source (the supplied view
> columns); the `ViewMutation` emitter drains it once into an array, appends the
> minted key per row, and stashes the rows in `rctx.tableContexts`; each base op
> reads them back through an `EnvelopeScanNode` (the recursive-CTE working-table
> pattern), so every branch observes the identical row — there is no
> "which branch generates first" question. The generator is `integer-auto` /
> `per-row` (`SharedKeyGenerator` in `vtab/mapping-advertisement.ts`): `seed +
> ordinal`, where `seed = max(anchor.key)` is evaluated **once** before fan-out (so
> it observes the pre-mutation state) and the 1-based ordinal makes each row's key
> distinct. The anchor is the FK-parent (else the left source). The same envelope is
> the surface the **decomposition put insert fan-out** (`lens-multi-source-put-insert-fanout`,
> `decomposition.ts` + `buildDecompositionInsert`) rides: a `surrogate` shared key
> mints `integer-auto` here (`per-row` ⇒ `seed + ordinal`; `per-statement` ⇒
> `seed + 1` bound once for the statement — `MutationEnvelope.mint.cadence`),
> threaded into every member; a `logical-tuple` key threads the supplied logical PK
> with no generation; optional / EAV members read the same envelope behind a per-row
> presence `FilterNode`. Multi-source `update` / `delete` do not need this: they
> address existing rows by a subquery over the join, not by minting a shared key.
>
> A genuinely non-deterministic per-row generator (a `declared-default` expression
> like `next_rid()`, a real allocator) would ride the same envelope unchanged — its
> per-row value captured once into the materialized rows and recorded for replay —
> but v1 ships only the `integer-auto` strategy; `declared-default`-expression and
> non-integer surrogates are deferred (the key must then be directly supplied).

When a per-row generated value also serves as a **join key shared across base tables** — the surrogate that an n-way decomposition joins on — the single captured per-row value threads through every branch of the fan-out. Because it is resolved at the envelope *before* propagation reaches the branches, every branch references one already-captured binding: there is no "which branch generates first" ordering question, and the branches cannot diverge. This is what makes an insert into a relation backed by a shared-surrogate decomposition well-defined — one generation, captured, shared across the fan-out.

**Worked example.** A logical `User(name, email)` is decomposed over two base relations that share a surrogate `rid`. The surrogate has nowhere to come from in the logical row, so it is a **generated default** on the anchor; the second relation inherits it through the join-key equivalence class:

```sql
-- basis: two relations sharing a surrogate `rid`; the anchor generates it per row
create table u_core    (rid int primary key default next_rid(), name text) using mem();
create table u_contact (rid int primary key, email text) using mem();

-- the lens get
create view User as
  select c.name, k.email
  from u_core c
  left join u_contact k on k.rid = c.rid;
```

Now a two-row insert through the lens:

```sql
insert into User (name, email)
  values ('Ada', 'ada@x.io'), ('Lin', 'lin@x.io');
```

Propagation, per top-level row:

1. `next_rid()` is a **per-row** generator, so the envelope resolves it once for each produced row — say `rid = 1001` for Ada, `rid = 1002` for Lin — and records both in the captured context.
2. The join predicate `k.rid = c.rid` puts `u_core.rid` and `u_contact.rid` in one equivalence class, so the captured `rid` is the value used for *both* base inserts of that row. No second `next_rid()` call fires; the branch does not re-generate.
3. The emitted base operations are therefore `u_core(rid=1001, name='Ada')` + `u_contact(rid=1001, email='ada@x.io')`, then the `1002` pair for Lin.

Contrast the cadences: had the example also carried `created int default now_ms()`, that **per-statement** binding would resolve *once* and stamp the same value onto both rows, whereas `rid` differs per row. And because `(1001, 1002)` live in the recorded context, replaying the statement re-emits byte-identical base rows — the insert is deterministic-given-context even though `next_rid()` is not deterministic in isolation.

Per-column `default_for` tags may reference context bindings; bindings evaluate per their cadence and are reused across every per-base operation that consumes them.

## Diagnostics

When propagation cannot proceed, the engine raises a `QuereusError` whose `details.mutationDiagnostic` is a structured record:

```typescript
interface MutationDiagnostic {
  reason:
    | 'no-inverse'                      // scalar function with kind: 'opaque' on update path
    | 'no-default'                      // not-null column with no recoverable value on insert
    | 'recursive-cte'                   // recursive CTE in mutation target
    | 'aggregate-target'                // aggregate-shaped column written
    | 'null-extended-create-conflict'   // outer-join materialization blocked
    | 'tag-target-not-found'            // target/exclude/default_for/delete_via names an unknown branch/table/column
    | 'tag-conflict'                    // target/exclude excludes a side the statement must write
    | 'policy-strict-ambiguity'         // policy=strict rejects an unresolved multi-side delete
    | 'predicate-contradiction';        // statement's predicate is unsatisfiable
  planNodeId: number;
  column?: string;
  table?: string;
  suggestion?: string;
}
```

Diagnostics include a suggestion when one applies — for instance, `no-default` includes the `with tags ("quereus.update.default_for.col" = ...)` fragment ready to copy.

`query_plan().properties` includes the per-column `updateLineage` summary so the user can inspect propagation behavior without issuing a mutation.

## Information Schema Surface

The SQL-standard intent is `information_schema.views`. Quereus has no
`information_schema` namespace and no registered `sqlite_schema` — every
introspection surface is a **table-valued function** (`schema()`,
`table_info(name)`, `foreign_key_info(name)`, …; see
`func/builtins/schema.ts`). The engine-idiomatic realization of
`information_schema.views` is therefore a TVF in that same family:

```sql
view_info()          -- one row per plain (non-materialized) view, all schemas
view_info('my_view') -- the single matching view (optional name filter)
```

Each row exposes the per-view propagation summary (`'YES'` / `'NO'` text to
match the SQL-standard convention):

| Column | Meaning |
|---|---|
| `schema` | schema name (`main`, `temp`, …). |
| `name` | view name. |
| `is_insertable_into` | `'YES'` if every `not null`-without-declared-default, non-generated base column of every reachable base has a recoverable value — projected, or a recoverable default (constant-FD selection pin / declared base default / `default_for`). |
| `is_updatable` | `'YES'` if at least one output column has `base` lineage. Per-column updateability — which *specific* columns are writable — is exposed by the companion `column_info(name)` TVF (below). |
| `is_deletable` | `'YES'` if the row-identifying predicate is constructible at every base reachable from the view — operationally, every reachable base's PK columns are exposed through `base` lineage. |
| `effective_targets` | JSON array of base-table names that mutations through the view may touch by default (`'[]'` when none). |

**Static derivation, not a dry run.** Every column is derived statically from
the planned view body's backward `updateLineage` / `attributeDefaults` (§ The
Update Site Model, § Implementation Surface) plus the base-table
not-null/default/generated flags — `view_info()` never executes a probe
mutation. The body is planned *logically* (it preserves the
Project/Filter/Join/TableReference operator tree that threads `updateLineage`;
the optimizer degrades a join's top-node lineage to `computed`), the same way
the view-mutation substrate plans it — so `effective_targets` agrees with the
base set `propagate()` reaches. The substrate's `propagate()` insert / delete
paths remain the authoritative *dynamic* check; the static surface is the
conservative reading (a body whose lineage is not yet threaded — VALUES /
aggregate / set-op / recursive-CTE / wholly-computed — yields the conservative
all-`NO` / `'[]'` row, never an error). The surface gains accuracy as later
phases thread more lineage, with no rework here.

**Outer-join contract.** A body carrying any `null-extended` lineage site —
i.e. a `LEFT` / `RIGHT` / `FULL` outer join (`deriveJoinUpdateLineage` wraps the
non-preserved side `null-extended`) — yields the conservative all-`NO` / `'[]'`
row, *regardless of which columns the projection keeps*. This is a deliberate
today-truth gate, not a thread-more-lineage gap: `propagate()` rejects an
outer-join body **wholesale** today — `multi-source.ts`'s
`collectInnerJoinSources` accepts only two-table inner equi-joins, so neither
the preserved nor the non-preserved side is writable — and the static surface
must agree with that dynamic truth (reporting `'YES'` here would be a
dangerous YES-when-NO over-report). The gate is body-level (any `null-extended`
site anywhere in the planned spine) rather than per-column precisely because the
preserved side is also unwritable today. When outer-join write materialization
lands, relax this to per-side writability — the preserved side becomes writable
and only the not-yet-materialized null-extended side stays gated. (`default_for`
recovery, listed under `is_insertable_into` above, is honored from a view's own
`with tags (…)` DDL: the `tag-default` provenance is not threaded onto the
physical surface, so `deriveViewInfo` folds the view-level tags into its
defaultable set directly.)

Materialized views are **not** enumerated: they are read-only at the user-write
boundary, so `view_info()` walks `getAllViews()` only.

### Per-column updateability — `column_info(name)`

`information_schema.columns.is_updatable` — per-column updateability for every
view *and* base table — is the engine-idiomatic companion to `view_info()`:
`view_info : schema()` :: `column_info : table_info`. It takes a **required**
target (a base-table or view name; unlike `view_info`'s optional filter) and
emits one row per output column:

```sql
column_info('my_table')  -- one row per base-table column
column_info('my_view')   -- one row per view output column
```

| Column | Meaning |
|---|---|
| `schema` | schema name (`main`, `temp`, …) the object resolved in. |
| `name` | the table / view name. |
| `cid` | column ordinal (0-based). Base table: column index. View: output-attribute index. Matches `table_info.cid` for a base table. |
| `column_name` | the column's output name (the view's alias spelling for a renamed column). |
| `is_updatable` | `'YES'` if a write to this column propagates to a base column (a `base` `UpdateSite`); `'NO'` if read-only (computed / generated / un-threaded lineage). |
| `base_table` | owning base-table name for an updatable column; `null` for a read-only column. The per-column trace companion to `view_info.effective_targets`. |
| `base_column` | owning base-column name for an updatable column; `null` for a read-only column. |

**Static derivation.** For a **base table**, a column is updatable iff it is not
`generated` (generated columns are computed/read-only — § Interaction with
Constraints) — `base_table`/`base_column` are the column itself. For a **view**,
the body is planned *logically* (the same `_buildPlan` path as `view_info()`, to
preserve the operator tree that threads `updateLineage`) and each output
attribute's backward `updateLineage` site is read: a plain `base` site resolving
to its producing `TableReferenceNode` is `'YES'` with its base trace; everything
else (`computed`, un-threaded, or a site that fails to resolve) is `'NO'` with
`null` trace. No dry-run mutation, no new planner pass — the surface gains
accuracy automatically as later phases thread more lineage (a view column fed by
an un-threaded operator reads `'NO'`, the conservative, honest reading). Every
`is_updatable='NO'` row carries `null` `base_table`/`base_column`.

**Outer-join gate (shared with `view_info`'s Divergence 2).** A body carrying any
`null-extended` site is a LEFT/RIGHT/FULL outer join, which `propagate()` rejects
wholesale today (both sides — `collectInnerJoinSources` accepts only inner
equi-joins). `column_info` short-circuits such a body to all-`NO`/`null` exactly
as `view_info` short-circuits it to all-`NO`/`[]`, rather than unwrapping
`null-extended` to the inner base and over-reporting a preserved-side column as
`'YES'`. The two surfaces agree with each other and with the dynamic truth; when
per-side write materialization lands and the gate softens, both relax together.

The `'YES'`/`'NO'` text encoding matches `information_schema.columns.is_updatable`
and the `view_info` flags — deliberately **not** `table_info`'s integer `0`/`1`.

**Materialized views** resolve to neither path — their user-facing name is not a
`getView` hit (MVs live in a separate catalog) nor, by that name, a `_findTable`
hit (the backing table is the reserved `_mv_<name>`) — so `column_info('an_mv')`
throws not-found, consistent with `view_info` excluding MVs (read-only at the
write boundary).

**Why a dedicated TVF, not a `table_info` extension.** `table_info(name)`
resolves base tables only (it reads `_findTable`); views live in a separate
catalog map and carry none of the per-column metadata (`notnull` / `pk` /
`dflt_value` / `collation` / `generated`) `table_info` emits. Extending
`table_info` to views would force a whole second path that plans a view body and
synthesizes every such field — over-coupling base-table introspection to body
planning. A dedicated `column_info(name)` resolves *either* kind uniformly,
emits only the column-granular updateability facts, and churns zero `table_info`
goldens.

## Implementation Surface

- `src/planner/nodes/plan-node.ts` — `updateLineage?: ReadonlyMap<AttributeId, UpdateSite>` and
  `attributeDefaults?: ReadonlyMap<AttributeId, AttributeDefault>` on `PhysicalProperties` (**landed**).
  Threaded as `computePhysical` overrides on TableReference / Project / Filter / Join, and passed
  through the access / Retrieve / Alias boundary nodes.
- `src/planner/analysis/update-lineage.ts` — the backward-walk helpers
  (`deriveProjectUpdateLineage` / `deriveFilterAttributeDefaults` / `deriveJoinUpdateLineage`), each
  *reading* the node's already-emitted forward `fds` / `constantBindings`; plus the AST-level Phase-1
  `deriveViewColumns` and its plan-node reader `viewColumnsFromUpdateLineage`. Runs in the
  physical-property phase alongside FD propagation.
- `src/planner/analysis/scalar-invertibility.ts` — the law-gated `InvertibilityProfile` registry
  (`classifyInvertibility`) and the recursive `traceInvertibleColumn` that composes the inverse chain.
- `src/planner/analysis/view-complement.ts` — `viewComplement(node)` / `complementOf`, the
  predicate-honest complement derived off the backward walk (for the lens prover).
- `src/planner/mutation/propagate.ts` — `propagate(ctx, view, req: MutationRequest): BaseOp[]`, the single propagation entry. **Landed.** A decomposition-backed logical table (a `primary-storage` advertisement, no override) routes to the advertisement-driven fan-out (`decomposition.ts`); a single-table body routes to the single-source spine (`single-source.ts`); a join body routes to the multi-source walk (`multi-source.ts`). Also hosts `classifyViewBody`.
- `src/planner/mutation/single-source.ts` — the relocated single-source projection-and-filter rewrite (`rewriteViewInsert/Update/Delete` + `analyzeView`), the one-base-op producer `propagate` calls. **Landed.** Also hosts the shared expression machinery both spines use: `transformExpr` (now with a `descend` hook into `subquery` / `exists` / `in`-subquery operands), the deep `cloneExpr` / `cloneQueryExpr`, and the scope-aware `transformQueryExpr` / `makeViewColumnDescend` that rewrite view-column references nested inside a predicate / assigned-value subquery to their base-term lineage (§ Selection).
- `src/planner/mutation/multi-source.ts` — the two-table key-preserving inner-join decomposition. `propagateMultiSource` reads the planned body's `updateLineage` to emit an ordered multi-element `BaseOp[]` for `update` / `delete`, lowered to AST. `analyzeMultiSourceInsert` (Phase 2b) decomposes an `insert`: it routes each supplied view column to its owning side, reads the shared key off the single-equi-join ON predicate, decides directly-supplied-vs-mint, FK-orders the sides, and raises `no-default` / `no-inverse` for an uncoverable side. **Landed.**
- `src/planner/nodes/envelope-scan-node.ts` / `src/runtime/emit/envelope-scan.ts` — the leaf that scans the shared-surrogate envelope rows from `rctx.tableContexts` (set by the `ViewMutation` emitter before fan-out). **Landed.**
- `src/planner/building/view-mutation-builder.ts` — `buildViewMutation` routes a multi-source inner-join `insert` to `buildMultiSourceInsert`, which builds the envelope source (the user VALUES/SELECT), one base insert per side (each sourcing a projection over an `EnvelopeScanNode`, re-planned through `buildInsertStmt`'s new `preBuiltSource` seam), and the `max(anchor.key)` seed. **Landed.**
- `src/planner/mutation/decomposition.ts` — the **advertisement-driven** put fan-out for an n-way decomposition lens (`propagateDecomposition` for DELETE/UPDATE; `analyzeDecompositionInsert` for INSERT; `lens-multi-source-put-fanout` + `lens-multi-source-put-insert-fanout`). **Landed:** DELETE across every member (anchor-last, anchor-only predicate); UPDATE routed to the mandatory non-EAV member backing each column; **INSERT** anchor-first one-per-member off the shared-surrogate envelope (`integer-auto` surrogate minted once per row, per-row/per-statement, or a logical-tuple PK threaded straight through; optional members gated per-row; EAV triples per supplied attribute; singleton over the empty key) — built by `buildDecompositionInsert` in `view-mutation-builder.ts` (the AST `BaseOp[]` model cannot carry the envelope). Still deferred onto absent substrate: a non-anchor-member predicate (`unsupported-decomposition-predicate`, snapshot-consistent multi-member execution), an optional/EAV/key UPDATE transition (`unsupported-decomposition-update`, per-row insert-or-delete branching), non-integer surrogate generators (`no-default`), and composite shared keys (`unsupported-decomposition-key`).
- `src/planner/nodes/view-mutation-node.ts` / `src/planner/building/view-mutation-builder.ts` — the `ViewMutationNode` wrapper and the builder that re-plans each `BaseOp.statement` through the base-table builder. **Landed.** The node is **relational** when a `returning` clause is present (`resultRelation()` is the separate multi-source re-query `returning` child, else a relational base op); the builder's `buildMultiSourceReturning` builds the multi-source re-query (with `returningTiming` `pre`/`post`).
- `src/func/invertibility.ts` — `InvertibilityProfile` type, built-in profile registry, UDF registration hook.
- `src/runtime/emit/view-mutation.ts` — instruction emitter that issues the emitted base operations in order. For a multi-source insert it first materializes `plan.envelope` once (the shared-surrogate envelope), evaluating the seed and minting `seed + ordinal` per row, then stashes the rows in `rctx.tableContexts` for the base ops' `EnvelopeScanNode`s. **Landed.** For a `returning` mutation it materializes and yields the view-projected rows: a relational base op (single-source) is drained and surfaced, or the separate `returning` re-query is captured before (delete) / after (update) the base ops.
- `src/schema/view.ts` — `ViewSchema.effectiveTargets`, `ViewSchema.defaultsForColumn`, populated at view-creation time.
- `src/func/builtins/schema.ts` — the `view_info()` and `column_info(name)` TVFs (§ Information Schema Surface): read-only static projections over the planned body's `updateLineage` / `attributeDefaults` + base-column flags. `view_info()` is the view-level summary; `column_info(name)` is its column-granular companion, resolving either a base table (`!generated` per column) or a view (per-attribute `updateLineage`). Both read the backward surface; neither threads new state.

Each surface mirrors a one-to-one correspondence with an existing engine surface: lineage parallels FDs, propagation parallels emission, and view metadata parallels table metadata. No new subsystem is introduced — view updateability is the existing FD / EC / predicate-normalization infrastructure consulted in the mutation direction.

> **Forward note — how the backward surface lands.** Phase 1 ships these as the
> hand-maintained single-source AST walk (`update-lineage.ts`,
> `scalar-invertibility.ts`, `propagate.ts`). When the plan-node substrate threads
> `updateLineage` / `AttributeDefault` onto `PhysicalProperties`, it does so as the
> **derived dual of each operator's forward FD walk**, gated by the per-operator
> **round-trip law**. That discipline is decided — see § Round-Trip Laws and the
> Derived Backward Walk above. The law lands first and standalone as
> `bx-roundtrip-law-harness`; `view-mutation-plan-node-substrate` then threads each
> operator's backward method as the law-gated derived dual.

## Round-Trip Laws and the Derived Backward Walk

The forward relational direction is computed once, structurally: each operator's
`computePhysical` derives its output `PhysicalProperties.fds` (key / FD /
equivalence-class / domain) from its children, and the **Key Soundness** property
harness (`test/property.spec.ts` § Key Soundness, Tiers 1 + 2) materializes rows and
asserts the claimed `keysOf` / `isSet` never over-claim. That harness is the
structural net that keeps the forward walk honest.

The **backward** direction — given a mutation against a relation, which base
operations realize it — must be kept in lock-step with the forward direction, or an
operator could advertise a key forward while its `put` / lineage rule silently
disagrees about which base column that key threads to, with no test red. This
section fixes the discipline that prevents that divergence. It is the decided
output of the `bx-operator-model-and-roundtrip-laws` design-spike (Bohannon, Pierce
& Vaughan 2006, *Relational Lenses*; Voigtländer, *bidirectionalization for free*).

### The backward walk is a derived dual, not a parallel hand-walk

There is **one** FD/EC/domain annotation per node — the `PhysicalProperties.fds`
the forward `computePhysical` already produces. Each operator's backward method
**reads that annotation**; it does not re-derive or hand-duplicate its own:

- **Project** inverts exactly the scalar transforms `analysis/scalar-invertibility.ts`
  classifies (`passthrough` / `inverse` / `opaque`), and threads keys along exactly
  the FDs `computePhysical` emitted; a non-invertible output is marked `computed`.
- **Filter (σ)** routes constant-FD defaults from the same `∅ → c = v` guarded FDs
  the forward Filter produced.
- **Join** composes per-source lineage along the join FDs the forward pass computed.

This is the Bohannon–Pierce–Vaughan move adapted to Quereus's FD-annotated
operators: the operator's FD/predicate *type* determines **both** directions, so the
directions cannot silently disagree once the round-trip law (below) is green.

**North-star (committed, sequenced).** Auto-deriving `put` from `get`
(Voigtländer-style bidirectionalization) is the committed direction. v1 hand-writes
each backward method, but every one is **authored as a get→put derivation from the
shared forward annotation** — shaped so the eventual mechanical auto-deriver is a
refactor behind the same law, never an unwind of a parallel hand-walk. The
auto-deriver itself is deferred only until the operator set stabilizes
(general-bodies, lateral-TVF, multi-source decomposition are still in-flight). The
load-bearing invariant: **no operator may introduce a backward rule that
auto-derivation could not later reproduce.**

### The three round-trip laws

A per-operator round-trip property block in `test/property.spec.ts`, sibling to Key
Soundness (same positional-core + negative-self-test structure), forces the backward
walk to agree with the forward walk over the writable fragment. For a randomly-seeded
small base table and a spread of view bodies (single-source projection-and-filter
today; the planned multi-source tree once the substrate lands):

- **PutGet (write-then-read).** Apply a generated mutation through the view, read the
  view back, and assert the read reflects exactly the mutation's effect on the
  writable columns — no rows appear/disappear outside the view predicate, computed
  columns are untouched (a write to one is rejected with the `no-inverse` diagnostic,
  not silently dropped), and a key the forward walk claims on the view output is the
  same tuple the backward walk used to bind the base row. This is the law that turns
  the two hand-fixed Phase-1 review regressions — `LIMIT`/`OFFSET`/`DISTINCT`
  write-widening and the alias-qualifier leak — into *property* failures.
- **GetPut (read-then-write-back).** Read a row through the view, write the same
  values back via an update keyed on the view's identifying predicate, assert the base
  table diff is empty.
- **Forward/backward lineage agreement (the structural crux).** Plan the body; for
  each output column cross-check the backward lineage (`deriveViewColumns` →
  `ViewColumnLineage`) against the forward FD facts (`keysOf` / `fds` via the unified
  surface): every `base`-writable column has a forward FD path to that base column,
  and every key the forward walk advertises is reconstructible by the backward
  identifying predicate. A disagreement reds the test.

The law is the **acceptance gate** for the derived backward walk: a new operator's
backward method is not "done" until PutGet / GetPut / lineage-agreement are green over
a planned tree that surfaces it. It lands first and standalone as
`bx-roundtrip-law-harness` over the shipped single-source path (pure test code, no
engine surface), then `view-mutation-plan-node-substrate` extends the same block to
the planned multi-source tree as it threads each operator's backward method.

> **Landed (Tier A).** The single-source projection-and-filter Tier A of this block
> has shipped as `describe('View Round-Trip Laws')` in `test/property.spec.ts` — the
> backward-direction soundness net, the dual of the forward-direction **Key
> Soundness** block in the same file. It exercises the view-body zoo (bare `select *`,
> explicit / rename projection, computed column, equality-filter, alias-qualified
> body) over random base seeds, with `numRuns: 50` per law and a pure law core +
> negative self-test mirroring Key Soundness. Lineage agreement is realized as: every
> forward key (`keysOf` / `isUnique`) is `base`-writable and, traced through
> `deriveViewColumns` plus the σ filter-constants, reconstructs the base PK, and a
> fully-surviving base PK is advertised as a forward key. The behavioral laws restrict
> to the shapes the Phase-1 rewrite admits; `LIMIT`/`OFFSET`/`DISTINCT` bodies are
> asserted to *reject* (never silently widen). `view-mutation-plan-node-substrate`
> threads each operator's backward method against this same block as it extends the
> zoo to the planned multi-source tree.

### The predicate-honest complement

The § Philosophy fan-out makes the **complement** — what a write holds fixed, i.e.
what the view does *not* expose — *determined*, not chosen (the Bancilhon–Spyratos
ambiguity does not arise). Make it a first-class derived object. For the single-source
projection-and-filter case the complement is:

- the **projected-away base columns** (present in the base, absent from the view
  image), plus
- the **negation-free residual of the view predicate** (the σ conjuncts that constrain
  base rows the view never surfaces),

expressed in the same FD/predicate vocabulary as the forward walk. With the complement
in hand the lens prover's *Round-trip (lens laws)* check becomes **computed**, not an
enumerated checklist: **GetPut** holds iff `put` leaves the complement fixed, and
**PutGet** holds iff `get ∘ put` reproduces the written view image. The annotation
layer exposes this object (`analysis/view-complement.ts` — `viewComplement(node)` /
`complementOf`, **landed**); the lens prover (`schema/lens-prover.ts`,
`proveRoundTrip` seam) is the consumer that rides onto it.

## Background

Quereus's view updateability draws on the following bodies of work:

- **Bancilhon, F., & Spyratos, N. (1981). "Update Semantics of Relational Views."** Established the constant-complement framework. Quereus sidesteps the ambiguity by adopting predicate-honest fan-out: rather than choosing one of several legal complements, Quereus applies every consistent base operation.
- **Date, C. J., & Darwen, H. (2006). "Databases, Types, and the Relational Model: The Third Manifesto."** The principle that any relation expression should be a first-class mutation target underpins the unification of views, CTEs, and subqueries-in-`from` as the same propagation surface.
- **Keller, A. M. (1985). "Algorithms for Translating View Updates to Database Updates for Views Involving Selections, Projections, and Joins."** Source of the per-operator decomposition strategies, adapted here to use functional dependencies rather than per-view annotation.
- **Bohannon, A., Pierce, B. C., & Vaughan, J. A. (2006). "Relational Lenses: A Language for Updatable Views."** Types `select` / `project` / `join` lenses with FD-and-predicate annotations and proves GetPut / PutGet *compositionally, per operator*. Directly on point for Quereus's FD-annotated operators, and the basis for the decided discipline in § Round-Trip Laws and the Derived Backward Walk: the backward (`put`) direction is a *derived, law-checked* dual of each operator's forward FD walk — never a parallel hand-maintained walk. See also Foster et al. (2007) in [the lens layer's background](lens.md#background).
- **Voigtländer, J. (2009). "Bidirectionalization for Free!"** Source of the committed north-star: mechanically deriving `put` from `get`. Quereus authors every operator's backward method as a get→put derivation now (the auto-deriver itself is sequenced once the operator set stabilizes), so the eventual mechanical derivation is a refactor behind the same round-trip law.
- **Dataphor (Alphora, D4 language).** The closest commercial precedent. Quereus borrows the `default_for`-style metadata mechanism and the view-as-first-class-target stance; it extends the model with FD- and EC-driven default recovery, eliminating most cases where a Dataphor user would have annotated.
- **Litak, T., & Mikulás, S. (2012). "Relational Lattices."** Algebraic framework over the relational lattice. Quereus's propagation rules read as the lattice-dual of the optimizer's query-rewriting rules.
- **Hegner, S. (2004). "An Order-Based Theory of Updates for Closed Database Views."** Influential on the outer-join materialization semantics.

## Departures from SQL Standard

| Standard Feature | Quereus | Rationale |
|---|---|---|
| `with check option` | Not supported. | Replaced by `create assertion`, which composes across views and runs incrementally. |
| `with read only` | Not supported. | Inferred per-column from lineage; no view-level read-only flag. |
| Updateable-view restrictions (key-preserved tables, etc.) | Not enforced as a separate ruleset. | The FD framework subsumes these — views are updateable iff FD-driven propagation succeeds. |
| `instead of` triggers | Not supported (no trigger system). | Tags provide the override surface; predicate-driven dispatch handles the cases that motivate `instead of`. |
| Per-dialect updateability rules (Oracle key-preserved, PostgreSQL simple views, SQL Server schema-bound) | A single uniform rule. | Reduces the user's mental model to "predicates rule, FDs trace lineage". |
