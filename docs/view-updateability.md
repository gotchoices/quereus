# View Updateability

## Status

This document is the decided design (the source of truth for *intent*). What has
actually shipped:

| Phase | Scope | State |
|---|---|---|
| **Phase 1** | Single-source projection-and-filter views: `insert` / `update` / `delete` route to the base table. Constant-FD defaults from equality selection predicates, base-column defaults, identity/rename projection lineage, `OR`-clause conflict resolution, and the `no-inverse` / `predicate-contradiction` / `recursive-cte` / body-shape diagnostics. | **Shipped** |
| **Phase 1b** | Per-statement mutation-context threading through the view boundary (one captured value stamped across every base row of the statement). Single-base per-row generator cadence rides the base table's column defaults. | **Shipped (single-base)** |
| Phases 2–7 | Multi-source / outer joins, set-ops, aggregates, RETURNING-through-views, nested/recursive CTE bodies, the `quereus.update.*` tag override surface, shared-surrogate fan-out threading. | Not shipped — rejected at plan time with a structured diagnostic. |

**Implementation note (Phase 1).** Phase 1 ships as an AST-level rewrite in
`planner/building/view-mutation.ts`: a view-targeted DML whose body classifies as
a single-source projection-and-filter (gate in `planner/mutation/propagate.ts`) is
rewritten to target the base table and re-planned through the ordinary base-table
builder. All constraint / conflict / FK / mutation-context machinery — and
`getChangeScope()` / `Database.watch` — are therefore reused verbatim with no
view-specific runtime. The shipped lineage model lives in
`planner/analysis/update-lineage.ts` and `planner/analysis/scalar-invertibility.ts`.

The plan-node-threaded `updateLineage` / `AttributeDefault` surface on
`PhysicalProperties` (§ Implementation Surface) and a `ViewMutationNode`
orchestrator over reused `DmlExecutorNode`s are the **multi-source Phase-2
foundation** and are intentionally not wired yet — for the single-source case the
AST rewrite is complete and an orchestrator over one base op adds no behavior. The
retire-or-keep decision for this substrate is settled under
`view-mutation-plan-node-substrate`: the AST rewrite is **retired** in favor of the
substrate, which becomes the single propagation path for all view mutations (its
single-source case is the trivial one-base-op path); `building/view-mutation.ts` is
removed once parity is proven.

**Write-through materialized views** remain read-only at the user-write boundary
(`materialized-view-core`, shipped). Write-through-MV is a future ticket gated on
this one.

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

### Inner Join

The lineage of an inner-join output column traces unambiguously to one of the two child relations (EC propagation makes column membership precise even for equi-join columns).

**Updates** route per-column to the side that owns each column. A `set` clause assigning columns from both sides produces two child operations executed atomically. The row-identifying predicate for each child is the projection of the join's row-identifying predicate onto that child's key columns.

**Inserts** require values for both sides' `not null`-without-default columns and must satisfy the join predicate. The two child inserts execute FK-parent before FK-child where the dependency is provable; otherwise the order is unspecified. The join predicate, combined with the inserted values, supplies missing join-key columns on either side via EC.

**Deletes** are inherently ambiguous — removing the joined row requires deleting from at least one side. The default rule:

- If exactly one side's row participates in *only* this joined row (provable when that side's PK is uniquely covered by the row-identifying predicate and that PK does not appear in any other surviving join), delete from that side.
- Otherwise, delete from the side named by the `delete_via` tag on the join, or — absent a tag — from every side, the predicate-honest reading of "make this row not exist".

For the common FK-style 1-to-many join, this default deletes from the many side, leaving the parent in place. Users who want the inverse attach `with tags ("quereus.update.delete_via" = 'parent')`.

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
`quereus.update.*` seeds — the registry validates their shape/site; their Effect
(semantics) is realized by the view-mutation override surface, not the registry:

| Tag | Where | Effect |
|---|---|---|
| `"quereus.update.target"` | view DDL, branch of `union`/`intersect`/`except`, join side, dml statement | Restrict propagation to the listed relation(s). Value is a comma-separated list of base table names or branch identifiers. |
| `"quereus.update.exclude"` | same | Exclude the listed branches; the inverse of `target`. |
| `"quereus.update.default_for.<column>"` | view DDL, projection | Default expression for `insert` through the view when the column is omitted. The expression may reference any surviving column. |
| `"quereus.update.delete_via"` | `except`, join | For `except`: `'left_delete'` (default) or `'right_insert'`. For joins: pick the side whose deletion realizes the view-level delete. |
| `"quereus.update.policy"` | view DDL | `strict` (reject any ambiguity) or `lenient` (default; predicate-honest fan-out). |

