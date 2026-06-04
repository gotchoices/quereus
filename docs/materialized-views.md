# Materialized Views

A **materialized view** in Quereus is a *transparent materialization cache*: a query body stored once into a keyed backing relation and kept consistent with its sources **synchronously, inside the writing transaction**. Where a plain [view](schema.md#viewschema) re-evaluates its body on every reference, a materialized view serves reads from stored rows — but those rows are maintained at every source row-write, so a materialized view is observably **indistinguishable from the plain view it derives from, only faster**.

There is exactly one maintenance model — **row-time** — and no refresh-policy knob. A materialized view always reflects its sources, including a write the same transaction just made (reads-own-writes); maintenance commits and rolls back in lockstep with the source write. The user never reasons about *when* the view is consistent.

## Why one model

A materialized view exists to be a *correctness-free* optimization: the user adds it for speed and nothing about query results should change. That requires the view to be consistent with its sources from a reader's point of view at all times — the same guarantee a plain view gives. Only synchronous, in-transaction (row-time) maintenance provides it:

- It is **semantically transparent** — MV ≡ faster view, reads-own-writes. A model that lagged within a transaction would itself be a semantic "switch" the user has to model.
- It is **transactional** — maintenance is part of the writing statement, so a failed maintain simply rolls back with the write. There is no post-commit window, no asynchronous drift, and therefore no divergence / self-heal machinery to reason about.

The cost is **coverage**: synchronous per-write maintenance is only affordable for bodies whose backing delta is a bounded projection of the changed row. Bodies that would require re-running a join/aggregate/recursion per write are **rejected at create** (see [Eligibility](#eligibility-mandatory-at-create)) rather than served under a weaker contract. The eligible set grows over time; it never silently degrades.

## Substrate: a keyed derived relation

A materialized view is realized as two cooperating schema objects:

```
CREATE MATERIALIZED VIEW mv AS <body>
        │
        ├─ backing TableSchema      "_mv_mv"   ← stored rows, real virtual table
        │     (memory module; primary-keyed; hidden from user catalog)
        │
        └─ MaterializedViewSchema   "mv"             ← the name users reference
              (body AST, inferred PK, bodyHash, sourceTables, backingTableName)
```

- **Backing table.** The materialized rows live in an ordinary `TableSchema` registered under the reserved derived name `_mv_<name>` (`backingTableNameFor`). The backing module is the in-memory table module; a `USING <module>(...)` clause parses and is retained for forward compatibility but is otherwise ignored. Backing tables are excluded from user-facing catalog enumeration — they are an implementation detail.

- **MV record.** A `MaterializedViewSchema` is registered in `Schema.materializedViews` (separate from `Schema.tables` and `Schema.views`). It retains the parsed body AST, the inferred logical primary key, the `bodyHash`, the qualified source-table dependencies, and the backing table's name.

- **Dual registration / name disjointness.** A name may belong to at most one of {table, view, materialized view} in a schema. `addTable` / `addView` reject a name already held by a materialized view, and `addMaterializedView` rejects a name already held by a table or view — enforced in both directions.

### Primary key inference

The eligibility gate requires the body's projection to include **every primary-key column of its single source `T`**. That makes PK inference straightforward and robust: the backing table's logical primary key is `T`'s primary key, mapped through the projection. Each source row maps to exactly one backing row, so the backing relation is **always a set** — the keyless all-columns fallback and the "bag body" failure mode that a key-dropping projection could otherwise produce are structurally unreachable for an eligible materialized view.

The create-time fill still guards duplicate backing keys defensively (`replaceBaseLayer` carries an `onDuplicateKey` factory raising a "must be a set" diagnostic), but for an eligible body that guard never fires.

> **Physical vs logical key.** The backing table's *physical* `primaryKeyDefinition` may lead with the body's `order by` columns (so a btree scan reproduces the body order), appending the logical key as a uniqueness-preserving tiebreaker. `MaterializedViewSchema.primaryKey` keeps the logical identity. The covering-structure work generalizes this into a proper materialized index.

## DDL statements

Three statements manage materialized views. `MATERIALIZED` and `REFRESH` are contextual keywords — no new reserved words are introduced.

### `CREATE MATERIALIZED VIEW`

```sql
create materialized view mv [if not exists] [(col, ...)]
  [using <module>(...)]
  as <body>
  [with tags (...)];
```

- `<body>` is a relation-producing `QueryExpr` accepted by the [eligibility gate](#eligibility-mandatory-at-create). An explicit column list renames the body's output columns (arity must match).
- There is **no** `with refresh = '...'` clause. Every materialized view is row-time maintained.
- The body is evaluated immediately and the result stored. On any failure during the fill — or if the body is ineligible — the backing table is rolled back and the MV is **not** registered; a create is all-or-nothing.

### `REFRESH MATERIALIZED VIEW`

```sql
refresh materialized view mv;
```

Re-evaluates the body against current source data and atomically replaces the backing table's contents (`replaceBaseLayer` builds a fresh base layer and swaps it under the schema-change latch; readers use start-of-call snapshot isolation, so a concurrent scan sees either the old contents or the new — never a torn state).

Because row-time maintenance keeps the backing consistent continuously, `REFRESH` is **not required for currency**. It is retained as an explicit resync verb — useful to recover a [`stale`](#schema-change-staleness) MV after a source schema change, and as the mechanism behind declarative drop-and-recreate on a body change.

### `DROP MATERIALIZED VIEW`

```sql
drop materialized view [if exists] mv;
```

Drops both the MV record and its backing table. `DROP TABLE` / `DROP VIEW` reject a materialized-view name and redirect to `DROP MATERIALIZED VIEW`; conversely `DROP MATERIALIZED VIEW` on a plain table/view name redirects to the right statement.

## Eligibility (mandatory at create)

Row-time maintenance is affordable only when the per-write backing delta is a bounded projection of the changed row. An ineligible body is **rejected at create** with a shape-specific diagnostic that names the unsupported feature and steers the user to a plain `view` (for live re-evaluation) or `create table … as <body>` (for a one-off snapshot). There is no escape-hatch policy that accepts an ineligible body. The accepted body shape is recognized from the optimized/analyzed body (a superset of the coverage prover's shape in `planner/analysis/coverage-prover.ts`).

Four body shapes are eligible, each maintained by a corresponding [maintenance arm](#maintenance-row-time-per-statement).

**1. Covering-index shape** (the *inverse-projection* arm):

- a **single** source table `T` with a primary key (no joins / self-joins);
- a row-preserving **linear** body `TableReference → optional Filter → Project → optional Sort` — **no** aggregate, set operation, `DISTINCT`, recursive CTE, table-valued function, or `LIMIT`/`OFFSET`;
- a **passthrough or deterministic-expression** projection — each output column is either a passthrough source column (a bare column reference or a simple rename) or a **deterministic scalar expression** over the single source row (e.g. `v + 1`, `lower(name)`, `case`/`cast`). A non-deterministic projection (`random()`, `now()`, …) is rejected on *determinism* and a non-single-row form (a subquery / cross-row reference) on *shape*. Either way maintenance stays a pure per-row function of the changed row — `project(row)` copies the passthrough columns and evaluates the expression columns via the runtime, so a computed backing value is byte-for-byte what `select <body>` would produce;
- the projection includes **every** PK column of `T` **as a passthrough column**, so each source row maps to a unique backing key (and the backing key identifies the source row); every backing-key column (the body's `order by` columns + the logical PK) must likewise be passthrough — a computed column may never land in the backing key, which the inverse-projection conflict map and the btree key both depend on;
- a partial `WHERE`, if present, evaluable on a single source row (compiled via `compilePredicate`; subqueries / cross-row references are rejected).

The single source `T` may itself be **another materialized view's backing table** (an MV-over-MV chain). A reference to `mv1` is rewritten to a `TableReference` against `mv1`'s backing table, so the source base *is* `mv1`'s backing base and the same eligibility checks evaluate against the (keyed `memory`) backing schema unchanged. A write to `mv1` then drives `mv2` synchronously (see [Maintenance § MV-over-MV cascade](#mv-over-mv-cascade)).

**2. Single-source aggregate** (the *residual-recompute* arm):

- a **single** source table `T`;
- a body of the form `select g1,…, agg(…) from T [where P] group by g1,…` whose **GROUP BY columns are bare source columns** (a *computed* group key is rejected — the group columns must be source-column indices so the backing can be keyed on them); a *scalar* aggregate with **no** `GROUP BY` (one global row) is not yet eligible;
- a **deterministic** body — the group-by and aggregate expressions must be reproducible (`random()` / `now()` / volatile UDFs are rejected on determinism), so the recomputed slice is exactly what `select <body>` returns;
- the backing primary key is the **group key** (the group-key FD makes `keysOf` derive it), so each group maps to exactly one backing row.

Unlike the covering-index shape, this is maintained not by a pure projection but by a bounded **key-filtered residual** of the body.

**3. Single-source lateral-TVF fan-out** (the *prefix-delete* arm):

- a **single** base source table `T` with a primary key, joined to **one lateral table-valued function** whose arguments are per-row functions of `T` (`select T.pk…, f.* from T cross join lateral tvf(<args over T>) f`) — so each base row drives an independent fan-out of **N** rows; no second base table, no nested/multiple TVF, no aggregate / `DISTINCT` / set-op / recursion over the fan-out;
- a **deterministic** TVF (and deterministic argument expressions) — the residual must reproduce exactly what `select <body>` returns;
- the TVF **advertises a per-call key**, so the backing primary key is the **composite product key** `(T.pk ∪ tvf-key)` that `keysOf` derives across the lateral join (the base PK ∪ the TVF's own key, shifted) — a real column key, not the all-columns/`isSet` fallback. A TVF that advertises no per-call key makes the fan-out rows individually un-addressable and is rejected on *shape*;
- the base PK is **projected** and is the **leading prefix** of the backing PK (an `order by` over the fan-out that reorders the composite key so the base PK no longer leads is rejected on *shape* — the by-prefix delete depends on the base PK leading).

This is maintained by a **by-prefix delete** of the base row's whole fan-out slice plus a **re-fan residual**: one base row owns many backing rows sharing the base-PK prefix, so the slice is replaced as a unit rather than a single point key.

**4. 1:1 row-preserving inner/cross join** (the *join-residual* arm):

- a body `select … from T join P on T.fk = P.id` over **two** base tables where the driving table `T` contributes **exactly one** MV row per governed `T` row, proven by the coverage prover's shared `proveOneToOneJoin` — **no row loss** via a NOT-NULL FK→PK inclusion dependency under enforced referential integrity, and **no fan-out** via `isUnique(T.pk)` at the join frame. A **fanning** (non-1:1) join is rejected on *shape*;
- an **inner** or **cross** join only — an outer join is not yet eligible (the lookup-side reverse residual filters `P`, which would drop its null-extended rows);
- **no aggregate** over the join, and **no `WHERE`** — a partial / lookup-referencing predicate is not yet eligible (the lookup-side maintenance is upsert-only, sound only when join membership is predicate-independent);
- the backing primary key is exactly `T`'s PK (the 1:1 join collapses the composite product key `keysOf` advertises to `T`'s PK — a real column key, not the all-columns fallback), so each `T` row maps to one backing row;
- deterministic projections (the residual must reproduce `select <body>`).

This reuses the residual kernel of the aggregate arm with a `'row'`/`'pk'` binding on `T`, plus a second residual keyed on `P` for lookup-side writes.

> A table declared without an explicit `primary key` defaults to an **all-columns** PK (`schema/table.ts`), so the "source without a PK" rejection is effectively unreachable for memory tables. The relevant create-time failure is "projection drops a source PK column."

Recursion and set operations are out of the row-time model entirely (no bounded per-write residual). See [Current limitations](#current-limitations) for the body shapes still rejected.

## Query resolution

A reference to `mv` in a query resolves to a `TableReferenceNode` against the **backing table**, not to a body expansion. Reads therefore go straight to the stored rows and cost like a table scan, not like re-running the body. (An unqualified MV reference resolves against the current schema; a materialized view in a non-current schema must be qualified.)

### Automatic query rewrite (read side)

The above is the *named* read path. There is also an **automatic** path: the optimizer recognizes when an *arbitrary* scan-projection-filter query — one that **never names** the MV — is *answered from* a covering MV, and rewrites it to scan the MV's backing table with a residual projection/filter instead of recomputing the body against the base tables. This is the read-side dual of the [coverage prover](#explicit-covering-structures-the-coverage-prover) (which proves a base-table `UNIQUE` constraint is covered, on the write/enforcement side).

```sql
create materialized view recent as
  select id, customer_id, amt from sales where amt > 0;

-- never names `recent`, but the optimizer answers from it:
select customer_id, amt from sales where amt > 0 and customer_id = 7;
--   → scan _mv_recent, residual filter (customer_id = 7), residual project (customer_id, amt)
```

The matcher (`planner/analysis/query-rewrite-matcher.ts`) asks **output-relation subsumption**: does the MV's stored rows contain a superset of the rows the fragment produces, keyed so a bounded residual recovers exactly the fragment's output? It reuses the coverage prover's entailment vocabulary (`recognizeConjunctiveClauses` / `guardClausesEntail`), so NULL semantics are identical. Soundness mirrors the prover exactly — **a false NotMatch only forgoes a speedup; a false Match would return wrong rows** — so every check forgoes the rewrite on doubt. The rule (`planner/rules/cache/rule-materialized-view-rewrite.ts`) only ever *replaces* the correct recompute-over-base plan with a provably row-equivalent backing scan, so it is non-regressing (a no-op when nothing matches or the cost gate declines, byte-identical rows when it fires). See [docs/optimizer.md](optimizer.md#materialized-view-query-rewrite-read-side) for the matcher shape rules, the gates (stale / deterministic / source-schema), the cost gate, and pass placement.

This phase handles the **projection + filter subsumption** shape; aggregate rollup and join subsumption are pure additions to the same matcher (`mv-query-rewrite-aggregate-rollup`, `mv-query-rewrite-join-subsumption`). The rewrite is **suppressed while planning an MV's own body** to (re)compute or maintain its backing (create / refresh / row-time-maintenance compile), so a body matching a registered MV is never re-pointed at the backing it is populating (`SchemaManager.withSuppressedMaterializedViewRewrite`).

## Write boundary (write-through)

`INSERT` / `UPDATE` / `DELETE` targeting an MV *name* is **rewritten to target the MV's source table `T`** and re-planned through the ordinary base-table builder — the identical AST-level rewrite plain-view mutation performs, reached via the same `getView(…) ?? getMaterializedView(…)` dispatch wired into all three DML builders. Every MV is (post row-time consolidation) a single-source projection-and-filter — a strict subset of the [view-updateability](view-updateability.md) projection-and-filter shape — so write-through is pure routing, with no MV-specific propagation code. The rewritten write hits `T`, which fires the row-time maintenance hook, so the backing is brought into sync **inside the same statement / transaction**: a subsequent `select … from mv` sees the write (reads-own-writes) and a rollback reverts source + backing in lockstep. A write-through to an MV is observably **indistinguishable from writing the source and reading the MV**.

Per-column writeability is inherited verbatim from [view updateability](view-updateability.md):

- a **passthrough / rename** column routes the assignment/value to its base column;
- a **deterministic-expression** column (e.g. `x + 1 as y`) is **read-only** — a write to it raises the `no-inverse` diagnostic; reads are unaffected and the column is re-derived by maintenance on a passthrough write;
- an omitted column pinned by an equality selection predicate (`… where color = 'green'`) is defaulted on the base via the constant-FD path; an insert that provably contradicts the predicate is rejected (`predicate-contradiction`); an update carrying a row out of the predicate scope succeeds in `T` and the maintenance update arm removes it from the MV.

Two cases are **rejected** (also inherited):

- **RETURNING through an MV** raises the `returning-through-view` diagnostic (RETURNING through views is not surfaced for the MV path yet).
- **MV-over-MV write-through** — DML against an MV whose body's source is *itself* a materialized view — is rejected (`its body reads a materialized view`): its rewrite would target the inner MV's read-only backing table. The source→backing maintenance *cascade* ([§ MV-over-MV cascade](#mv-over-mv-cascade)) is the read/maintain direction and is unaffected; only the MV-name *write* direction one level down is deferred.

There is no `with check option` and no `instead of` trigger — the body `where` is a read-time filter, not a write-time invariant (same stance as view updateability). The *source* tables remain fully writable directly, and a source write propagates to the MV synchronously regardless of which boundary the write entered through.

## Maintenance (row-time, per-statement)

For each materialized view the manager caches a `MaintenancePlan`, indexed by every source base it reads (a single base for the single-source arms; both the driving and lookup base for the 1:1-join arm), and dispatches on its `kind`. Four arms are wired: `'inverse-projection'` (the covering-index shape), `'residual-recompute'` (single-source aggregates), `'prefix-delete'` (single-source lateral-TVF fan-out), and `'join-residual'` (1:1 inner/cross join). The union's `'full-rebuild'` arm is reserved for a future cost gate. The correctness oracle for these arms is the maintenance-equivalence property harness (`test/incremental/maintenance-equivalence.spec.ts`): for every eligible body shape it asserts `read(MV) == evaluate(body)` after each random source mutation and after rollback.

### `'inverse-projection'` (covering-index shape)

The per-row backing delta is a **pure projection of the changed row** — no body re-execution, no scan, no compiled residual. `project(r)` copies the passthrough columns and evaluates each deterministic-expression column against the single changed row (reusing the runtime, so the value matches `select <body>` exactly):

| source op | maintenance |
|---|---|
| insert `r` | if `predicate(r)` → upsert `project(r)` |
| delete `r` | if `predicate(r)` (was in scope) → delete the backing key of `project(r)` |
| update `old→new` | delete old image if in scope; upsert new image if in scope |

The update arm covers predicate-scope transitions and key-changing updates. This bounded O(log n) per-row cost (a btree delete + insert) — identical to the secondary-index maintenance a UNIQUE auto-index already performs — is why row-time is affordable for this shape and not for general bodies.

### `'residual-recompute'` (single-source aggregate shape)

When the body is a single-source aggregate (`group by` over bare columns) the per-row delta is not a projection but a **bounded, key-filtered re-execution** of the body. At create, the body is rewritten with `injectKeyFilter(body, T, groupColumns, 'gk')` (the shared residual primitive in `planner/analysis/key-filter.ts`, also used by the assertion evaluator) and compiled once into a cached scheduler. The plan carries a `BindingMode` of `{ kind: 'group'; groupColumns }`, built **directly from the aggregate's bare GROUP BY columns** — *not* via `extractBindings`, whose `'group'` classification additionally requires the group key to cover a *source* unique key (and so reports `'global'` for the common `group by <non-key>` body, which would route to the unwired rebuild/reject path).

Per source change the manager derives the affected group key(s) from the changed row, and for each:

| source op | affected group key(s) | maintenance |
|---|---|---|
| insert `r` | NEW group of `r` | delete the group's old backing row; run the residual bound to the key; upsert the recomputed group row |
| delete `r` | OLD group of `r` | delete; run residual (zero rows if emptied → no upsert) |
| update `old→new` | OLD ∪ NEW group (deduped) | per affected key: delete; run residual; upsert |

The residual runs against **live mid-transaction source state** (reads-own-writes, through the same emit → `Scheduler` path the assertion evaluator uses), so the recomputed slice is exactly what `select <body>` would return at that point. A group-key-changing UPDATE recomputes both the OLD and NEW groups; the always-delete-before-rerun discipline is what makes an **emptied group** correct — the residual returns zero rows, so the delete-without-upsert removes the stale backing row. Only the recomputed row(s) whose backing key equals the affected key are upserted (a soundness net that also discards a spurious empty-group row a constant-pinned multi-column grouped aggregate can produce under a known optimizer mis-collapse).

Per-row recompute is correct **without** per-statement batching: every change to a group recomputes it from live state, so the last change to touch a group writes the authoritative row. Batching/dedup of distinct affected keys across a whole statement (and a runtime `degradeToRebuild` cost gate) is an affordability optimization deferred with the statement-flush boundary — the per-statement batching in place is connection-resolution caching only, not op-buffering.

### `'prefix-delete'` (single-source lateral-TVF fan-out shape)

When the body fans a single base row out through a lateral table-valued function, one base row owns **N** backing rows that all share the **base-PK prefix** of the composite product key `(T.pk ∪ tvf-key)`. So this arm replaces a **prefix-keyed slice** (vs the point-keyed slice the residual-recompute arm replaces): the per-source-change delta is a **by-prefix delete** of the base row's whole fan-out plus a **re-fan residual**. It reuses the residual kernel of the aggregate arm unchanged — the affected-key derivation, the `injectKeyFilter` residual (pinned to the base `TableReferenceNode` with the **`'pk'`** prefix, compiled + cached once), reads-own-writes execution — and differs only in the prefix delete (vs a point key) and the **N-row** residual (vs ≤1).

| source op | affected base key(s) | maintenance |
|---|---|---|
| insert `r` | NEW base PK of `r` | delete-by-prefix (no-op, no prior slice); run the residual bound to the base key; upsert each fanned row |
| delete `r` | OLD base PK of `r` | delete-by-prefix the whole slice; run residual (zero rows, base row gone → no upsert) |
| update `old→new` | OLD ∪ NEW base PK (deduped) | per affected base key: delete-by-prefix; run residual; upsert each fanned row |

A base-PK-changing UPDATE moves the whole prefix — the OLD base key's slice is deleted (its residual returns nothing) and the NEW base key's fan-out is re-computed and upserted. The body's `WHERE`, if any, is part of the residual, so an out-of-scope base row fans out to zero rows (the delete-without-upsert removes its slice) — predicate-scope transitions need no separate predicate. The by-prefix delete is the `'delete-by-prefix'` `MaintenanceOp`: a range-scan of the backing primary btree over the half-open interval whose leading columns equal the base PK (the btree orders by the composite PK, base PK leading, so the slice is contiguous), `recordDelete`-ing each matched row with the same bookkeeping the point `delete-key` op uses.

### `'join-residual'` (1:1 inner/cross join shape)

A **1:1 row-preserving inner/cross join** (`select … from T join P on T.fk = P.id`) reuses the residual-recompute kernel with a `'row'`/`'pk'` binding on the driving table `T` whose PK keys the backing. The plan is **indexed under both source bases** (`rowTimeBySource[T]` *and* `rowTimeBySource[P]`); `maintainRowTime` passes the changed base to `applyMaintenancePlan`, which routes a `T` write to the **forward** path and a `P` write to the **reverse** path.

**Driving side (`T`) — the forward path.** Identical to a size-1 group in the aggregate arm, driven by the *same* `applyForwardResidual`: per changed `T` row, delete the old backing slice keyed on `T`'s PK, run the `T`-keyed residual (`… where T.pk = :pk0`, the body with `injectKeyFilter` applied on `T`) against live state, and upsert the recomputed row.

| source op | affected key(s) | maintenance |
|---|---|---|
| insert `r` | NEW `T.pk` of `r` | delete (no-op); run residual (the one joined row); upsert |
| delete `r` | OLD `T.pk` of `r` | delete; run residual (zero rows, `T` row gone → no upsert) |
| update `old→new` | OLD ∪ NEW `T.pk` (deduped) | per key: delete; run residual; upsert |

An FK-moving `UPDATE` (changing `T.fk`, not `T.pk`) recomputes the same `T.pk` slice against the new lookup row; a PK-changing `UPDATE` recomputes both the OLD and NEW `T.pk`.

**Lookup side (`P`) — the reverse path.** A write to `P` cannot be keyed on `T`'s PK (one `P` row joins many `T` rows), so the plan carries a **second residual keyed on `P`'s PK** (the body with `injectKeyFilter` applied on `P`). Per changed `P` key (OLD ∪ NEW, deduped) it runs `… where P.pk = :pk0` against live state — returning every currently-joined row, each carrying its `T.pk` backing key — and **upserts** each. **No delete is performed.**

| source op | affected key(s) | maintenance |
|---|---|---|
| insert `p` | NEW `P.pk` | run reverse residual (zero rows if no `T` references it → no-op) |
| delete `p` | OLD `P.pk` | run reverse residual (RI-admissible only when childless → zero rows) |
| update `old→new` | OLD ∪ NEW `P.pk` (deduped) | run reverse residual; upsert each joined row |

The upsert-only reverse path is sound because, for an inner/cross join with enforced RI and no lookup-referencing `WHERE`, the *set* of `T` rows joined to a given `P` row is `{ T : T.fk = P.pk }` — determined entirely by `T.fk` (a `T` column a `P` write cannot change). So a `P` change only re-derives the lookup-projected columns of existing backing rows (an upsert at the unchanged `T.pk`), never adds or removes one. A `T`-side membership change is the forward path's job; the two paths fire independently and, reading live state, converge under last-write-wins exactly as the other residual arms do.

The join soundness predicates (`proveOneToOneJoin` = the no-row-loss descent + `proveJoinNoFanout`) are **factored out of `coverage-prover.ts`** and shared by the base-table coverage prover and this MV gate, so the 1:1-join logic lives in one place.

### MV-over-MV cascade

A backing write is itself a row-write that every MV reading *that backing table* must see. After a plan maintains its backing, the manager looks up `rowTimeBySource[backingBase]`; when non-empty, each **effective** per-row backing change is routed back through `maintainRowTime`, recursively. `applyMaintenanceToLayer` returns the `BackingRowChange[]` it actually realized (a `delete-key` that found a row → `delete`; an `upsert` → `update` when it replaced an existing row, else `insert`), so the cascade needs no source re-read — the layer already knows each op's before-image.

Because a consumer MV can only be created once its producer exists (and an MV's sources are fixed at create), the dependency graph is **acyclic**. Synchronous depth-first recursion is therefore **DAG-ordered** — a producer's backing is fully written before its consumers run — and the whole chain commits/rolls-back atomically on the live transaction (a depth-≥2 backing connection registers lazily on its first cascade write, and `Database.registerConnection` replays the active savepoint stack onto it, including the statement-atomicity savepoint, so a rollback reverts every level in lockstep). A non-chained MV keeps today's cost exactly (one map lookup, no recursion) via the leaf fast path (`!rowTimeBySource.has(backingBase)`). A defense-in-depth depth guard (bounded by the count of registered row-time MVs) is the backstop for the structurally-impossible cycle.

**Reads-own-writes through the chain.** Cascade writes ride the same per-statement backing connection a `select`/enforcement scan resolves to, so a later same-statement source row's enforcement scan on a downstream covering MV's backing (`lookupCoveringConflicts`) observes every row the cascade already wrote this statement. There must be **no** deferred/end-of-statement flush on the cascade path that could hide an earlier row from a later enforcement read; each level applies synchronously, so flush order is trivially correct.

### Synchronous, transactional, per-statement

Maintenance is driven from the **runtime DML write boundary** (`runtime/emit/dml-executor.ts`), immediately after each source row is recorded (`_recordInsert/_recordUpdate/_recordDelete`), via `Database._maintainRowTimeCoveringStructures(sourceBase, change)`. A cheap synchronous guard (`_hasRowTimeCoveringStructures`) makes this a no-op fast path for tables no materialized view reads, so non-covered writes pay effectively nothing.

Maintenance is **amortized per statement without deferring visibility**. The DML generator owns a per-statement `BackingConnectionCache` (a `Map<backingBase, MemoryTableConnection>` created at generator entry): each covering MV's backing connection is resolved **once per (statement, backing)** — paying the scan over the Database's active connections (`getBackingConnection`) once for a bulk `insert`/`update`/`delete` instead of once per source row — and a multi-level cascade amortizes each level's backing too (the cache is keyed by backing base). Each row's ops are still applied **immediately** to that connection's pending layer (per-row apply on the *cached* connection), **not** buffered for an end-of-statement flush.

> **Enforcement-visibility invariant — do not "optimize" this into a correctness bug.** Covering-MV UNIQUE enforcement runs *inside* the source vtab's `update()` (`checkUniqueViaMaterializedView` → `Database._lookupCoveringConflicts`) and **scans the backing table**, relying on it reflecting *every prior row of the same statement*. Because the engine amortizes only the connection *resolution* and keeps **per-row apply**, a later same-statement row's enforcement scan always observes an earlier row's backing write — e.g. `insert into t values (1,'a'),(2,'a')` over a covering `unique(x)` detects the intra-statement duplicate. A true end-of-statement op-coalescing buffer would break this *unless* `lookupCoveringConflicts` unioned the not-yet-flushed buffer (or the buffer flushed before every enforcement read); the design deliberately avoids that hazard by not buffering.

Reads-own-writes therefore holds both **within** a statement (the enforcement scan above) and **between** statements within a transaction — without paying the per-row connection-resolution overhead on bulk DML. The cold enforcement/eviction paths (`lookupCoveringConflicts`, the memory/store REPLACE-eviction maintenance) omit the cache and re-resolve the *same* connection deterministically, so they observe and contribute to the same statement's backing state.

The backing write is routed through the **same `MemoryTableConnection` a `select` from the MV would use** in this transaction (obtained/registered lazily). The privileged write `MemoryTableManager.applyMaintenanceToLayer(connection, ops)` applies the ordered `delete-key` / `upsert` ops to that connection's **pending** `TransactionLayer`, bypassing `validateMutationPermissions` (backing tables are read-only to user DML) and reusing `recordUpsert`/`recordDelete` so secondary-index bookkeeping stays correct. Because the connection is in the Database's active set:

- a later read of the MV in the same transaction sees the pending writes **for free** (reads-own-writes);
- the pending layer is committed atomically by the existing coordinated commit (`database-transaction.ts`) and discarded by the existing rollback broadcast — so a rollback (or a failed source write inside the statement savepoint) reverts the backing delta in lockstep; and
- an autocommit `insert into T` rides the **statement-level** autocommit boundary, so source and backing commit together — no orphaned/uncommitted backing pending layer.

Because maintenance is part of the writing transaction and never re-reads the source, it cannot "diverge" from its sources between writes: there is no post-commit window and no asynchronous failure mode. A maintenance error fails (and rolls back) the source write itself.

`Database.watch` on a materialized view projects to the MV's **sources** (the backing table is maintained off the user change log) — see [Change-scope projection](#change-scope-projection).

## Schema-change staleness

Row-time maintenance keeps an MV consistent with its sources' *data*. But a *schema* change to a source (drop / alter) can break the body outright. The `MaterializedViewManager` subscribes to `table_removed` / `table_modified` change events and marks any MV whose `sourceTables` includes the changed table as **stale**.

Marking an MV stale also **detaches its row-time maintenance plan** (the compiled plan is invalidated by the schema change), so while stale the MV serves its last snapshot and source writes are not propagated.

- On the next **reference**, a stale MV re-validates its body against the current source schemas. If the body no longer plans, the reference errors with a staleness diagnostic ("a source changed in an incompatible way — drop and recreate") rather than serving rows against a broken definition. This guard runs at **build time** (in `building/select.ts`), so it only protects a freshly-planned reference; cached prepared-statement plans are forced back through it by the invalidation below.
- On the next successful **refresh** (or a drop-and-recreate), the stale flag is cleared, the backing snapshot is rebuilt, *and* the detached row-time plan is **re-registered** — so subsequent source writes resume propagating. (Re-registration is idempotent, so refreshing a never-stale MV is a harmless no-op re-attach.)

`stale` is the **only** MV read-state flag. (A `diverged` flag and a two-tier apply-failure recovery would exist only for an asynchronous on-commit model, which row-time replaces — transactional maintenance has nothing to diverge.)

**Cached-plan invalidation.** A `select … from mv` compiled while the MV is **not stale** resolves to a `TableReference` against the backing table `_mv_<name>`, so the compiled prepared statement's only schema dependency is the backing table — which the *source* change event never names. To keep that cached plan from re-running the backing scan and bypassing the build-time guard, the `MaterializedViewManager` emits a **synthetic `table_modified` event for the MV's backing table** on every qualifying source change. The statement's schema-dependency listener matches that event, drops its cached plan, and the next execution recompiles → re-hits the guard. The event names the backing table, so it cascades correctly down an MV-over-MV chain (acyclic — no infinite loop) and is a no-op for the manager's own source-tracking listener on a plain MV.

The emit fires per qualifying source change rather than only on the `stale` false→true transition. The unconditional firing is what re-propagates the cascade down an MV-over-MV chain; for the *single-level* compiled-while-stale case it is defensive redundancy — a plan compiled while the MV is already stale carries a **direct** dependency on the source table, so a later source change invalidates it through the ordinary dependency path even without the emit.

## Change-scope projection

A `select` from an MV resolves to a reference on its backing table, so `Statement.getChangeScope()` would naively report `_mv_<name>`. But the backing table is never written through the user change log — it is maintained at the row-write boundary from its sources — so a `Database.watch` on it would never fire. To fix this, the manager caches a **source-union change-scope** on the MV at registration (`MaterializedViewSchema.sourceScope`, a `full` watch per source via `buildSourceUnionScope`), and change-scope analysis substitutes it for the backing-table watch (see [change-scope.md](change-scope.md#materialized-view-reference-projection)). A `Database.watch` on such an MV therefore fires on a **source** mutation.

A precise per-source row/group scope, mirroring the maintenance projection the manager already derives, is a future refinement.

## Declarative-schema integration

Materialized views participate in the [declarative-schema](schema.md#declarative-schema) pipeline. A `declare schema { ... }` block accepts a `materialized view` item:

```sql
declare schema main {
  table t { id integer primary key, x integer not null }
  materialized view mv as select id, x from t
}
apply schema main;
```

- **DDL round-trip.** `apply schema` and schema export emit canonical `create materialized view ...` DDL via `ast-stringify`, so a schema survives `schema → DDL → parse → schema` with no shape change.
- **Body-change rebuild.** The differ keys rebuild detection on `bodyHash` (`toBase64Url(fnv1aHash(<canonical body SQL>))`, shared by MV creation and the differ). When a declared MV's body hash differs from the live MV's `bodyHash`, the differ schedules a **drop + recreate** (materialized views have no in-place `ALTER` primitive). The recreate re-materializes from current sources, in apply order — after source tables and views are created, before assertions. An unchanged body produces no create and no drop. Tags do not perturb the schema version (they are stripped before hashing).

## Covering structures

A UNIQUE constraint is *logical*; the structure that enforces it is *optional* and may take more than one physical shape. Quereus describes every such shape in one vocabulary — the **covering structure** — so the enforcement layer (and the lens layer above it) can pattern-match a single surface (`CoveringStructure` in `vtab/memory/layer/manager.ts`):

```
type CoveringStructure =
  | { kind: 'memory-index';      index: MemoryIndex }            // the auto-built secondary BTree
  | { kind: 'materialized-view'; view:  MaterializedViewSchema } // an explicit covering MV
```

> **The recommended response to a `lens.no-backing-index` advisory.** When the [lens prover](lens.md#constraint-attachment) classifies a logical `unique` / primary key as `enforced-set-level` with `mode: 'commit-time'`, it means no basis covering structure answers it, so enforcement falls back to the O(n) commit-time `DeltaExecutor` scan and warns. The fix is to declare an **explicit basis covering materialized view** (`order by` the constraint columns, projecting the UC columns + source PK — NULL-skipped via `where … is not null` for a nullable column) over the basis. The coverage prover then links it to the basis UC, `proveLens` resolves it via `_findRowTimeCoveringStructure`, and the obligation upgrades to `mode: 'row-time'` — O(log n) and conflict-resolution-capable (`insert or replace` / `or ignore`), which the commit-time scan cannot offer. In the logical-schema world (where the auto-index is retired) this covering MV is the *sole* row-time structure.

### Implicit covering structures (the auto-index, reframed)

Every declared UNIQUE constraint auto-builds a synchronously-maintained secondary BTree for efficient enforcement (`ensureUniqueConstraintIndexes`). That BTree is reframed as an **implicit covering structure** (`origin: 'implicit-from-unique-constraint'` in the materialized-view vocabulary), held as a lightweight association on the memory-table manager — it is *not* registered as a `MaterializedViewSchema`; the BTree is the structure. Row-time enforcement (`findIndexForConstraint`) returns this `memory-index` variant. The physical structure is unchanged from before the reframe.

Implicit covering structures are a backing detail and are **hidden from `collectSchemaCatalog` / schema export by default**, surfaced only when the originating constraint carries the tag `quereus.expose_implicit_index = true`.

### Explicit covering structures (the coverage prover)

A user-declared materialized view can *cover* a UNIQUE constraint. The **coverage prover** (`planner/analysis/coverage-prover.ts`) recognizes the canonical covering shape and records the link eagerly at MV-creation time. For

```sql
create table t (id integer primary key, x integer not null, y integer not null, unique (x, y));
create materialized view ix_t_xy as select x, y, id from t order by x, y;   -- covers unique(x,y)
```

the prover proves `ix_t_xy` covers `unique(x, y)` and stamps the link (see [Schema § Covering-structure links](schema.md#covering-structure-links)).

Recognition is narrow and conservative — every check forgoes an optimization on doubt; a false *NotCovers* only forgoes an optimization, a false *Covers* would be unsound:

- **Shape.** The optimized body walks down to a single constrained base table `T` (`TableReference → optional Filter/Alias → Project → optional Sort`; physical access nodes are transparent). A **binary join** is admitted when `T` provably contributes *exactly one* MV row per governed `T` row (see the join decomposition below). Aggregation, `DISTINCT`, set operations, `FanOutLookupJoin`, `AsofScan`, or a `LIMIT`/`OFFSET` row cap ⇒ not covering.
- **Join (1:1) decomposition.** "Exactly one MV row per governed `T` row" splits into two independent obligations:
    - *No row loss (≥1):* proven during the plan walk, two ways: **(a) row preservation** — `T` on the row-**preserving** side of the join (a `left` join with `T` in the left subtree, or a `right` join with `T` in the right subtree); or **(b) referential integrity** — an `inner`/`cross` join whose equi-pairs witness an inclusion dependency from the `T`-side relation to the lookup table's **primary key**, over a lookup side that exposes the parent's *full* row set, so enforced RI makes the join 1:1 (`innerJoinRetainsConstrainedTable`). Obligation (b) is **IND-derived**: it first consults the propagated `PhysicalProperties.inds` surface on the `T`-side subtree (`indDerivedNoRowLoss`) and falls back to the structural NOT-NULL-FK-on-`T` check (`lookupCoveringFK` + `!match.nullable`). Both gate on the same preconditions, so they agree on every single-FK shape; the IND path additionally proves no-row-loss across **multi-hop FK chains** (`T → M → P`), where the threaded IND `M.cols ⊆ P.pk` — carried onto the `T ⋈ M` sub-frame by join propagation — discharges the outer `⋈ P` join that a single `lookupCoveringFK(T, P, …)` call cannot see. Both lean on the same NOT-NULL-FK + full-parent-row-set inclusion-dependency trust `rule-join-elimination`'s INNER branch uses, so this adds no assumption the optimizer doesn't already make. An `inner`/`cross` join *without* a covering NOT-NULL FK/IND, `semi`/`anti`, `full`, and `T` on the dropping side are rejected as *shape*. (FDs encode uniqueness, not existence, so obligation (a) is a structural plan-walk check; (b) is discharged from the propagated IND surface with the structural FK-schema read as fallback.)
    - *No fan-out (≤1):* `T`'s primary key must be a unique key of the **topmost join's output relation** (read via `isUnique`). The optimizer emits `T.pk → all_join_cols` into the join's FDs exactly when the equi-pairs cover a unique key of the lookup side; the moment the lookup side can multiply a `T` row, no such FD is emitted and the gate fails (`fanout`). The check is against the *join* frame, not the projected body root. When the optimizer instead *eliminates* a key-preserving join (FK→PK aligned, lookup unprojected — see `rule-join-elimination`), the body collapses to a single-source chain and the single-source path covers it directly.
- **Projection.** The output must include every UC column **and** every primary-key column of `T` (the PK identifies the source row for conflict resolution).
- **Ordering.** The body's `order by` columns must be a permutation of the UC columns. A missing `order by` does not cover. (Ordering and the WHERE predicate are read from the **body AST**, not the optimized plan, because the optimizer drops the `Sort` and absorbs a `WHERE` into an index range seek.)
- **Predicate alignment.** The body's materialized row set must equal the set the constraint governs: the WHERE predicate must entail `uc.predicate` (for partial UNIQUE) and an `is not null` per nullable UC column (NULL-skip), and must add no restriction beyond that. Entailment reuses the partial-UNIQUE clause vocabulary — see [Optimizer § Coverage proving](optimizer.md#coverage-proving).

Multi-source 1:1 join bodies are covered: outer-join row preservation, and `inner`/`cross` lookup joins on an enforced NOT-NULL FK→PK (the no-row-loss obligation closed by referential integrity). That no-row-loss obligation is IND-derived — it discharges from the propagated `PhysicalProperties.inds` surface first (structural NOT-NULL-FK fallback retained), which additionally covers **multi-hop FK chains** (`T → M → P`) whose threaded IND a single `lookupCoveringFK` call cannot see. The AST `ORDER BY` / `WHERE` column resolution is **qualifier-aware**: `alias.col` resolves to a `T` column only when `alias` denotes `T`'s reference (and a bare `col` only when unambiguous across the join's sources), so a 1:1 join whose lookup key reuses a UC column name covers — a term on a lookup column instead fails on its own terms (`ordering-mismatch` / `predicate-entailment`). Full-outer covering stays deferred (it injects lookup-only rows with no governed `T` row).

### Enforcement through a covering MV

Row-time UNIQUE enforcement (the in-place substitution of `insert or replace`, the skip of `insert or ignore`, the conflict diagnostic of the default `abort`) requires the covering structure to be consistent *at the moment of the write*. A covering materialized view's backing table is maintained **synchronously with each source row-write** (row-time), so it is consistent mid-statement — the same property the auto-index has — and is therefore eligible to answer conflict resolution.

`findIndexForConstraint` resolves it via `Database._findRowTimeCoveringStructure(schema, table, uc)` — a synchronous map lookup keyed on the constraint's `coveringStructureName` forward pointer, gated on a live covering plan that is not `stale` (structural breakage), with an O(1) negative fast path off `rowTimeBySource` so a non-covered table pays effectively nothing — and returns the `materialized-view` covering variant **in preference to** the `memory-index` auto-index. `checkSingleUniqueConstraint`'s `materialized-view` arm then point-looks-up the covering MV's backing table (`Database._lookupCoveringConflicts`, reads-own-writes through the backing's coordinated connection) and recovers each conflicting **source** PK from the MV projection so REPLACE / IGNORE / ABORT resolve against the correct source row.

The conflict check is a **backing-PK prefix scan** (O(log n + matches)), not a full backing scan. The body's `order by` columns are a permutation of the UC columns (the coverage prover's Ordering rule) and they seed the leading backing-PK columns (`computeBackingPrimaryKey`), so the leading `k = uc.columns.length` backing-PK columns are exactly the UC columns. `lookupCoveringConflicts` (`tryBuildCoveringPrefix`) builds the equality prefix in **backing-PK column order** (keyed `prefix[i] = newRow[sourceCol(backingPkDefinition[i])]`, so a permuting `order by` still seeks to the right block), and `scanLayer`'s `equalityPrefix` seek early-terminates when the leading columns stop matching. The fast path is taken only when the leading `k` backing-PK columns map to exactly the UC source-column set **and** every leading column (backing PK *and* its source UC column) is **BINARY**-collated; otherwise it falls back to the full layer scan. The collation gate is a *soundness* requirement, not a perf choice: the prefix seek's early-termination and `planAppliesToKey` compare with plain `compareSqlValues` (binary), while the backing btree orders by the declared collation and the UNIQUE constraint conflicts by the source collation — under a non-binary collation a binary `break` could skip a collated-equal / binary-different conflict. The full-scan fallback re-compares with the source collation, so it stays collation-correct. DESC-leading prefixes use the fast path (equality on a column makes its direction irrelevant to grouping; the seek + ascending walk lands at the group start either way). Either path yields only *candidates*; the caller validates each against the live source row.

**The preference tradeoff.** With a linked covering MV present, the covering MV — not the auto-index — answers conflict resolution. The auto-index remains maintained but *unconsulted* (a redundant read-answering copy). For *physical* schemas this makes the MV path live and testable (the auto-index always exists, so the MV path is otherwise unreachable); it becomes the *sole* enforcement structure in the **logical-schema** world (the lens layer), where the auto-index is retired. The MV outranking the auto-index for physical schemas is defensible because the backing-PK prefix scan makes the MV's UNIQUE check O(log n + matches) — the same asymptotics as the auto-index probe — so a former O(n) backing scan (an O(n²) bulk-insert regression) is gone. The residual cost is a bounded constant factor (backing-connection resolution, amortized per statement via `BackingConnectionCache` on the maintenance path and re-resolved deterministically on the cold enforcement path; plus per-candidate live-source validation) plus the maintained-but-unconsulted auto-index. Keeping the MV in preference avoids a tuning flag and keeps the MV enforcement path exercised on physical schemas — identical to the sole enforcement path the lens world uses.

**The eviction-maintenance edge.** A REPLACE evicts the conflicting **source** row directly on the source storage (memory transaction layer / store delete), which *bypasses* the DML-executor row-time maintenance hook (it fires only for DML-executor row writes, not for evictions internal to a vtab's update). Rather than each substrate re-driving a slice of the pipeline itself, the eviction is **reported** to the executor via `UpdateResult.evictedRows`: the substrate only *detects and deletes* the evicted source row, then surfaces it, and the executor runs the **same** post-write delete pipeline it runs for an ordinary delete — including `maintainRowTimeStructures({ op:'delete', oldRow })`, which removes the evicted row's backing entry within the same statement (otherwise that entry would go stale and produce a phantom conflict for a later same-UC row). The executor processes a write's `evictedRows` *before* that write's own bookkeeping (evict-then-write), so the backing delete still lands mid-statement. Symmetrically, the conflict path validates every backing candidate against the *live* source row before acting, so a stale candidate is skipped rather than raised as a false conflict. Maintenance and cascades thus live solely in the executor (DRY); detection stays substrate-local.

**Store-module parity.** `store-table.ts` routes UNIQUE conflict resolution through the same `_findRowTimeCoveringStructure` / `_lookupCoveringConflicts` surface (the backing table is always the memory module, queried through the db), validating candidates against the live store row (committed + this transaction's pending overlay). The constraint's `coveringStructureName` forward pointer is set by the eager prove-and-link on the *schema-manager's* constraint; a store table holds a copied schema whose constraint never received that mutation, so the resolver falls back to the authoritative schema-manager constraint matched by column set (`resolveCoveringStructureName`). The **isolation-wrapped** store path (`createIsolatedStoreModule`, exercised by `yarn test:store`) enforces UNIQUE via its own merged-view detection rather than the covering MV — but it needs no covering-MV routing to keep the backing consistent: its REPLACE evictions are reported via `UpdateResult.evictedRows`, and the executor's eviction pipeline maintains the backing uniformly across memory, direct store, and isolation alike. The backing consistency is obtained structurally (report the eviction, let the one pipeline maintain it) rather than by re-pasting covering-MV detection into the isolation layer.

**FD-derived "body proves it" is a different proof.** Separate from base-table covering, `coverage-prover.ts` exposes `proveEffectiveKeyUnique`, which proves the body's *own output relation* is unique on a set of output columns via its effective key (FD closure) — e.g. a `group by x, y` body is intrinsically one row per `(x, y)`. This is the obligation primitive the lens layer's `obligation: proved` class consumes; it is a proof about the **derived (output) relation**, **not** a base-table covering structure, and is deliberately kept out of `proveCoverage` because an FD-derived output key masks base-row duplicates. See [Optimizer § Effective-key proving](optimizer.md#effective-key-proving-body-proves-it) and [Lenses § the constraint-role split](lens.md).

## Current limitations

The following extensions build on this substrate but are not yet realized:

- **Row-time general bodies.** The remaining join shapes are rejected: a **fanning keyed join** (a non-1:1 inner/cross join — the natural next consumer of the prefix-delete by-prefix machinery, the join standing in for the TVF fan-out), an **outer** 1:1 join, and a **partial-`WHERE`** join body. A scalar aggregate with **no** `GROUP BY` (one global row) is also deferred. A possible **unified maintenance substrate** spike would fold the row-time inverse-projection path and the post-commit `DeltaExecutor` binding kernel under one `MaintenancePlan` abstraction with a backward (maintenance-direction) cost gate; the general-bodies item retargets onto that abstraction if it lands.
- **Statement-level op-coalescing.** The per-statement batching in place is connection-resolution caching only; a true op-buffering flush boundary (with the cost gate's `degradeToRebuild`) is deferred — and would require `lookupCoveringConflicts` to union the buffer to preserve the enforcement-visibility invariant.
- **Concurrent refresh** — overlapping refreshes and refresh-while-read beyond the current atomic base-layer swap.
- **MV-over-MV write-through** — DML against an MV whose source is *itself* an MV (routing one level down to the inner MV's own write-through) is rejected today.
- **Backing-module pluggability** — honor `USING <module>(...)` so the stored relation can live in a module other than the in-memory table.
- **Non-binary covering MV prefix scan** — thread per-column collation into `ScanPlan.equalityPrefix` matching (`plan-filter.ts` / `scan-layer.ts`) so non-binary covering MVs also use the prefix scan instead of the full-scan fallback.
- **Precise change-scope projection** — a per-source row/group `Database.watch` scope mirroring the maintenance projection, rather than the current `full`-per-source union.
- **Lens / layered schemas** — indexes and set-level constraint enforcement expressed as covering materialized views in the basis layer. See [Lenses and Layered Schemas](lens.md).
