# Incremental Maintenance

Quereus exposes a single, reusable **change-driven delta kernel** that runs at
transaction boundaries. Given the rows a transaction changed, it decides — per
registered consumer — what slice to recompute, how to bind it, and when to fall
back to a full re-evaluation. This document is the **definitive description of the
kernel** and its plug-in contract; the optimizer-side *analysis* that feeds it
(`analyzeRowSpecific` / `extractBindings`) is detailed in
[Optimizer § Binding-aware Delta Planning](optimizer.md#binding-aware-delta-planning-reusable),
and the public projection of that analysis is the
[`ChangeScope` data contract](change-scope.md).

Two consumers are **live** today:

- **Assertions** — a `CREATE ASSERTION` predicate re-checked at COMMIT against only
  the rows that changed (pre-commit; a violation rolls the COMMIT back).
- **`Database.watch`** — reactive callbacks fired post-commit when matching rows
  change (fire-and-forget; a throwing handler is logged, never fatal).

Engineered to plug in next on the same surface: reactive signals and triggers, and
the [lens layer](lens.md)'s set-level constraint maintenance/enforcement where no
covering structure answers it.

> **Materialized views are *not* a kernel consumer.** An earlier design maintained
> `on-commit-incremental` materialized views through this post-commit kernel.
> Materialized views are now **row-time only**: their backing tables are maintained
> synchronously at the DML write boundary, inside the writing transaction, by a
> bounded per-row projection — not by this post-commit delta path. See
> [Materialized Views](materialized-views.md). Materialized views still use
> *change-scope* analysis for `Database.watch` source projection (the cached
> `sourceScope`); they just do not ride the delta-execution kernel.
>
> A design-spike (`incremental-maintenance-substrate-spike`) is reconsidering whether
> this kernel and the row-time MV maintenance path should converge on one shared
> `MaintenancePlan` abstraction plus a backward (maintenance-direction) cost gate —
> and whether a Z-set / DBSP-style delta circuit is worth adopting for harder body
> shapes. The synchronous, in-transaction *application policy* for materialized views
> is **not** in question; only the shared representation and cost model are. No outcome
> is assumed here until the spike lands.
>
> **MV-over-MV cascade.** A materialized view whose source is another MV's backing table
> is maintained synchronously in the same row-time pass, *not* through this kernel. A
> backing write is itself a row-write, so each MV's per-row maintenance reports the
> **effective** backing changes it applied (`applyRowTimeChange` → the layer's
> `applyMaintenanceToLayer` returns a `BackingRowChange[]`), and the manager routes
> those onward to any MV reading that backing — `maintainRowTime` recurses, DAG-ordered
> and atomic within the statement. This path is *arm-agnostic*: it routes whatever
> per-row backing delta a maintenance plan produces, so a chain may mix maintenance arms
> uniformly. (When the substrate spike lands and folds `applyRowTimeChange` into a shared
> `applyMaintenancePlan`, the cascade flow is unchanged: `applyMaintenancePlan` →
> `applyMaintenanceToLayer` → `BackingRowChange[]` → `maintainRowTime`.)

## Pipeline at a glance

```
DML emitter ──recordInsert/Update/Delete(row, pkIndices)──► TransactionManager
                                                              │
                                                  per-base capture demand
                                                  registered by consumers
                                                              ▼
                                                       ChangeCapture
                                                  (PK + projected cols,
                                                   savepoint-layered)
                                                              │
                                          at top-level COMMIT (phase per consumer:
                                           assertions pre-commit, watch post-commit)
                                                              ▼
                                                       DeltaExecutor
                                                              │
                                        ┌─────────────────────┴─────────────────────┐
                                        ▼                                           ▼
                              AssertionEvaluator                          Database.watch
                              (residual scheduler per                     (post-commit
                               tuple, pre-commit,                          reactive signals)
                               early-exit on violation)
```

The kernel is decoupled from any specific consumer. A `DeltaSubscription` carries:

- `dependencies` — the set of base tables the subscription cares about.
- `bindings` — a `BindingMode` per `TableReferenceNode` instance (from
  `extractBindings`, or built directly by the consumer).
- `apply(input)` — invoked at COMMIT with per-relation binding-tuple batches and a
  set of relations flagged for global re-evaluation.

## Lifecycle

### Registering capture demand

A consumer that needs non-PK column values calls
`Database.registerCaptureSpec(baseTable, { extraColumns })` (typically at
plan-compile / DDL time). PK columns are always retained; `extraColumns` is the
union of non-PK columns any active spec needs. The returned dispose handle removes
that spec from the union; capture demand for a table is fully released once all
specs are disposed.

A `'row'` binding whose chosen key is the table's primary key needs no extra
capture — PK is always present. A `'row'` binding picked from a covered non-PK
unique key (and any `'group'` binding) registers the non-PK columns it cares about
so the values needed to bind at COMMIT are preserved. The shared merge state
machine in `TransactionManager` keeps the earliest `oldProjection` for the row
across both intra-layer activity and savepoint RELEASE — per-group dispatch always
sees a row's pre-transaction state, even after a chain of updates inside savepoints.

### Recording changes

The DML emitter passes the full pre- and post-image rows plus PK indices to
`TransactionManager.recordInsert/Update/Delete`. The manager:

- Always retains the PK projection.
- Retains the registered `extraColumns` projection if any consumer has demand on
  that table.
- For UPDATEs, retains both OLD and NEW projections when any captured column changed
  value — making group-membership transitions visible to per-group dispatch.

The change log is layered for savepoints: SAVEPOINT pushes a new layer, ROLLBACK TO
discards the top layer, RELEASE merges with last-write-wins (delete-after-insert
collapses to no entry, insert-then-update keeps INSERT semantics with the refreshed
projection, etc.). So changes rolled back via a savepoint are never visible to
COMMIT-time evaluation.

### Reading changes at COMMIT

`DeltaExecutor` iterates registered subscriptions, computes the per-relation binding
tuples via `getChangedTuples(base, columnIndices, pkIndices)`, and calls each
subscription's `apply`. **Cost fallback:** if the number of distinct binding tuples
exceeds `tuning.deltaPerRowFallbackRatio × estimatedRows(base)`, the kernel demotes
that relation to global re-evaluation (always correct — it just recomputes more than
the minimum).

The kernel runs only at top-level COMMIT — savepoints are seen indirectly via the
merged change log. How an `apply` exception is handled is the **consumer's** choice,
not the kernel's: the kernel surfaces it unchanged. The assertion consumer registers
on the pre-commit path, so a thrown violation propagates and rolls the COMMIT back;
the `Database.watch` consumer runs *after* commit and swallows handler errors
(logged, never fatal) — the transaction has already durably committed by then.

## BindingMode

`extractBindings(plan)` walks a plan and emits a `PlanBindings` describing, per
`TableReferenceNode` instance, how the plan binds to changes on its underlying base
table (full analysis in
[Optimizer § Binding-aware Delta Planning](optimizer.md#binding-aware-delta-planning-reusable)):

```ts
type BindingMode =
  | { kind: 'global' }
  | { kind: 'row'; keyColumns: number[] }      // output-column indices
  | { kind: 'group'; groupColumns: number[] }; // output-column indices
```

- `'row'` picks the table's primary key when it's among the covered keys, else the
  lex-min covered key (by length then joined indices). Candidate keys come from the
  unified `keysOf` surface (`planner/util/fd-utils.ts`) — declared
  `RelationType.keys`, FD-derived keys, the `∅ → all_cols` ≤1-row empty key `[]`,
  and the all-columns set key.
  - An **empty `keyColumns`** (`{ kind: 'row'; keyColumns: [] }`) means "≤1 row, no
    key filter needed". Downstream consumers treat it as a sound full/global scan:
    the delta executor re-evaluates that relation globally, `change-scope` reports a
    `full` watch scope, and the assertion residual leaves the `TableReferenceNode`
    unwrapped. All three are equivalent for a ≤1-row table.
- `'group'` reads the minimal `GROUP BY` column subset from
  `analyzeRowSpecific.groupKeys`. It already lives in the table reference's
  output-column space.
- `'global'` means the kernel has no safe binding to parameterize on; the consumer
  evaluates its full plan once when any dependency changes.

## First consumer: AssertionEvaluator

On first reference to an assertion at COMMIT time:

1. Parse and optimize the violation SQL for analysis (pre-physical).
2. Run `extractBindings` to get `PlanBindings`.
3. Register projection capture for the union of group-key columns per base table
   (`'row'` bindings need no extra capture).
4. For each `'row'`/`'group'` binding, inject a key-equality filter on the
   `TableReferenceNode` (`injectKeyFilter`) and pre-compile the residual scheduler.
   Parameter prefix is `pk` for row bindings, `gk` for group. Per-column NULL safety:
   each nullable key column emits the NULL-safe form
   (`(col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i`) so a changed
   NULL-keyed tuple is re-evaluated rather than silently skipped; NOT NULL columns
   keep the plain `col = :prefix_i` form to avoid disjunctive predicates on the hot
   path.
5. Register a `DeltaSubscription` whose `apply`:
   - For each per-relation tuple batch, runs the cached residual scheduler once per
     tuple (early-exiting on the first violating row).
   - For any `globalRelations` entry, runs the full violation SQL once.

`DROP ASSERTION` or schema changes invalidate the cached entry — dispatch handle,
capture demand, and residual schedulers.

## Second consumer: Database.watch

`Database.watch(scope, handler)` registers a post-commit reactive callback against a
public, JSON-serializable `ChangeScope` (see
[Change-scope Documentation](change-scope.md)). The watcher manager
(`src/core/database-watchers.ts`) owns its own `DeltaExecutor` and is the reference
example of the plug-in pattern below:

- `subscriptionFromChangeScope` (in `delta-executor.ts`) translates the public
  `ChangeScope` into a `DeltaSubscription`, mapping each watch to a `BindingMode`
  (`full` → `global`, `rows`/`rowsByGroup` → `row`/`group` with literal-value
  narrowing, `groups` → `group`) and registering capture demand for any non-PK
  key/group columns.
- The manager runs its executor **after** commit, so a throwing handler is logged
  and dropped rather than rolling anything back.
- Schema changes (`table_removed` / `table_modified`) invalidate affected
  subscriptions; `unsubscribe()` releases the kernel registration and all
  capture-spec demand.

Watchers prove the kernel is genuinely consumer-neutral: same binding extraction,
same capture demand, same cost fallback — only the commit-phase placement and error
policy differ from assertions.

## Plug-in pattern for future consumers

A new consumer follows the same shape — `Database.watch` is the live template, and
it surfaces its registration path on `Database`:

```ts
// 1. Analyze the consumer's plan.
const bindings = extractBindings(plan);

// 2. Register projection capture demand for non-PK columns.
const disposers: Array<() => void> = [];
for (const [relKey, mode] of bindings.perRelation) {
  if (mode.kind === 'group') {
    const base = bindings.relationToBase.get(relKey)!;
    disposers.push(db.registerCaptureSpec(base, {
      extraColumns: new Set(mode.groupColumns),
    }));
  }
}

// 3. Build a residual scheduler per binding via injectKeyFilter.

// 4. Register a DeltaSubscription with the kernel.
const dispose = deltaExecutor.register({
  id: 'signal:my_signal',
  dependencies: /* set of base tables in plan */,
  bindings: bindings.perRelation,
  relationToBase: bindings.relationToBase,
  pkIndicesByBase: /* PK indices per base table */,
  async apply(input) {
    // Per-relation: bind tuples, run the residual, act on results.
    for (const [relKey, tuples] of input.perRelationTuples) { /* ... */ }
    // Global: re-run the full plan once.
    if (input.globalRelations.size > 0) { /* ... */ }
  },
  dispose() { for (const d of disposers) d(); },
});
```

### Design decisions worth knowing

- **Projection capture, not full-row capture.** Workloads without any active
  consumer pay only PK capture. Adding a consumer mid-transaction can't see
  retroactive projections — mid-transaction subscription registration is forbidden
  (today's consumers register at plan-compile / DDL time, not at run time).
- **Per-subscription residual cache.** Plan-shape generation is consumer-specific
  (violation-query SQL vs. a watch residual). A shared cache would have to negotiate
  eviction.
- **Cost fallback by ratio.** The current threshold (`0.5`) is a first cut; a real
  cost comparator is a follow-up.

## Cross-references

- Analysis surface ("what to bind"): [Optimizer § Binding-aware Delta Planning](optimizer.md#binding-aware-delta-planning-reusable)
- Public reactive API / `ChangeScope`: [Change-scope Documentation](change-scope.md)
- Synchronous (off-kernel) materialization: [Materialized Views](materialized-views.md)
- Layered schemas / lenses: [Lenses and Layered Schemas](lens.md)
- Source: `src/planner/analysis/binding-extractor.ts`,
  `src/planner/analysis/key-filter.ts`, `src/runtime/delta-executor.ts`,
  `src/core/database-transaction.ts`, `src/core/database-assertions.ts`,
  `src/core/database-watchers.ts`
- Cross-process reactive transport: out of scope here; see the sync packages under
  `packages/quereus-sync-*`.
