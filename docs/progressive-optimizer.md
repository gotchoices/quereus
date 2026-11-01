# Progressive Query Optimization

This document describes how Quereus improves plans from what execution reveals, without depending on collected statistics. It assumes familiarity with [Optimizer](optimizer.md) (pass framework, rules), [Optimizer Cost and Statistics](optimizer-costing.md) (cost model, `StatsProvider`, base-table row estimates) and [Runtime](runtime.md) (emission, scheduler, streaming execution).

Quereus targets deployments where table storage may sit behind a network — a distributed hash table, a remote store — so every read is expensive and a full scan run only to collect statistics is often unaffordable. The optimizer must produce good plans with zero collected statistics, and improve them using numbers that *essential* execution produces anyway. Statistics are hints that improve a good plan, never prerequisites without which the plan is bad.

**Status.** Every section describes settled design and current code. Section 3, *cardinality feedback*, is complete and on by default (the `cardinality_feedback` option); section 5 lists the work queued next and what is deliberately left for later.

---

## 1. Design principles

| Principle | Implication |
|---|---|
| **Stats are hints, not prerequisites** | Missing statistics degrade to defaults, never to a bad plan shape by construction; an unknown row count is spelled `undefined` and never disguised as a measurement. |
| **Never block on optimization** | Planning performs no I/O: it reads the in-memory catalog and asks modules for synchronous access-plan quotes. Feedback only ever changes the *next* plan. |
| **Learn from essential execution** | Observations piggyback on work a query already does. Nothing issues a query, a scan or a module call just to learn something. |
| **No new pipeline breakers** | Instrumentation is a counter in a loop that already touches every row. It never buffers, reorders or materializes rows. |
| **Converge, don't thrash** | A plan changes only on consequential, verified evidence: a complete count, far enough from what the plan assumed, with hysteresis and a per-statement cooldown. |
| **Session-scoped, bounded state** | Observations live in memory per `Database`, capped and evicted, and are never persisted; durable statistics remain `ANALYZE`'s job. |

---

## 2. What the engine already does

The feedback design in section 3 builds on these existing pieces; none of them is new work.

