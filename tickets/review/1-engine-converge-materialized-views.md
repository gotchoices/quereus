description: Review the engine convergence primitive — Database.refreshAllMaterializedViews() refreshes every materialized view in source-dependency order
prereq:
files:
  - packages/quereus/src/core/database.ts                       # refreshAllMaterializedViews() (public, ~line 1888)
  - packages/quereus/src/core/database-materialized-views.ts    # sourceBasesFor() + materializedViewRefreshOrder() (~line 755, "convergence ordering")
  - packages/quereus/src/runtime/emit/materialized-view.ts      # refreshMaintainedTable() extracted shared helper; emitRefreshMaterializedView rewired
  - packages/quereus/test/mv-converge-all.spec.ts               # new spec (5 cases)
  - docs/materialized-views.md                                  # § Converging all materialized views (under External row-change ingestion)
difficulty: medium
----

# Review: engine convergence — refresh all materialized views in source order

## What landed

A public `Database.refreshAllMaterializedViews(): Promise<Array<{ schemaName; name }>>`
that refreshes **every** maintained table in source-dependency order — the
deferred-maintenance catch-up point after a wholesale external load (the
downstream `snapshot-bootstrap-defer-mv-maintenance` consumer). Implementation:

- **Shared helper, no duplication.** The per-MV refresh core (stale revalidation
  → shape re-derivation → `reshapeBacking`/`rebuildBacking` → `registerMaterializedView`
  → clear `stale` → `materialized_view_refreshed` notify) was extracted from
  `emitRefreshMaterializedView`'s `run` into an exported
  `refreshMaintainedTable(db, mv)` in `runtime/emit/materialized-view.ts`. Both
  the `refresh materialized view` emitter and the new sweep call it. The
  emitter keeps the `_ensureTransaction()` + lookup/error-handling shell (the
  `_ensureTransaction` call is *before* the lookup, so it stays in the emitter —
  the helper assumes a transaction is already ensured).

- **Ordering in the manager.** `MaterializedViewManager.sourceBasesFor(mv)` returns
  a live MV's compiled-plan bases (`planSourceBases`) or — for a **stale** MV with
  no live plan — the recorded `mv.derivation.sourceTables`.
  `materializedViewRefreshOrder()` builds prereq edges (`sourceBasesFor ∩ MV-key set`)
  and topo-sorts (Kahn), throwing `INTERNAL` on a cycle (impossible past the
  create-time recursion gate; a backstop, not a silent drop).

- **Driver.** `refreshAllMaterializedViews()` builds the order outside the mutex
  (empty catalog ⇒ `[]`, no mutex/transaction), then under `_withMutex` refreshes
  each MV with a per-MV implicit-transaction commit (mirrors `exec`'s
  per-statement boundary) and accumulates the `{ schemaName, name }` list.

`yarn workspace @quereus/quereus test` → **6165 passing / 9 pending**.
`yarn lint` → clean.

## Why it's correct (the load-bearing invariants to re-check)

- **Commit-first per MV ⇒ sequential topo refresh is correct.** `rebuildBacking`
  (`replaceContents`, or the constraint-bearing `conn.commit()`) swaps *committed*
  state, not undone by an enclosing rollback. So a base MV's backing is committed
  before a dependent MV's body re-reads it — the MV-over-MV ordering test pins this
  (a wrong order would leave the dependent empty/stale). Deliberately **not** wrapped
  in one explicit transaction (would not make it atomic anyway). Non-atomic by
  design: a mid-sweep failure leaves earlier MVs converged; the caller retries
  the whole load idempotently.

- **Refresh full-rebuilds**, bypassing the bounded-delta arm — convergence does not
  depend on delta replay, and the rebuild re-reads the complete source through the
  vtab regardless of how rows arrived (out-of-band direct-storage writes included).

## Tests (the floor — treat as a starting point)

`packages/quereus/test/mv-converge-all.spec.ts`, 5 cases:
1. No MVs → `[]`, no transaction opened.
2. Full-rebuild MV (`select distinct v`) over a source filled by **out-of-band
   direct `vtab.update()` writes** (the `directWrite` stand-in for external storage
   writes, copied from `external-row-change-ingestion.spec.ts`) → converges; returned
   list names it.
3. Bounded-delta MV (keyed passthrough) over the same out-of-band source → converges
   identically.
4. MV-over-MV chain (`a` over `t`, `b` over `a`) → `b` reflects all of `t` after one
   sweep; returned-list order is `[a, b]` (asserts base-first ordering).
5. Stale MV (forced via `alter table src add column`, which detaches the row-time
   plan) → converges, clears `stale`, and a subsequent in-band DML write is maintained
   (proves row-time re-registration). Exercises the `sourceBasesFor` stale branch.

## Known gaps / decisions for the reviewer to weigh

- **Deviation from the ticket's literal `sourceBasesFor` spec.** The ticket said to
  re-derive a stale MV's source bases from `derivation.selectAst` (re-running the
  body analysis `buildFullRebuildPlan` performs). I used the recorded
  `derivation.sourceTables` instead. Rationale: that field already holds exactly the
  body's source-table set, is kept current through reshape, produces **identical**
  ordering edges, and — unlike re-planning a stale body — cannot throw a planning
  error before the per-MV refresh surfaces the real staleness diagnostic. Documented
  in the method's docstring. If the reviewer prefers literal re-derivation, it's a
  small swap (build+`optimizeForAnalysis`+`collectTableRefs`, guarded), but I judged
  the recorded set strictly more robust.

- **Mutex held once for the whole sweep**, not re-acquired per MV. The ticket phrased
  concurrency as "each per-MV refresh acquires the exec mutex via the normal statement
  path." Holding it once for the sweep satisfies the serialization intent and matches
  `exec` (which holds the mutex across a multi-statement batch). Worth confirming this
  reading is acceptable vs. literally routing each MV through a separate statement.

- **Only autocommit is tested.** Behavior **inside an explicit user `BEGIN`** is
  untested: there `_isImplicitTransaction()` is false, so the per-MV commit is skipped
  and the refreshes stay part of the caller's transaction. Base-first reads should
  still work (refresh's swap is commit-first regardless of the enclosing transaction —
  see the `commit-first parity` test in `maintained-table-refresh-revalidation.spec.ts`),
  but a sweep run inside an explicit transaction is not pinned. Consider adding a case.

- **Cross-schema / attached-schema MVs** are not tested. Ordering keys on lowercased
  `schema.table` and should handle them, but no test exercises an MV in a non-`main`
  schema or an MV reading a source in another schema.

- **No large-N ordering stress test.** The Kahn sort is O(V+E) and the chain test is
  depth 2; deeper/wider DAGs and diamond shapes (one base feeding two consumers) are
  not pinned. A diamond would be a cheap, valuable addition.

- **Out-of-band write visibility** in tests rides the same mechanism the
  `external-row-change-ingestion` full-rebuild test relies on (directWrite pending rows
  become visible to the sweep's coordinated re-read, then commit at the per-MV commit).
  This passed empirically but is a subtle cross-connection transaction interaction worth
  an extra skeptical look.

- **Pre-existing note:** `SchemaManager.getAllMaintainedTables()` / `getMaintainedTable()`
  and `derivation.ts`'s `isMaintainedTable` / `MaintainedTableSchema` already existed
  (the ticket's `files` listed them as if new) — used as-is, not modified.
