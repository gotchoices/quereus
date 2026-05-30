# Materialized Views

A **materialized view** in Quereus is a *transparent materialization cache*: a
query body stored once into a keyed backing relation and kept consistent with its
sources **synchronously, inside the writing transaction**. Where a plain
[view](schema.md#viewschema) re-evaluates its body on every reference, a
materialized view serves reads from stored rows — but those rows are maintained at
every source row-write, so a materialized view is observably **indistinguishable
from the plain view it derives from, only faster**.

There is exactly one maintenance model — **row-time** — and no refresh-policy
knob. A materialized view always reflects its sources, including a write the same
transaction just made (reads-own-writes); maintenance commits and rolls back in
lockstep with the source write. The user never reasons about *when* the view is
consistent.

## Why one model

A materialized view exists to be a *correctness-free* optimization: the user adds
it for speed and nothing about query results should change. That requires the view
to be consistent with its sources from a reader's point of view at all times — the
same guarantee a plain view gives. Only synchronous, in-transaction (row-time)
maintenance provides it:

- It is **semantically transparent** — MV ≡ faster view, reads-own-writes. A model
  that lagged within a transaction would itself be a semantic "switch" the user has
  to model.
- It is **transactional** — maintenance is part of the writing statement, so a
  failed maintain simply rolls back with the write. There is no post-commit window,
  no asynchronous drift, and therefore no divergence / self-heal machinery to
  reason about.

The cost is **coverage**: synchronous per-write maintenance is only affordable for
bodies whose backing delta is a bounded projection of the changed row. Bodies that
would require re-running a join/aggregate/recursion per write are **rejected at
create** (see [Eligibility](#eligibility-mandatory-at-create)) rather than served
under a weaker contract. The eligible set grows as
`materialized-view-rowtime-general-bodies` lands; it never silently degrades.

## Substrate: a keyed derived relation

A materialized view is realized as two cooperating schema objects:

```
CREATE MATERIALIZED VIEW mv AS <body>
        │
        ├─ backing TableSchema      "_mv_mv"   ← stored rows, real virtual table
        │     (memory module in v1; primary-keyed; hidden from user catalog)
        │
        └─ MaterializedViewSchema   "mv"             ← the name users reference
              (body AST, inferred PK, bodyHash, sourceTables, backingTableName)
```

- **Backing table.** The materialized rows live in an ordinary `TableSchema`
  registered under the reserved derived name `_mv_<name>`
  (`backingTableNameFor`). In v1 the backing module is always the in-memory table
  module; a `USING <module>(...)` clause parses and is retained for forward
  compatibility but is otherwise ignored. Backing tables are excluded from
  user-facing catalog enumeration — they are an implementation detail.

- **MV record.** A `MaterializedViewSchema` is registered in
  `Schema.materializedViews` (separate from `Schema.tables` and `Schema.views`).
  It retains the parsed body AST, the inferred logical primary key, the `bodyHash`,
  the qualified source-table dependencies, and the backing table's name.

- **Dual registration / name disjointness.** A name may belong to at most one of
  {table, view, materialized view} in a schema. `addTable` / `addView` reject a
  name already held by a materialized view, and `addMaterializedView` rejects a
  name already held by a table or view — enforced in both directions.

### Primary key inference

The eligibility gate requires the body's projection to include **every primary-key
column of its single source `T`** (see below). That makes PK inference
straightforward and robust: the backing table's logical primary key is `T`'s
primary key, mapped through the projection. Each source row maps to exactly one
backing row, so the backing relation is **always a set** — the keyless
all-columns fallback and the "bag body" failure mode that a key-dropping
projection could otherwise produce are structurally unreachable for an eligible
materialized view.

The create-time fill still guards duplicate backing keys defensively
(`replaceBaseLayer` carries an `onDuplicateKey` factory raising a "must be a set"
diagnostic), but for an eligible body that guard never fires.

> **Physical vs logical key.** The backing table's *physical*
> `primaryKeyDefinition` may lead with the body's `order by` columns (so a btree
> scan reproduces the body order), appending the logical key as a
> uniqueness-preserving tiebreaker. `MaterializedViewSchema.primaryKey` keeps the
> logical identity. The covering-structure work generalizes this into a proper
> materialized index.

## DDL statements

Three statements manage materialized views. `MATERIALIZED` and `REFRESH` are
contextual keywords — no new reserved words are introduced.

### `CREATE MATERIALIZED VIEW`

```sql
create materialized view mv [if not exists] [(col, ...)]
  [using <module>(...)]
  as <body>
  [with tags (...)];
```

- `<body>` is a relation-producing `QueryExpr` accepted by the
  [eligibility gate](#eligibility-mandatory-at-create). An explicit column list
  renames the body's output columns (arity must match).
- There is **no** `with refresh = '...'` clause. Every materialized view is
  row-time maintained.
- The body is evaluated immediately and the result stored. On any failure during
  the fill — or if the body is ineligible — the backing table is rolled back and
  the MV is **not** registered; a create is all-or-nothing.

### `REFRESH MATERIALIZED VIEW`

```sql
refresh materialized view mv;
```

Re-evaluates the body against current source data and atomically replaces the
backing table's contents (`replaceBaseLayer` builds a fresh base layer and swaps it
under the schema-change latch; readers use start-of-call snapshot isolation, so a
concurrent scan sees either the old contents or the new — never a torn state).

Because row-time maintenance keeps the backing consistent continuously, `REFRESH`
is **not required for currency**. It is retained as an explicit resync verb — useful
to recover a [`stale`](#schema-change-staleness) MV after a source schema change,
and as the mechanism behind declarative drop-and-recreate on a body change.

### `DROP MATERIALIZED VIEW`

```sql
drop materialized view [if exists] mv;
```

Drops both the MV record and its backing table. `DROP TABLE` / `DROP VIEW` reject a
materialized-view name and redirect to `DROP MATERIALIZED VIEW`; conversely
`DROP MATERIALIZED VIEW` on a plain table/view name redirects to the right
statement.

## Eligibility (mandatory at create)

Row-time maintenance is affordable only when the per-write backing delta is a
bounded projection of the changed row. The accepted body shape (recognized from the
optimized/analyzed body, a superset of the coverage prover's shape in
`planner/analysis/coverage-prover.ts`) is:

- a **single** source table `T` with a primary key (no joins / self-joins);
- a row-preserving **linear** body `TableReference → optional Filter → Project →
  optional Sort` — **no** aggregate, set operation, `DISTINCT`, recursive CTE,
  table-valued function, or `LIMIT`/`OFFSET`;
- a **passthrough** projection — every output column forwards a source column
  (a bare column reference or a simple rename); a computed/expression column
  (e.g. `v + 1`) is rejected, since maintenance is a pure column permutation of
  the changed row (deterministic projected expressions are deferred to
  `materialized-view-rowtime-expression-projections`);
- the projection includes **every** PK column of `T`, so each source row maps to a
  unique backing key (and the backing key identifies the source row);
- a partial `WHERE`, if present, evaluable on a single source row (compiled via
  `compilePredicate`; subqueries / cross-row references are rejected).

Any other body is **rejected at create** with a shape-specific diagnostic that
names the unsupported feature and steers the user to a plain `view` (for live
re-evaluation) or `create table … as <body>` (for a one-off snapshot). There is no
escape-hatch policy that accepts an ineligible body.

> Note: a table declared without an explicit `primary key` defaults to an
> **all-columns** PK (`schema/table.ts`), so the "source without a PK" rejection is
> effectively unreachable for memory tables. The relevant create-time failure is
> "projection drops a source PK column."

The shapes deferred to `materialized-view-rowtime-general-bodies` — single-source
aggregates, inner/cross-join row-preserving bodies, and lateral-TVF fan-out — are
rejected today; recursion and set operations are out of the row-time model
entirely (no bounded per-write residual).

## Query resolution

A reference to `mv` in a query resolves to a `TableReferenceNode` against the
**backing table**, not to a body expansion. Reads therefore go straight to the
stored rows and cost like a table scan, not like re-running the body. (An
unqualified MV reference resolves against the current schema; a materialized view
in a non-current schema must be qualified.)

## Write boundary (read-only)

A materialized view is **read-only to direct DML**. `INSERT` / `UPDATE` / `DELETE`
targeting an MV name are rejected at build time (`assertNotMaterializedView` is
wired into all three DML builders). The stored contents change only through
row-time maintenance (or `REFRESH` / a declarative rebuild). The *source* tables
remain fully writable, and a source write propagates to the MV synchronously.
Write-through (`put` semantics on an MV) is future work
(`materialized-view-writes-through-body`).

## Maintenance (row-time, per-statement)

For each materialized view the manager caches a `RowTimeMaintenancePlan`
(projection column map + backing PK + optional predicate), keyed by source base.
The per-row backing delta is a **pure projection of the changed row** — no body
re-execution, no scan, no compiled residual:

| source op | maintenance |
|---|---|
| insert `r` | if `predicate(r)` → upsert `project(r)` |
| delete `r` | if `predicate(r)` (was in scope) → delete the backing key of `project(r)` |
| update `old→new` | delete old image if in scope; upsert new image if in scope |

The update arm covers predicate-scope transitions and key-changing updates. This
bounded O(log n) per-row cost (a btree delete + insert) — identical to the
secondary-index maintenance a UNIQUE auto-index already performs — is why row-time
is affordable for this shape and not for general bodies.

### Synchronous, transactional, per-statement

Maintenance is driven from the **runtime DML write boundary**
(`runtime/emit/dml-executor.ts`), immediately after each source row is recorded
(`_recordInsert/_recordUpdate/_recordDelete`), via
`Database._maintainRowTimeCoveringStructures(sourceBase, change)`. A cheap
synchronous guard (`_hasRowTimeCoveringStructures`) makes this a no-op fast path
for tables no materialized view reads, so non-covered writes pay effectively
nothing.

Deltas are **batched per statement** rather than flushed strictly per row: a bulk
`insert`/`update`/`delete` accumulates its backing ops and flushes once at the
statement boundary, amortizing the backing-connection/layer lookup over the whole
statement. Reads-own-writes still holds *between* statements within a transaction —
the property that matters — without paying per-row maintenance overhead on bulk DML.

The backing write is routed through the **same `MemoryTableConnection` a `select`
from the MV would use** in this transaction (obtained/registered lazily). The
privileged write `MemoryTableManager.applyMaintenanceToLayer(connection, ops)`
applies the ordered `delete-key` / `upsert` ops to that connection's **pending**
`TransactionLayer`, bypassing `validateMutationPermissions` (backing tables are
read-only to user DML) and reusing `recordUpsert`/`recordDelete` so secondary-index
bookkeeping stays correct. Because the connection is in the Database's active set:

- a later read of the MV in the same transaction sees the pending writes **for
  free** (reads-own-writes);
- the pending layer is committed atomically by the existing coordinated commit
  (`database-transaction.ts`) and discarded by the existing rollback broadcast — so
  a rollback (or a failed source write inside the statement savepoint) reverts the
  backing delta in lockstep; and
- an autocommit `insert into T` rides the **statement-level** autocommit boundary,
  so source and backing commit together — no orphaned/uncommitted backing pending
  layer.

Because maintenance is part of the writing transaction and never re-reads the
source, it cannot "diverge" from its sources between writes: there is no
post-commit window and no asynchronous failure mode. A maintenance error fails (and
rolls back) the source write itself.

`Database.watch` on a materialized view projects to the MV's **sources** (the
backing table is maintained off the user change log) — see
[Change-scope projection](#change-scope-projection).

## Schema-change staleness

Row-time maintenance keeps an MV consistent with its sources' *data*. But a
*schema* change to a source (drop / alter) can break the body outright. The
`MaterializedViewManager` subscribes to `table_removed` / `table_modified` change
events and marks any MV whose `sourceTables` includes the changed table as
**stale**.

- On the next **reference**, a stale MV re-validates its body against the current
  source schemas. If the body no longer plans, the reference errors with a staleness
  diagnostic ("a source changed in an incompatible way — drop and recreate") rather
  than serving rows against a broken definition.
- On the next successful **refresh**, the stale flag is cleared.

`stale` is the **only** MV read-state flag. (The `diverged` flag and the two-tier
apply-failure recovery existed only for the asynchronous on-commit model, which
row-time replaces — transactional maintenance has nothing to diverge.) A known
limitation: a prepared statement planned *before* an MV went stale keeps its cached
plan and bypasses the re-validation until forced to recompile — tracked in
`materialized-view-state-flags-bypass-cached-plans`.

## Change-scope projection

A `select` from an MV resolves to a reference on its backing table, so
`Statement.getChangeScope()` would naively report `_mv_<name>`. But the backing
table is never written through the user change log — it is maintained at the
row-write boundary from its sources — so a `Database.watch` on it would never fire.
To fix this, the manager caches a **source-union change-scope** on the MV at
registration (`MaterializedViewSchema.sourceScope`, v1 = a `full` watch per source
via `buildSourceUnionScope`), and change-scope analysis substitutes it for the
backing-table watch (see
[change-scope.md](change-scope.md#materialized-view-reference-projection)). A
`Database.watch` on such an MV therefore fires on a **source** mutation.

A precise per-source row/group scope, mirroring the maintenance projection the
manager already derives, is a future refinement.

## Declarative-schema integration

Materialized views participate in the
[declarative-schema](schema.md#declarative-schema) pipeline. A
`declare schema { ... }` block accepts a `materialized view` item:

```sql
declare schema main {
  table t { id integer primary key, x integer not null }
  materialized view mv as select id, x from t
}
apply schema main;
```

- **DDL round-trip.** `apply schema` and schema export emit canonical
  `create materialized view ...` DDL via `ast-stringify`, so a schema survives
  `schema → DDL → parse → schema` with no shape change.
- **Body-change rebuild.** The differ keys rebuild detection on `bodyHash`
  (`toBase64Url(fnv1aHash(<canonical body SQL>))`, shared by MV creation and the
  differ). When a declared MV's body hash differs from the live MV's `bodyHash`, the
  differ schedules a **drop + recreate** (materialized views have no in-place
  `ALTER` primitive). The recreate re-materializes from current sources, in apply
  order — after source tables and views are created, before assertions. An unchanged
  body produces no create and no drop. Tags do not perturb the schema version (they
  are stripped before hashing).

## Covering structures

A UNIQUE constraint is *logical*; the structure that enforces it is *optional* and
may take more than one physical shape. Quereus describes every such shape in one
vocabulary — the **covering structure** — so the enforcement layer (and the lens
layer above it) can pattern-match a single surface (`CoveringStructure` in
`vtab/memory/layer/manager.ts`):

```
type CoveringStructure =
  | { kind: 'memory-index';      index: MemoryIndex }            // the auto-built secondary BTree
  | { kind: 'materialized-view'; view:  MaterializedViewSchema } // an explicit covering MV
```

### Implicit covering structures (the auto-index, reframed)

Every declared UNIQUE constraint auto-builds a synchronously-maintained secondary
BTree for efficient enforcement (`ensureUniqueConstraintIndexes`). That BTree is
reframed as an **implicit covering structure** —
`origin: 'implicit-from-unique-constraint'` in the materialized-view vocabulary —
held as a lightweight association on the memory-table manager (it is *not*
registered as a `MaterializedViewSchema`; the BTree is the structure). Row-time
enforcement (`findIndexForConstraint`) returns this `memory-index` variant. The
physical structure is unchanged from before the reframe.

Implicit covering structures are a backing detail and are **hidden from
`collectSchemaCatalog` / schema export by default**, surfaced only when the
originating constraint carries the tag `quereus.expose_implicit_index = true`.

### Explicit covering structures (the coverage prover)

A user-declared materialized view can *cover* a UNIQUE constraint. The **coverage
prover** (`planner/analysis/coverage-prover.ts`) recognizes the canonical covering
shape and records the link eagerly at MV-creation time. For

```sql
create table t (id integer primary key, x integer not null, y integer not null, unique (x, y));
create materialized view ix_t_xy as select x, y, id from t order by x, y;   -- covers unique(x,y)
```

the prover proves `ix_t_xy` covers `unique(x, y)` and stamps the link (see
[Schema § Covering-structure links](schema.md#covering-structure-links)).

Recognition rules (narrow v1 — every check is conservative; a false *NotCovers*
only forgoes an optimization, a false *Covers* would be unsound):

- **Shape.** The optimized body walks down to a single constrained base table `T`
  (`TableReference → optional Filter/Alias → Project → optional Sort`; physical
  access nodes are transparent). A **binary join** is admitted when `T` provably
  contributes *exactly one* MV row per governed `T` row (see the join decomposition
  below). Aggregation, `DISTINCT`, set operations, `FanOutLookupJoin`, `AsofScan`,
  or a `LIMIT`/`OFFSET` row cap ⇒ not covering.
- **Join (1:1) decomposition.** "Exactly one MV row per governed `T` row" splits
  into two independent obligations:
    - *No row loss (≥1):* proven structurally during the plan walk, two ways:
      **(a) row preservation** — `T` on the row-**preserving** side of the join (a
      `left` join with `T` in the left subtree, or a `right` join with `T` in the
      right subtree); or **(b) referential integrity** — an `inner`/`cross` join
      whose equi-pairs are a **NOT-NULL foreign key from `T` to the lookup table's
      primary key**, over a lookup side that exposes the parent's *full* row set, so
      enforced RI makes the join 1:1 (`innerJoinRetainsConstrainedTable`; the same
      NOT-NULL-FK + full-parent-row-set discipline `rule-join-elimination`'s INNER
      branch uses — declared FKs are trusted as inclusion dependencies, so this
      adds no assumption the optimizer doesn't already make). An `inner`/`cross`
      join *without* a covering NOT-NULL FK, `semi`/`anti`, `full`, and `T` on the
      dropping side are rejected as *shape*. (FDs encode uniqueness, not existence,
      so obligation (a) is a structural plan-walk check; (b) reads the FK schema.)
    - *No fan-out (≤1):* `T`'s primary key must be a unique key of the **topmost
      join's output relation** (read via `isUnique`). The optimizer emits
      `T.pk → all_join_cols` into the join's FDs exactly when the equi-pairs cover a
      unique key of the lookup side; the moment the lookup side can multiply a `T`
      row, no such FD is emitted and the gate fails (`fanout`). The check is against
      the *join* frame, not the projected body root. When the optimizer instead
      *eliminates* a key-preserving join (FK→PK aligned, lookup unprojected — see
      `rule-join-elimination`), the body collapses to a single-source chain and the
      v1 path covers it directly.
- **Projection.** The output must include every UC column **and** every primary-key
  column of `T` (the PK identifies the source row for conflict resolution).
- **Ordering.** The body's `order by` columns must be a permutation of the UC
  columns. A missing `order by` does not cover. (Ordering and the WHERE predicate are
  read from the **body AST**, not the optimized plan, because the optimizer drops the
  `Sort` and absorbs a `WHERE` into an index range seek.)
- **Predicate alignment.** The body's materialized row set must equal the set the
  constraint governs: the WHERE predicate must entail `uc.predicate` (for partial
  UNIQUE) and an `is not null` per nullable UC column (NULL-skip), and must add no
  restriction beyond that. Entailment reuses the partial-UNIQUE clause vocabulary —
  see [Optimizer § Coverage proving](optimizer.md#coverage-proving).

### Enforcement through a covering MV (delivered)

Row-time UNIQUE enforcement (the in-place substitution of `insert or replace`, the
skip of `insert or ignore`, the conflict diagnostic of the default `abort`) requires
the covering structure to be consistent *at the moment of the write*. A covering
materialized view's backing table is maintained **synchronously with each source
row-write** (row-time), so it is consistent mid-statement — the same property the
auto-index has — and is therefore eligible to answer conflict resolution.

`findIndexForConstraint` resolves it via
`Database._findRowTimeCoveringStructure(schema, table, uc)` — a synchronous map
lookup keyed on the constraint's `coveringStructureName` forward pointer, gated on a
live covering plan that is not `stale` (structural breakage), with an O(1) negative
fast path off `rowTimeBySource` so a non-covered table pays effectively nothing —
and returns the `materialized-view` covering variant **in preference to** the
`memory-index` auto-index. `checkSingleUniqueConstraint`'s `materialized-view` arm
then point-looks-up the covering MV's backing table
(`Database._lookupCoveringConflicts`, reads-own-writes through the backing's
coordinated connection — v1 is a full backing scan; a backing-PK prefix scan is a
sound later optimization in `covering-mv-enforcement-prefix-scan-and-preference`) and
recovers each conflicting **source** PK from the MV projection so REPLACE / IGNORE /
ABORT resolve against the correct source row.

**The preference tradeoff.** With a linked covering MV present, the covering MV — not
the auto-index — answers conflict resolution. The auto-index remains maintained but
*unconsulted* (a redundant read-answering copy). For *physical* schemas this makes
the MV path live and testable in v1 (the auto-index always exists, so the MV path is
otherwise unreachable); it becomes the *sole* enforcement structure in the
**logical-schema** world (the lens layer), where the auto-index is retired. Whether
the MV should outrank the auto-index for physical schemas (an O(n) backing scan vs an
O(log n) probe until the prefix scan lands) is revisited in
`covering-mv-enforcement-prefix-scan-and-preference`.

**The eviction-maintenance edge.** A REPLACE evicts the conflicting **source** row
directly on the source storage (memory transaction layer / store delete), which
*bypasses* the DML-executor row-time maintenance hook (it fires only for DML-executor
row writes, not for evictions internal to a vtab's update). So every REPLACE eviction
on this path also drives `Database._maintainRowTimeCoveringStructures(sourceBase,
{ op: 'delete', oldRow })` to remove the evicted row's backing entry within the same
statement — otherwise that entry would go stale and produce a phantom conflict for a
later same-UC row. Symmetrically, the conflict path validates every backing candidate
against the *live* source row before acting, so a stale candidate is skipped rather
than raised as a false conflict.

**Store-module parity.** `store-table.ts` routes UNIQUE conflict resolution through
the same `_findRowTimeCoveringStructure` / `_lookupCoveringConflicts` surface (the
backing table is always the memory module, queried through the db), validating
candidates against the live store row (committed + this transaction's pending
overlay). The constraint's `coveringStructureName` forward pointer is set by the
eager prove-and-link on the *schema-manager's* constraint; a store table holds a
copied schema whose constraint never received that mutation, so the resolver falls
back to the authoritative schema-manager constraint matched by column set
(`resolveCoveringStructureName`). The **isolation-wrapped** store path
(`createIsolatedStoreModule`, exercised by `yarn test:store`) enforces UNIQUE via its
own merged-view detection rather than the covering MV; routing that layer through the
covering MV is tracked in `covering-mv-isolation-layer-enforcement-routing`.

**FD-derived "body proves it" is a different proof.** Separate from base-table
covering, `coverage-prover.ts` exposes `proveEffectiveKeyUnique`, which proves the
body's *own output relation* is unique on a set of output columns via its effective
key (FD closure) — e.g. a `group by x, y` body is intrinsically one row per `(x, y)`.
This is the obligation primitive the lens layer's `obligation: proved` class
consumes; it is a proof about the **derived (output) relation**, **not** a base-table
covering structure, and is deliberately kept out of `proveCoverage` because an
FD-derived output key masks base-row duplicates. See
[Optimizer § Effective-key proving](optimizer.md#effective-key-proving-body-proves-it)
and [Lenses § the constraint-role split](lens.md).

Multi-source 1:1 join bodies are **delivered**: outer-join row preservation
(`coverage-prover-multi-source-bodies`) and `inner`/`cross` lookup joins on an enforced
NOT-NULL FK→PK (`coverage-prover-inner-join-fk-preservation`, the no-row-loss obligation
closed by referential integrity). The AST `ORDER BY` / `WHERE` column resolution is
**qualifier-aware** (`coverage-prover-qualified-name-resolution`): `alias.col` resolves to
a `T` column only when `alias` denotes `T`'s reference (and a bare `col` only when
unambiguous across the join's sources), so a 1:1 join whose lookup key reuses a UC column
name now covers — a term on a lookup column instead fails on its own terms
(`ordering-mismatch` / `predicate-entailment`). Full-outer covering stays deferred (it
injects lookup-only rows with no governed `T` row).

## Out of scope / roadmap

The following extensions build on this substrate:

- **Unified maintenance substrate** (`incremental-maintenance-substrate-spike`) — a
  design-spike reconsidering *how* the next maintenance shapes are built: it unifies
  this row-time inverse-projection path and the post-commit `DeltaExecutor` binding
  kernel under one `MaintenancePlan` abstraction, adds a backward
  (maintenance-direction) cost gate, and decides via a bounded proof-of-concept whether
  a Z-set / DBSP-style delta circuit is worth adopting for the harder shapes. The
  spike's outcome is not yet decided; the general-bodies and MV-over-MV-cascade items
  below are retargeted to build on its abstraction once it lands.
- **Row-time general bodies** (`materialized-view-rowtime-general-bodies`) — extend
  the eligibility gate to single-source aggregates, inner/cross-join row-preserving
  bodies, and lateral-TVF fan-out, maintained synchronously per statement. These
  shapes are rejected today; this now builds on the maintenance substrate spike above.
- **Cascading MV-over-MV** — a materialized view whose source is another MV's backing
  table. Requires the maintenance write to drive dependents synchronously (DAG-ordered)
  within the statement; deferred from the consolidation (an MV-over-MV is rejected
  until then).
- **Concurrent refresh** (`materialized-view-concurrent-refresh`) — overlapping
  refreshes and refresh-while-read beyond today's atomic base-layer swap.
- **Write-through DML** (`materialized-view-writes-through-body`) — accept DML against
  an MV and propagate to sources via [view updateability](view-updateability.md).
  Distinct from row-time *maintenance*: this is writing *the MV*, not keeping it in
  sync with source writes.
- **Backing-module pluggability** — honor `USING <module>(...)` so the stored relation
  can live in a module other than the in-memory table.
- **Covering-structure enforcement follow-ups** — backing-PK prefix scan + the
  physical-schema preference decision
  (`covering-mv-enforcement-prefix-scan-and-preference`) and isolation-layer routing
  (`covering-mv-isolation-layer-enforcement-routing`).
- **Lens / layered schemas** — indexes and set-level constraint enforcement expressed
  as covering materialized views in the basis layer. See
  [Lenses and Layered Schemas](lens.md).
