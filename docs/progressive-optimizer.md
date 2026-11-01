# Progressive Query Optimization

This document describes how Quereus improves plans from what execution reveals, without depending on collected statistics. It assumes familiarity with [Optimizer](optimizer.md) (pass framework, rules), [Optimizer Cost and Statistics](optimizer-costing.md) (cost model, `StatsProvider`, base-table row estimates) and [Runtime](runtime.md) (emission, scheduler, streaming execution).

Quereus targets deployments where table storage may sit behind a network — a distributed hash table, a remote store — so every read is expensive and a full scan run only to collect statistics is often unaffordable. The optimizer must produce good plans with zero collected statistics, and improve them using numbers that *essential* execution produces anyway. Statistics are hints that improve a good plan, never prerequisites without which the plan is bad.

**Status.** Sections 1, 2 and 4–6 describe settled design and current code. Section 3, *cardinality feedback*, is being built by the `cardinality-feedback-*` tickets (`tickets/implement/`), each of which updates this document as it lands. Landed: the overlay, the one row-count seam and the record/shift policy (3.2–3.4). Nothing records into the overlay yet — scan observation (3.1) and publication (3.5) are next — and a shift is only debug-logged until re-planning (3.6) lands. The rest of section 3 is design.

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
- **Catalog statistics.** `CatalogStatsProvider` (`planner/stats/catalog-stats.ts`) reads `TableSchema.statistics` — row count, per-column distinct and null counts, min/max, equi-height histograms, collected by `ANALYZE` — and falls back to `NaiveStatsProvider` (1000 rows, flat selectivities). Base-table row counts go through one seam, `plannedRowCount` (`planner/stats/table-cardinality.ts`), read by both `TableReferenceNode.estimatedRows` and `CatalogStatsProvider.tableRows`, so scan cardinality and selectivity denominators cannot disagree; it consults the observed row-count overlay (3.2) before the catalog. See [Optimizer Cost and Statistics](optimizer-costing.md#statistics-abstraction).
- **Auto-analyze.** `AutoAnalyzeManager` (`core/database-auto-analyze.ts`, on by default) counts rows changed by committed transactions and, past `max(500, 20%)` of the known size, runs `ANALYZE` for that table in the background — skipping tables above `auto_analyze_row_limit` (100,000). `ANALYZE` swaps the table's `TableSchema` and fires `table_modified`, which invalidates every cached plan reading that table. So local tables that this session writes already get fresh catalog statistics without anyone typing `ANALYZE`.
- **Module access-path sizing.** `rule-select-access-path` hands the planned row count to `getBestAccessPlan` as `request.estimatedRows` (`undefined` when unknown); a module that knows its own size may substitute it there, as `StoreModule` does from its running count. Nothing calls `VirtualTable.getStatistics()` during planning.
- **Work counters (diagnostic only).** With `runtime_metrics` on, each execution feeds a `WorkCounterCollector` (`runtime/work-counters.ts`): per-instruction executions and rows, per-table `query()` calls and rows scanned, keyed by structural program address. Metrics mode wraps every streaming output in a counting generator and times every instruction, which is why it is a debugging and benchmarking instrument and not the feedback channel. See [Runtime Work Counters](runtime-work-counters.md).

The gap these leave: a table this session has not written — opened from storage with data and no saved statistics, served by a remote module, larger than the auto-analyze limit, or in a session with `auto_analyze` off — is planned at the 1000-row default (or at an `ANALYZE` snapshot that has since drifted) for as long as the session lives, even after a query has read every one of its rows.

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

Per-execution observations collect in a sink on the `RuntimeContext` (fork policy `shared-sink`, like `workCounters`, so forked parallel branches report into the parent's sink), created only when the `cardinality_feedback` option is on. The run sites that create it are `Statement._iterateRowsRawInternal` and `Database._executeSingleStatement`; the internal run sites (deferred constraints, assertions, materialized-view apply) do not, exactly as they carry no work counters.

Intermediate cardinalities — filter output, join output, sort or aggregate input — are not observed in this design. Their meaning depends on the plan that produced them, so there is no key under which they stay valid across a re-plan; see section 5.

### 3.2 The observed row-count overlay

A `Database` owns one overlay (`CardinalityFeedbackManager`, `core/database-cardinality-feedback.ts`): a map from lowercased `<schema>.<table>` — the key convention the change log and work counters already use — to `{ rows, baselineRows, observations, shifts }` plus the `TableSchema` object the count was observed under.

- **Validity is schema identity.** An entry answers only for the exact `TableSchema` object it was observed against. Any schema swap — `ANALYZE` (manual or automatic), `ALTER TABLE`, drop and re-create — makes the entry inert, and a `table_modified` / `table_removed` listener evicts it. So an entry that answers is always newer than the catalog statistics on the schema it names.
- **Bounded.** At most `cardinalityFeedback.maxTables` entries (default 512), least-recently-used evicted. Eviction silently reverts that table to catalog or default numbers at its next compile; no plan is invalidated for it.
- **Not persisted.** A new `Database` starts empty; two `Database` instances over the same storage learn independently.

### 3.3 Precedence: one row count per plan

The row-count seam is `plannedRowCount(table, observed)` (`planner/stats/table-cardinality.ts`): the overlay's count when it has a valid entry, else `catalogRowCount(table)`, else `undefined` (unknown — callers keep applying their own defaults). Both planner readers call it, so scan cardinality and selectivity denominators cannot disagree ([OPT-062](invariants.md#opt-062--one-base-table-row-count-per-plan)):

- `TableReferenceNode` computes its estimate **once, at construction**, from the overlay reachable through its `SchemaManager`. Plan nodes are immutable, so a node built before an observation keeps the number its plan was costed with.
- `CatalogStatsProvider.tableRows` consults the same overlay, injected when the `Database` constructs its `Optimizer`. Building and optimizing happen in one synchronous `compile()`, so the overlay cannot change between the node's snapshot and the provider's read.

Only the row count is overridden. Per-column distinct counts, null counts and histograms — selectivity *fractions* — still come from the catalog, and with no catalog statistics the naive selectivities still apply. The overlay value is also `request.estimatedRows` for `getBestAccessPlan`, because the access path must be priced against the same size as the plan around it. A self-sizing module (`StoreModule`) honors a supplied hint over its own running count, so between full scans it prices against the last observed size rather than its live one — accepted for one-size-per-plan consistency; when a module's live size reaches the planner (`feat-planner-asks-the-backend-how-big-a-table-is`), it should outrank the overlay.

The other `catalogRowCount` callers — assertion and watcher delta sizing, the lens prover's cardinality band, auto-analyze's staleness arithmetic — stay catalog-only.

### 3.4 When an observation is recorded, and when it shifts plans

For an observed count `n` of table `T`, let `before` be what planning would use right now: the overlay entry, else the catalog count, else `tuning.defaultRowEstimate` (1000). Let `spread(a, b) = (max(a, b) + 1) / (min(a, b) + 1)`.

- **Ignore** an observation made under a `TableSchema` that is no longer the catalog's current object for its name — it describes nothing current.
- **Record** only when `max(before, n) > cardinalityFeedback.minRows` (default 1000). Below that size every plan finishes fast, so a tiny table keeps the numbers it plans with today — which is also what keeps the SQL logic test corpus (largest generated table: 200 rows) from changing plans.
- A recorded count always replaces `rows`, so the next compile of any statement uses the freshest exact count.
- **Shift** when `spread(n, baselineRows) ≥ cardinalityFeedback.shiftFactor` (default 10). A new entry's baseline is `before`; a shift resets the baseline to `n` and notifies the re-planning machinery (3.6). Measuring against the baseline rather than the previous count means steady growth in small steps still shifts once it has accumulated to 10×, while a count wobbling within 10× of the baseline never disturbs a cached plan.

### 3.5 Publication and transactions

An observation describes the rows its scan could see, which inside a transaction includes that transaction's own uncommitted writes. Only committed state may reach the overlay:

- an execution with `readCommitted` (the mutex-free committed-read path) publishes immediately — it read committed state by construction;
- an execution that ends with no transaction open publishes immediately;
- otherwise its observations are held until the transaction ends. On commit — in the same post-commit window auto-analyze reads the change log — held observations are applied, **except** for tables the transaction itself changed, whose mid-transaction counts may no longer hold. A rollback, a `rollback to savepoint`, or a failed commit discards everything held.

**Interim:** holding is not built yet (`cardinality-feedback-commit-scoped-publication`). Today `CardinalityFeedbackManager.publish` discards observations from an execution that ends with a transaction open — every statement inside an explicit transaction, and every writing statement in autocommit mode, whose implicit transaction is still open when the run site publishes. Publication runs in the run site's `finally`, after the execution's scan connections are disconnected; it is bookkeeping, so a failure is logged at warn and never fails the statement.

### 3.6 Re-planning cached statements

A shift for `T` walks the `Database`'s live statements and marks those whose current plan depends on `T` (the table dependencies `compile()` already collects). A marked statement re-plans at the start of its next execution by calling `Statement.invalidatePlan()` — the same full rebuild from the retained AST a schema change triggers. A running execution is never disturbed; the mark waits for the next one.

- The **first** feedback re-plan of a statement is immediate: the point is that the second execution already runs the corrected plan.
- Later feedback re-plans of the same statement wait until it has executed at least `cardinalityFeedback.replanCooldown × 2^(k−1)` times since the previous one (default cooldown 8; `k` = feedback re-plans so far, multiplier capped at 64). A table oscillating across 10× — a queue filled and drained — re-plans each dependent statement O(log executions) times rather than on every execution.
- Any other compile (schema change, first bind of an untyped parameter) clears the mark, since the new plan reads the current overlay anyway.
- One-shot calls (`db.get`, `db.eval`, `db.exec`) compile on every call and always read the current overlay; they need no marking.
- Plans cached outside `Statement` — materialized-view maintenance plans, assertion and watcher delta plans — are not feedback-invalidated; they re-plan on schema change only.

### 3.7 Interactions

- **`ANALYZE` and auto-analyze.** A fresh `ANALYZE` swaps the schema, so the catalog wins until the next observation; auto-analyze therefore keeps owning tables this session writes, and feedback covers what it cannot reach (section 2). Feedback never triggers `ANALYZE` and auto-analyze never reads the overlay.
- **Parameters.** Table sizes do not depend on parameter values, so one plan per statement remains correct; no per-binding plans are introduced.
- **Determinism.** A statement's plan now depends on what the same `Database` executed before it. `pragma cardinality_feedback = false` clears the overlay and stops observation, so every later compile is catalog-only again; plans already cached keep their shape until their next recompile. (QuickPick's wall-clock bound, `bug-join-order-depends-on-wall-clock`, is a separate source of plan variation.)
- **DDL decisions that read sizes.** The materialized-view strategy cost gate and its create-time size reject read `CatalogStatsProvider.tableRows`, so an observed size can now decide them — the same history dependence auto-analyze already introduces by refreshing the catalog in the background.
- **Measured zero.** An observed empty table is recorded as `0` when its previous estimate was large; the planner sites that read a row count with `|| 1000` collapse it to 1000 exactly as they do an analyzed zero (`bug-measured-empty-table-costed-as-thousand-rows`).
- **Concurrency.** JavaScript runs each publication to completion, and `compile()` is synchronous, so no plan can observe a half-applied update. Observations from concurrent committed reads and from the writer's commit may race for the same table; the later write wins, and both describe committed state.
- **Benchmark gate.** `yarn bench:gate` compares exact work counters. A workload over a large never-analyzed table can re-plan after its first execution, so turning feedback on by default re-baselines such references once, with a stated reason.

### 3.8 Overhead budget and how it is verified

- **Feedback off:** per row, at most one increment of a generator-local counter in the scan loop — no property read, no allocation; per scan invocation, one property read of the sink. The `work-counter-scan-overhead-measurement` precedent measured a per-row branch of this size inside the noise floor of every execution benchmark.
- **Feedback on:** additionally one map write per completed qualifying scan, one publication per execution (proportional to the tables it observed), and on a shift one walk over live statements. Shifts are rare by construction (3.4).
- **Verification:** the `yarn bench` execution suite before and after each change, compared with `--baseline` against a run of the pre-change build ([Benchmarking § Measuring one commit's cost](benchmarking.md#measuring-one-commits-cost)), must show no gated regression, with the scan-heavy rows (`full-scan-10k`, `filtered-scan-index-10k`, `join-1kx1k`, `correlated-subquery`, `hand-batched-peer-count`) inside their noise floor — once for the scan observation (feedback off) and again when the default turns on. Re-plan cost is bounded by the cooldown rather than benchmarked: one extra compile per shift per statement, measured at 0.8–2 ms for simple statements and about 9 ms for a four-way join on the machine above.

### 3.9 Diagnostics and the escape hatch

- `cardinality_feedback()` (table-valued) lists the overlay: table, observed rows, catalog rows, baseline, observation and shift counts.
- `Statement.getPlanShape()` shows a statement's current plan, so a feedback re-plan is visible as a change in node types; the `core:cardinality-feedback` debug log names each shift and each re-plan.
- `cardinality_feedback` (boolean database option) is the master switch.

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

- **Feedback beyond table size** — predicate selectivity (filter input/output, seek output) and join output cardinality, which need predicate keys stable across re-plans and a channel to modules that estimate pushed-down predicates themselves: `feat-cardinality-feedback-beyond-table-size`.
- **Mid-execution adaptation** — reacting at a pipeline breaker whose input count diverges from the plan, before the downstream operators run: `feat-mid-execution-plan-adaptation`.
- **Plan reuse across one-shot statements** — the compile-cost lever the Tier 0 idea was reaching for: `feat-reuse-plans-across-one-shot-statements`.
- **Module-reported live sizes** — a module that can size itself cheaply should outrank the overlay: `feat-planner-asks-the-backend-how-big-a-table-is`.

---

## 6. Key files

| File | Role |
|---|---|
| `src/planner/stats/table-cardinality.ts` | The base-table row-count seam (`plannedRowCount`, over `catalogRowCount`) |
| `src/planner/stats/catalog-stats.ts` | `CatalogStatsProvider` — catalog statistics, naive fallback |
| `src/planner/nodes/reference.ts` | `TableReferenceNode.estimatedRows` — every scan's base cardinality |
| `src/core/database-auto-analyze.ts` | Committed-change staleness and background `ANALYZE` |
| `src/core/database-cardinality-feedback.ts` | The observed row-count overlay, record policy, shift detection, publication (`publish`) |
| `src/runtime/emit/scan.ts` | The scan leaf, where complete enumerations are observed (`enumeratesWholeTable`) |
| `src/runtime/cardinality-observations.ts` | Per-execution observation sink on the `RuntimeContext` |
| `src/runtime/work-counters.ts` | Diagnostic work counters (not the feedback channel) |
| `src/core/statement.ts` | Plan cache, `invalidatePlan()`, schema-change invalidation |
| `src/planner/optimizer-tuning.ts` | `defaultRowEstimate`, and the `cardinalityFeedback` knobs once they land |