Tags compose with the predicate-driven dispatch: predicates always run first, narrowing the candidate set; tags then further restrict, or — for `default_for` — supply missing values. Tags can never broaden the candidate set beyond what predicates allow.

Statement-level tags appear in a `with (...)` clause on the statement:

```sql
update v with ("quereus.update.target" = 'base_a') set col = 1 where ...;
insert into v with ("quereus.update.default_for.created" = epoch_ms('now')) values (...);
delete from v with ("quereus.update.delete_via" = 'right_insert') where ...;
```

Statement-level tags override view-level tags for the duration of the statement.

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

`insert`, `update`, and `delete` through a view support `returning`. The returned rows are projected through the **view's** column list, not the base tables'. The engine evaluates the view body against the post-mutation state to produce returning rows — equivalently, against the captured per-operation results, since the view's lineage maps base rows back to view rows.

`returning` columns of `computed` lineage (a view-level computed expression) are evaluated against the post-mutation base values.

## Mutation Context

The `with context` envelope (see [Sequential ID Generation](architecture.md#sequential-id-generation)) wraps the entire view-mediated mutation. It is also the mechanism by which **generated values enter at the propagation boundary while DML stays deterministic**.

Determinism in Quereus means a statement's effect is a pure function of database state and *captured context* — non-deterministic inputs are not forbidden, they are captured once at the envelope, recorded, and replayed identically. A view-mediated mutation frequently needs a value present at neither the user-visible relation nor the inserted row: a surrogate key that several base tables share, a sequence value, a creation timestamp. Such a value is supplied by a **generated default** on the base column (a sequence, a surrogate allocator, a clock read), evaluated through the context envelope and recorded with the statement. The propagation is therefore deterministic-given-context, and the generation is a context concern, identical to how sequential IDs and captured timestamps already work. No layer above introduces non-determinism — it consumes the escape valve the engine already provides.

Bindings have two cadences:

- **Per-statement** — a captured `now`, a bound parameter. Evaluated once; stable across every row and every base operation the statement emits (transaction-time semantics).
- **Per-row** — a sequence, a surrogate allocator. Evaluated once *per top-level row produced*, so a multi-row insert mints a distinct value per row. The captured context records the per-row values, preserving replay.

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
    | 'tag-target-not-found'            // tag references unknown branch/table
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

`information_schema.views` exposes per-view propagation summaries:

| Column | Meaning |
|---|---|
| `is_insertable_into` | `'YES'` if every `not null`-without-default base column has a recoverable value via FD / EC / `default_for`. |
| `is_updatable` | `'YES'` if at least one output column has `base` lineage. Per-column updateability lives in `information_schema.columns.is_updatable`. |
| `is_deletable` | `'YES'` if the row-identifying predicate is constructible at every base reachable from the view. |
| `effective_targets` | JSON array of base tables that mutations through the view may touch by default. |

`information_schema.columns.is_updatable` reports per-column updateability for every view (and base table) in the catalog. Values are computed at schema-attachment time and refreshed when the underlying schema changes.

## Implementation Surface

- `src/planner/nodes/plan-node.ts` — `updateLineage: ReadonlyMap<AttributeId, UpdateSite>` on every relational `PlanNode`.
- `src/planner/analysis/update-lineage.ts` — single-pass lineage computation; runs in the physical-property phase alongside FD propagation.
- `src/planner/mutation/propagate.ts` — visitor that walks a relation tree with a `MutationRequest` and emits `BaseOp[]`. One method per operator type, mirroring `runtime/emit/`.
- `src/func/invertibility.ts` — `InvertibilityProfile` type, built-in profile registry, UDF registration hook.
- `src/runtime/emit/view-mutation.ts` — instruction emitter that issues the emitted base operations in order and accumulates `returning` rows.
- `src/schema/view.ts` — `ViewSchema.effectiveTargets`, `ViewSchema.defaultsForColumn`, populated at view-creation time.

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
**PutGet** holds iff `get ∘ put` reproduces the written view image. The substrate
exposes this object; `3-lens-prover-and-constraint-attachment` consumes it.

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