- **Plan cache per statement.** A prepared `Statement` keeps its optimized plan, emission context and scheduler, and drops all three together in `Statement.invalidatePlan()` (`core/statement.ts`). Hard invalidation is a schema-change listener registered in `Statement.compile()` over the dependencies the builder recorded (`BuildTimeDependencyTracker`, `planner/planning-context.ts`); a schema event naming one of them invalidates the plan, which is rebuilt from the retained AST on next use. `db.get` / `db.eval` / `db.exec` prepare (or plan) afresh on every call.
- **Catalog statistics.** `CatalogStatsProvider` (`planner/stats/catalog-stats.ts`) reads `TableSchema.statistics` — row count, per-column distinct and null counts, min/max, equi-height histograms, collected by `ANALYZE` — and falls back to `NaiveStatsProvider` (1000 rows, flat selectivities). Base-table row counts go through one seam, `plannedRowCount` (`planner/stats/table-cardinality.ts`), read by both `TableReferenceNode.estimatedRows` and `CatalogStatsProvider.tableRows`, so scan cardinality and selectivity denominators cannot disagree; it ranks the table's module's own count and the observed row-count overlay (3.2) against the catalog (3.3). See [Optimizer Cost and Statistics](optimizer-costing.md#statistics-abstraction).
- **Auto-analyze.** `AutoAnalyzeManager` (`core/database-auto-analyze.ts`, on by default) counts rows changed by committed transactions and, past `max(500, 20%)` of the known size, runs `ANALYZE` for that table in the background — skipping tables above `auto_analyze_row_limit` (100,000). `ANALYZE` swaps the table's `TableSchema` and fires `table_modified`, which invalidates every cached plan reading that table. So local tables that this session writes already get fresh catalog statistics without anyone typing `ANALYZE`.
- **Module-reported sizes.** A module that keeps its own count in memory reports it through the synchronous, I/O-free `VirtualTableModule.getRowCount` hook, which `plannedRowCount` consults first (3.3); `StoreModule` reports its running count as exact, and `IsolationModule` forwards it. `rule-select-access-path` hands the planned row count to `getBestAccessPlan` as `request.estimatedRows` (`undefined` when unknown), so the access path is priced against the same size as the plan around it. `VirtualTable.getStatistics()` is still called only by `ANALYZE`.
- **Work counters (diagnostic only).** With `runtime_metrics` on, each execution feeds a `WorkCounterCollector` (`runtime/work-counters.ts`): per-instruction executions and rows, per-table `query()` calls and rows scanned, keyed by structural program address. Metrics mode wraps every streaming output in a counting generator and times every instruction, which is why it is a debugging and benchmarking instrument and not the feedback channel. See [Runtime Work Counters](runtime-work-counters.md).

The gap these leave: a table this session has not written and whose module reports no size — opened from storage with data and no saved statistics, served by a remote module, larger than the auto-analyze limit, or in a session with `auto_analyze` off — is planned at the 1000-row default (or at an `ANALYZE` snapshot that has since drifted) for as long as the session lives, even after a query has read every one of its rows.

---

## 3. Cardinality feedback

When a query happens to read an entire table, the engine now knows that table's exact size for free. Cardinality feedback records that count, lets later plans use it in place of a default or an outdated `ANALYZE` snapshot, and re-plans cached statements whose plans were costed against a number that turned out to be far off.

Measured on the in-memory backend (one machine, a 20,000-row table `big` and a 300-row table `mid`, never analyzed): `select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1` plans as a hash join over a full scan of `big` and runs in 16.6 ms. With only `big`'s row count known — no column statistics — the same statement plans as a nested-loop join seeking `big` by primary key and runs in 1.76 ms. The full scan in the first plan is exactly the observation that produces the second.

### 3.1 What is observed

One observation kind: the **exact row count of a base table**, taken at the scan leaf (`emitSeqScan`, `runtime/emit/scan.ts` — the one door for `SeqScan`, `IndexScan` and `IndexSeek`). A scan site qualifies when, decided at emit time:

- it is a `SeqScanNode` or `IndexScanNode` (never an `IndexSeekNode`);
- its `FilterInfo` carries no constraints, no `limit` / `offset`, and the emitter received no runtime `FilterInfo` override (an `OrdinalSlice` pushdown);
- its access path is `fullScan`, or the **primary** index (`role: 'primary'`) walked with plan `scan`. A secondary index walk is excluded — a partial index enumerates only the rows its predicate admits.

and the invocation's row loop then ran to **natural exhaustion**. A scan stopped early — by a `LIMIT` above it, `Statement.get()` taking one row, an `EXISTS` short-circuit, an abort or an error — observes nothing, because a partial count is not a table size. Re-scans (a nested-loop inner) and self-joins observe the same table repeatedly; the last count wins within one execution.

Per-execution observations collect in a sink on the `RuntimeContext` (fork policy `shared-sink`, like `workCounters`, so forked parallel branches report into the parent's sink), created only when the `cardinality_feedback` option is on. The run sites that create it are `Statement._iterateRowsRawInternal` and `Database._executeSingleStatement`. The hand-built contexts — deferred row constraints, assertion delta plans, materialized-view analysis and apply, constant folding — do not, exactly as they carry no work counters. Internal work that runs SQL through a prepared `Statement` (assertion violation queries, foreign-key actions, constraint checks on `ALTER`, a materialized view's initial fill, auto-analyze's `analyze`) does get a sink, and publication's transaction rule (3.5) governs it like any other execution; what runs inside a transaction (commit-time assertions, actions of a writing statement) is held with that transaction, and what runs outside one read committed state.

Intermediate cardinalities — filter output, join output, sort or aggregate input — are not observed in this design. Their meaning depends on the plan that produced them, so there is no key under which they stay valid across a re-plan; see section 5.

### 3.2 The observed row-count overlay

A `Database` owns one overlay (`CardinalityFeedbackManager`, `core/database-cardinality-feedback.ts`): a map from lowercased `<schema>.<table>` — the key convention the change log and work counters already use — to `{ rows, baselineRows, observations, shifts }` plus the `TableSchema` object the count was observed under.

- **Validity is schema identity.** An entry answers only for the exact `TableSchema` object it was observed against. Any schema swap — `ANALYZE` (manual or automatic), `ALTER TABLE`, drop and re-create — makes the entry inert, and a `table_modified` / `table_removed` listener evicts it. So an entry that answers is always newer than the catalog statistics on the schema it names.
- **Bounded.** At most `cardinalityFeedback.maxTables` entries (default 512), least-recently-used evicted. Eviction silently reverts that table to catalog or default numbers at its next compile; no plan is invalidated for it.
- **Not persisted.** A new `Database` starts empty; two `Database` instances over the same storage learn independently.

### 3.3 Precedence: one row count per plan

The row-count seam is `plannedRowCount(table, sources)` (`planner/stats/table-cardinality.ts`). First answer wins:

1. an **exact** module count (`VirtualTableModule.getRowCount` answering `exact: true`) — maintained on every write path, so it is the truth now and any snapshot is older;
2. the overlay's observed count, when it has a valid entry;
3. an **approximate** module count — below the overlay because an estimate can be off by more than the 10× shift factor and only a complete scan's observation can correct it; above the catalog because it describes the table now, while an `ANALYZE` snapshot (rare and expensive in the remote deployments this targets) may be arbitrarily old;
4. `catalogRowCount(table)`;
5. `undefined` (unknown — callers keep applying their own defaults).

The module is asked first, so an exactly-sized table never touches the overlay (whose reads refresh its recency). Its answer is a hint: a throw or a malformed answer (`rows` not a non-negative integer) is logged at debug level and treated as a decline. The hook's contract — memory only, constant time; `rows` is what a read issued now by this database would see, the module's own buffered transaction writes included; `exact` only for a count maintained on every write — is on its doc comment in `vtab/module.ts`.

`sources` is one object per `Database` (`databaseRowCountSources`: the overlay, and the table's registered module resolved by `vtabModuleName`), and both planner readers call the seam with it, so scan cardinality and selectivity denominators cannot disagree ([OPT-062](invariants.md#opt-062--one-base-table-row-count-per-plan)):

- `TableReferenceNode` computes its estimate **once, at construction**, from the sources reachable through its `SchemaManager` (`getRowCountSources`). Plan nodes are immutable, so a node built before an observation or a write keeps the number its plan was costed with.
- `CatalogStatsProvider.tableRows` reads the same sources, injected when the `Database` constructs its `Optimizer`. Building and optimizing happen in one synchronous `compile()`, so neither a module count nor the overlay can change between the node's snapshot and the provider's read.

Only the row count is overridden. Per-column distinct counts, null counts and histograms — selectivity *fractions* — still come from the catalog, and with no catalog statistics the naive selectivities still apply. The planned value is also `request.estimatedRows` for `getBestAccessPlan`, because the access path must be priced against the same size as the plan around it; a module that reports its count is therefore priced against it everywhere. `StoreModule.sizeRequestFromLiveCount`, which fills an absent hint from the store's running count, is now a backstop for a request that arrives without it (a wrapper that forwards `getBestAccessPlan` but not `getRowCount`).

The other `catalogRowCount` callers — assertion and watcher delta sizing, the lens prover's cardinality band, auto-analyze's staleness arithmetic — stay catalog-only.

### 3.4 When an observation is recorded, and when it shifts plans

For an observed count `n` of table `T`, let `before` be what planning would use right now: `plannedRowCount` with this overlay's entry (3.3), else `tuning.defaultRowEstimate` (1000). So a complete scan of an exactly module-sized table is compared against the module's count and, agreeing with it, shifts nothing. Let `spread(a, b) = (max(a, b) + 1) / (min(a, b) + 1)`.

- **Ignore** an observation made under a `TableSchema` that is no longer the catalog's current object for its name — it describes nothing current.
- **Record** only when `max(before, n) > cardinalityFeedback.minRows` (default 1000). Below that size every plan finishes fast, so a tiny table keeps the numbers it plans with today — which is also what keeps the SQL logic test corpus (largest generated table: 200 rows) from changing plans.
- A recorded count always replaces `rows`, so the next compile of any statement uses the freshest exact count.
- **Shift** when `spread(n, baselineRows) ≥ cardinalityFeedback.shiftFactor` (default 10). A new entry's baseline is `before`; a shift resets the baseline to `n` and notifies the re-planning machinery (3.6). Measuring against the baseline rather than the previous count means steady growth in small steps still shifts once it has accumulated to 10×, while a count wobbling within 10× of the baseline never disturbs a cached plan.

### 3.5 Publication and transactions

An observation describes the rows its scan could see, which inside a transaction includes that transaction's own uncommitted writes. Only committed state may reach the overlay:

- an execution with `readCommitted` (the mutex-free committed-read path) publishes immediately — it read committed state by construction;
- an execution that ends with no transaction open publishes immediately;
- otherwise — every statement inside an explicit transaction, and every writing statement in autocommit mode, whose implicit transaction is still open when the run site publishes — its observations are held (`CardinalityFeedbackManager.publish`), last count per table winning, until the transaction ends. A transaction holds at most one count per distinct table it observed.

On commit — in the same post-commit window auto-analyze reads the change log (`Database.recordCommittedChangeCounts`, which builds the change log's per-table counts at most once for both consumers, and not at all when nothing is held and auto-analyze is off) — held observations are applied (`onCommitted`), **except** for tables the transaction itself wrote: such a count was taken mid-transaction, possibly before later writes in the same transaction, and the change log cannot say which came first. "Wrote" includes a table whose writes cancelled out (an insert then a delete of the same key) and one an `update` merely rewrote; reads outside such transactions re-observe them. So `insert into t2 select * from big` records `big` at its commit, while `delete from big` records nothing.

A rollback (including an `OR ROLLBACK` conflict), a failed commit (a deferred constraint or assertion violation, a connection commit error), or a `rollback to savepoint` discards everything held (`onRolledBack`, through `TransactionManagerContext.transactionRolledBack`) — for a savepoint, including observations made before it; precision is not worth tracking per savepoint. A rollback that runs *during* an execution also discards that execution's own observations, which are not yet held: a failing statement inside an explicit transaction rolls back its statement savepoint before its run site publishes, and a scan it completed may have counted its own undone writes. Each execution's sink is stamped with the overlay's rollback count when it is created (`beginObservations`); `publish` discards a non-`readCommitted` sink whose stamp no longer matches. An `OR FAIL` conflict commits the rows before it, but it undoes the failing row through a per-row savepoint, so what was held is discarded too. Turning `cardinality_feedback` off, or closing the `Database`, discards held observations with the rest of the overlay.

Publication runs in the run site's `finally`, after the execution's scan connections are disconnected. It and both transaction hooks are bookkeeping: a failure is logged and never fails the statement, the commit or the rollback.

### 3.6 Re-planning cached statements

A shift for `T` walks the `Database`'s live statements (`Database.noteCardinalityShift`) and marks those whose current plan reads `T` (`Statement._noteCardinalityShift`). Each compile keeps the lowercased `<schema>.<table>` of every `table` dependency the builder recorded; view and lens bodies build in the reading statement's planning context, so a plan over a view carries its base tables. A marked statement re-plans at the start of its next execution by calling `Statement.invalidatePlan()` — the same full rebuild from the retained AST a schema change triggers, with the statement's established parameter types. A running execution is never disturbed; the mark waits for the next one.

A module-reported size (3.3) is the second trigger. It moves on every write with no event the planner hears, and a plan that no longer reads the table in full never produces the complete-scan observation a shift needs, so this trigger is pulled rather than pushed. Each compile also keeps, for every `table` dependency whose module implements `getRowCount`, the row count the plan was costed with — `plannedRowCount`, read in the same synchronous compile (`ReportedSizeSnapshot`, `core/database-cardinality-feedback.ts`). At each execution start, before the cooldown below is consulted, the statement compares every kept count with the table's current `plannedRowCount`, an unknown on either side reading as `tuning.defaultRowEstimate`; when `spread(now, then) ≥ shiftFactor` and `max(now, then) > minRows` — the shift rule of 3.4 — it marks its own plan exactly as a shift would.

- Planned counts, not raw module answers, are compared, so an approximate module count the overlay outranks drifts only when what planning uses drifts.
- Tables whose module has no hook are not kept (shifts and schema changes cover them), and a kept table whose catalog object has since been replaced is skipped — its schema change already dropped the plan. The check costs one `plannedRowCount` per kept table per execution, and nothing for a plan over tables without the hook.
- Inside a transaction the store's count includes the transaction's buffered writes, so a bulk load re-plans dependent statements at their next execution once it crosses 10×, and a rollback that shrinks the count 10× re-plans them back.
- Like module counts themselves, the check is not gated by `cardinality_feedback` (3.7).

Both triggers share the pacing:

- The **first** feedback re-plan of a statement is immediate: the point is that the second execution already runs the corrected plan.
- Later feedback re-plans of the same statement wait until it has executed at least `cardinalityFeedback.replanCooldown × 2^(k−1)` times since the previous one, counting the execution that re-planned (default cooldown 8; `k` = feedback re-plans so far, multiplier capped at 64). A mark arriving sooner stays pending and fires at the first execution start past the cooldown. A table oscillating across 10× — a queue filled and drained — re-plans each dependent statement O(log executions) times rather than on every execution. The arithmetic is `FeedbackReplanState` (`core/database-cardinality-feedback.ts`), one per statement.
- A plan dropped for any other reason (schema change, first bind of an untyped parameter, advancing to the next statement of a batch) clears the mark and the kept counts, since the plan compiled next reads the current overlay and module counts anyway; it does not count as a feedback re-plan.
- One-shot calls (`db.get`, `db.eval`, `db.exec`) compile on every call and always read the current overlay and module counts; they need no marking.
- Plans cached outside `Statement` — materialized-view maintenance plans, assertion and watcher delta plans — are not feedback-invalidated by either trigger; they re-plan on schema change only.

### 3.7 Interactions

- **`ANALYZE` and auto-analyze.** A fresh `ANALYZE` swaps the schema, so the catalog wins until the next observation; auto-analyze therefore keeps owning tables this session writes, and feedback covers what it cannot reach (section 2). Feedback never triggers `ANALYZE` and auto-analyze never reads the overlay.
- **Parameters.** Table sizes do not depend on parameter values, so one plan per statement remains correct; no per-binding plans are introduced.
- **Determinism.** Feedback is on by default, so a statement's plan can depend on what the same `Database` executed before it — in practice only through a table larger than `minRows` whose observed size is 10× off what planning assumed (3.4). `pragma cardinality_feedback = false` clears the overlay and stops observation, so every later compile reads module counts and the catalog only; plans already cached keep their shape until their next recompile. The option does not gate module-reported counts, nor the drift re-plan they drive (3.6): those are the backend's own statistic — data-dependent like `ANALYZE` and like the store's access-path sizing before them — not learned from history. A host or test that needs reproducible plans — plan snapshots, plan-shape assertions over large tables — sets it before running anything. (QuickPick's wall-clock bound, `bug-join-order-depends-on-wall-clock`, is a separate source of plan variation.)
- **DDL decisions that read sizes.** The materialized-view strategy cost gate and its create-time size reject read `CatalogStatsProvider.tableRows`, so an observed size can now decide them — the same history dependence auto-analyze already introduces by refreshing the catalog in the background. A module count decides them too: a full-rebuild-only view body over a never-analyzed store table holding more than `materialized_view_rebuild_row_threshold` (10,000) rows is rejected at create, where it used to read the 1000-row default.
- **Module counts in cached plans.** A prepared statement keeps the module count it compiled with until that count drifts `shiftFactor` from it, and re-plans at the next execution start after it does (3.6). A complete scan cannot do this for a module-sized table: `before` is the live count (3.4), so the scan agrees with it and shifts nothing. Drift inside the 10× band keeps the cached plan, as an observation inside the band does.
- **Measured zero.** An observed empty table is recorded as `0` when its previous estimate was large; the planner sites that read a row count with `|| 1000` collapse it to 1000 exactly as they do an analyzed zero (`bug-measured-empty-table-costed-as-thousand-rows`).
- **Concurrency.** JavaScript runs each publication to completion, and `compile()` is synchronous, so no plan can observe a half-applied update. Observations from concurrent committed reads and from the writer's commit may race for the same table; the later publication wins, and both describe committed state. The later one is not always the newer state: a committed read that started before a commit and finished after it publishes the pre-commit count over a fresher one. That count is one the table really had, and the next complete scan replaces it; if stale counts from long concurrent reads ever matter, tag each observation with the commit it read and refuse older ones.
- **Benchmark gate.** `yarn bench:gate` compares exact work counters. A workload over a large never-analyzed table can re-plan after its first execution and change its counters; such a reference is re-baselined with a stated reason. Turning the default on changed none: every SQL benchmark table holds at most 10,000 rows, and `spread(10000, 1000)` is just under 10, so those tables are recorded but never shift a plan.

### 3.8 Overhead budget and how it is verified

- **Feedback off:** per row, at most one increment of a generator-local counter in the scan loop — no property read, no allocation; per scan invocation, one property read of the sink. The `work-counter-scan-overhead-measurement` precedent measured a per-row branch of this size inside the noise floor of every execution benchmark.
- **Feedback on:** additionally one map write per completed qualifying scan, one publication per execution (proportional to the tables it observed), and on a shift one walk over live statements. Shifts are rare by construction (3.4).
- **Reported-size drift check (3.6):** per compile, one `plannedRowCount` per `table` dependency whose module implements `getRowCount`; per execution start, one more per kept table, and nothing for tables without the hook. Measured over an isolation-wrapped in-memory store table of 10,000 rows: 0.27 µs to capture and 0.19 µs to check, beside 3.9 ms for the one-shot indexed `select` they rode on. `yarn bench --filter @store-mem` before and after: work counters identical on all 19 rows; the after-run flagged two rows a few points past their noise floors, and re-measured alone both read no change.
- **Verification:** the `yarn bench` execution suite before and after each change, compared with `--baseline` against a run of the pre-change build ([Benchmarking § Measuring one commit's cost](benchmarking.md#measuring-one-commits-cost)), must show no gated regression, with the scan-heavy rows (`full-scan-10k`, `filtered-scan-index-10k`, `join-1kx1k`, `correlated-subquery`, `hand-batched-peer-count`) inside their noise floor — once for the scan observation (feedback off) and again when the default turned on. The second run, flip alone against its parent build: 27 rows no change, 1 improved, 0 regressed, `join-1kx1k` unstable in both runs (not gated), every scan-heavy row inside its noise floor, and all 30 work-counter sets identical. Re-plan cost is bounded by the cooldown rather than benchmarked: one extra compile per shift per statement, measured at 0.8–2 ms for simple statements and about 9 ms for a four-way join on the machine above.

### 3.9 Diagnostics and the escape hatch

- `cardinality_feedback()` (table-valued, non-deterministic) lists the valid overlay entries, one row per table ordered by schema then table: observed rows, catalog rows, baseline, observation and shift counts (columns in `docs/functions.md`). It reads the overlay when it executes, so one prepared call sees later observations; with the option off it returns no rows.
- `Statement.getPlanShape()` shows a statement's current plan, so a feedback re-plan is visible as a change in node types — between the shift and the next execution it still shows the cached plan.
- The `core:cardinality-feedback` log names each shift (table, old baseline, new count) and each feedback re-plan (statement SQL prefix); `core:cardinality-feedback:debug` adds every record, drop and discard, and each reported-size drift (table, planned count, current count).
- `cardinality_feedback` (boolean database option) is the master switch; turning it off clears the overlay.

---

## 4. Rejected alternatives

- **A Tier 0 "heuristic-only" optimization mode, chosen per query by a fingerprint registry.** Measured on one machine, optimizing `select val from a where id = ?` takes about 0.9 ms (against 0.22 ms to execute it warm), of which constant folding and structural rewrites are roughly 0.75 ms — passes any tier would still run, because they are what makes the plan robust — while the cost-based Physical and PostOptimization passes are about 0.2 ms. Only a join of three or more tables spends most of its time in cost-based search (QuickPick: about 3.6 ms of 8 ms for four tables), and that is where a heuristic join order hurts most. A second physical-selection path would buy little speed for a permanent maintenance cost. "Never block on statistics" already holds, since planning does no I/O. The real lever for repeated compiles is reusing plans across one-shot statements (section 5).
- **Re-running only physical selection on the cached plan.** Cost-dependent decisions are spread over three passes — Structural (`grow-retrieve`, `join-greedy-commute`, `fanout-lookup-join`, the materialized-view rewrite), Physical (access path, QuickPick, aggregate strategy) and PostOptimization (join algorithm, key-set seek, merge join, nested-loop caching, conjunct ordering) — and the Physical pass cannot re-run over a tree that is already physical. Caching the post-Structural plan to resume from would freeze the Structural cost decisions at the stale number. Feedback re-plans fully from the AST.
- **The overlay as a `StatsProvider` layered over `CatalogStatsProvider`.** `TableReferenceNode.estimatedRows` reads the row count without an `OptContext`, so a provider wrapper would change selectivity denominators but not scan cardinality — the drift the shared row-count seam exists to prevent.
- **Reusing `runtime_metrics` work counters as the feedback source.** Metrics mode costs a counting generator per streaming output and a clock read per instruction, and its structural addresses carry neither table identity nor whether a scan completed.
- **Keying observations by predicate with `fingerprintExpression`.** It keys columns by attribute id (fresh on every build), embeds literal values, and falls back to node ids for subqueries — stable within one plan, meaningless across two.
- **Per-operator actual cardinalities keyed by plan position.** Invalid the moment the plan they describe changes, which is the outcome they exist to cause.
- **Sharing compiled plans between statements through a registry.** Emitted plans capture schema objects and module instances and are invalidated per statement; sharing them needs its own lifecycle design and is unnecessary for feedback, which keys on tables.
- **Persisting observations.** Session-scoped by design; `ANALYZE` and the store's persisted statistics are the durable channel.

---

## 5. Deferred work

Queued, in this order (tickets in `tickets/implement/`, `fix/` and `plan/`; each section above changes only when its ticket lands):

- **Measured zero honored** — the `|| 1000` / `|| 100` reads stop turning a measured empty table into an unknown one; cost consumers floor it at one row: `bug-measured-empty-table-costed-as-thousand-rows`.
- **Lower bounds from partial reads** — a `LIMIT`ed scan or a single-window seek that yielded N rows proves the table holds at least N; the overlay keeps the floor, which only ever raises an estimate: `cardinality-feedback-lower-bounds`.
- **Unknown sizes default consistently** — with no statistics, join selection prices an unknown side at 100 rows and ignores reductions above it, so a filtered or single-row side joined to an indexed table full-scans that table: `unknown-size-join-scans-instead-of-seeking` (fix stage).
- **Rows per key from executed seeks** — the first slice beyond table size: `cardinality-feedback-rows-per-key` (plan stage).

Still deferred:

- **Feedback beyond table size**, remainder — filter selectivity on unindexed columns, ranges and join output cardinality: `feat-cardinality-feedback-beyond-table-size`.
- **Mid-execution adaptation** — reacting at a pipeline breaker whose input count diverges from the plan, before the downstream operators run: `feat-mid-execution-plan-adaptation`.
- **Plan reuse across one-shot statements** — the compile-cost lever the Tier 0 idea was reaching for: `feat-reuse-plans-across-one-shot-statements`.
- **IndexedDB's read latency** — measuring and declaring it once per-row pricing exists, and whether the 25 ms parallel gates should become cost-based for sub-millisecond backends: `feat-indexeddb-declares-its-read-latency`.

---

## 6. Key files

| File | Role |
|---|---|
| `src/planner/stats/table-cardinality.ts` | The base-table row-count seam (`plannedRowCount` over `RowCountSources` and `catalogRowCount`; `reportedRowCount` asks the module) |
| `src/vtab/module.ts` | `VirtualTableModule.getRowCount` — a module's own count, and its contract |
| `src/planner/stats/catalog-stats.ts` | `CatalogStatsProvider` — catalog statistics, naive fallback |
| `src/planner/nodes/reference.ts` | `TableReferenceNode.estimatedRows` — every scan's base cardinality |
| `src/core/database-auto-analyze.ts` | Committed-change staleness and background `ANALYZE` |
| `src/core/database-cardinality-feedback.ts` | The observed row-count overlay, record policy, shift detection, publication (`publish`) and commit-scoped holding (`onCommitted`, `onRolledBack`); the per-statement re-plan cooldown (`FeedbackReplanState`); the module-reported sizes a cached plan was costed with (`ReportedSizeSnapshot`) |
| `src/runtime/emit/scan.ts` | The scan leaf, where complete enumerations are observed (`enumeratesWholeTable`) |
| `src/runtime/cardinality-observations.ts` | Per-execution observation sink on the `RuntimeContext` |
| `src/runtime/work-counters.ts` | Diagnostic work counters (not the feedback channel) |
| `src/core/statement.ts` | Plan cache, `invalidatePlan()`, schema-change invalidation, feedback re-plan marking (`_noteCardinalityShift`, and the reported-size drift check at execution start) |
| `src/planner/optimizer-tuning.ts` | `defaultRowEstimate`, and the `cardinalityFeedback` knobs (`minRows`, `shiftFactor`, `maxTables`, `replanCooldown`) |
