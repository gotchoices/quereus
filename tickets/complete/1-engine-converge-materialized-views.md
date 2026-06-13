description: Engine convergence primitive — Database.refreshAllMaterializedViews() refreshes every materialized view in source-dependency order. Reviewed and completed.
files:
  - packages/quereus/src/core/database.ts                       # refreshAllMaterializedViews() (~line 1888)
  - packages/quereus/src/core/database-materialized-views.ts    # sourceBasesFor() + materializedViewRefreshOrder() (~line 755)
  - packages/quereus/src/runtime/emit/materialized-view.ts      # refreshMaintainedTable() shared helper; emitter rewired
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # rebuildBacking() commit-first (verified, unchanged)
  - packages/quereus/test/mv-converge-all.spec.ts               # spec — now 6 cases (diamond DAG added in review)
  - docs/materialized-views.md                                  # § Converging all materialized views
----

# Engine convergence — refresh all materialized views in source order

A public `Database.refreshAllMaterializedViews(): Promise<Array<{ schemaName; name }>>`
that refreshes **every** maintained table (materialized view) in source-dependency
order — the deferred-maintenance catch-up point after a wholesale external load
(the downstream `snapshot-bootstrap-defer-mv-maintenance` consumer).

The per-MV refresh core (stale revalidation → shape re-derivation →
`reshapeBacking`/`rebuildBacking` → row-time re-registration → clear `stale` →
`materialized_view_refreshed` notify) was extracted into an exported
`refreshMaintainedTable(db, mv)`; both the `refresh materialized view` emitter and
the new sweep call it (no duplicated rebuild logic). Ordering lives in
`MaterializedViewManager`: `sourceBasesFor(mv)` returns a live MV's compiled-plan
bases or a stale MV's recorded `derivation.sourceTables`;
`materializedViewRefreshOrder()` Kahn-topo-sorts the MV-key DAG (throws `INTERNAL`
on a cycle — an impossible-state backstop past the create-time recursion gate). The
driver builds the order outside the mutex (empty catalog ⇒ `[]`, no mutex/txn) then,
under `_withMutex`, refreshes each MV with a per-MV implicit-transaction commit
mirroring `exec`'s per-statement boundary.

## Review findings

Reviewed the implement-stage diff (`7a44dc7a`) with fresh eyes, then the handoff.
Scrutinized DRY, the mutex/transaction model, the load-bearing commit-first and
ordering-key invariants, error handling, docs, and tests.

### Checked — and found correct

- **DRY / extraction.** `refreshMaintainedTable` is cleanly factored out; the
  emitter keeps only its `_ensureTransaction` + lookup/error shell and delegates the
  rebuild. No second copy. The `_ensureTransaction` call stays *before* the lookup in
  the emitter (the helper assumes a transaction is ensured) — verified at
  `materialized-view.ts:77-94`.
- **No deadlock / mutex parity.** The driver mirrors `exec` exactly: `_withMutex`
  wrapping a per-item loop that calls `_ensureTransaction` → work → commit-if-implicit,
  rollback-on-throw (`database.ts:1925-1942` vs `exec` at `618-646`). Confirmed
  `refreshMaintainedTable` does **not** re-acquire the exec mutex (the existing
  single-MV path already runs it inside `exec`'s held mutex), so holding the mutex
  once across the sweep is safe — no re-entrant deadlock. Holding it once (vs.
  per-MV) matches `exec`'s multi-statement-batch behavior; the implementer's open
  question on this reading is resolved: it is correct.
- **Commit-first invariant (load-bearing for MV-over-MV ordering).** Verified in
  `rebuildBacking` (`materialized-view-helpers.ts:1330-1385`): both arms swap
  *committed* state — the fast path via `host.replaceContents` (documented to swap
  committed contents; `begin; refresh; rollback` does not undo it) and the
  constraint-bearing arm via `conn.commit()`. So a base MV's backing is committed
  before a dependent's body re-reads it. The MV-over-MV chain test and the new
  diamond test both pin this (a wrong order leaves the dependent empty/stale).
- **`sourceBasesFor` ordering-key format (the implementer's flagged deviation).**
  Confirmed both branches yield lowercased `schema.table`: `planSourceBases` returns
  the plan's `sourceBases`, and the stale branch's `derivation.sourceTables` is stored
  lowercased-`schema.table` (cross-checked against the `table_modified` listener's
  `${schema}.${object}`.toLowerCase()` membership test at
  `database-materialized-views.ts:495,508`). The Kahn loop applies `.toLowerCase()`
  and compares to `mvKey` (also lowercased). Edges are therefore format-correct for
  both live and stale MVs. The deviation (recorded `sourceTables` vs. literal
  re-derivation from `selectAst`) is **sound and strictly more robust** — it never
  re-plans a stale body that may no longer plan, and produces identical edges.
  Accepted as-is.
- **Cycle backstop / empty catalog.** Cycle throws `INTERNAL` rather than silently
  dropping an MV; empty catalog returns `[]` with no mutex/transaction (test-pinned).
- **Docs.** `docs/materialized-views.md` § "Converging all materialized views" was
  read in full and accurately reflects the implementation (full-rebuild path, Kahn
  ordering, commit-first/not-atomic, mutex serialization caveat, `[]` no-op). No drift.

### Fixed inline (minor)

- **Added a diamond-DAG ordering test** (`mv-converge-all.spec.ts`) — one base `t`
  feeding two consumers `a`, `b` that re-converge into `c` (`a union b`). Pins Kahn's
  correctness with branching/join-point in-degrees, which the depth-2 chain did not
  exercise. The implementer flagged this as "a cheap, valuable addition." Spec is now
  6 cases; all pass.

### Observed — documented, not blocking (no new ticket)

- **Order built outside the mutex (narrow TOCTOU).** `materializedViewRefreshOrder()`
  runs before `_withMutex` (a deliberate optimization so an empty catalog takes no
  mutex). The build itself is synchronous (no yield), but the captured
  `MaintainedTableSchema[]` could go stale if another mutex holder drops/alters an MV
  during the `_acquireExecMutex()` await; a since-dropped MV would surface as
  `rebuildBacking`'s `INTERNAL` "not found during rebuild" rather than being skipped.
  Risk is low under the engine's single-writer/serialized-statement model and the sole
  intended caller (snapshot bootstrap) controls its own concurrency. A fully robust fix
  (rebuild the order inside the mutex) would complicate the empty-catalog fast path; the
  current tradeoff is acceptable and matches existing engine assumptions.
- **Untested combinations (gaps, not defects).** Sweep inside an explicit user `BEGIN`
  (commit-first parity is already pinned in
  `maintained-table-refresh-revalidation.spec.ts`); cross-schema / attached-schema MVs
  (ordering keys on `schema.table`, so should work); a *stale* MV-over-MV chain (ordering
  logic is identical regardless of staleness). None rise to "major" — the implementation
  is correct on the paths these would exercise.

### Validation

- `yarn workspace @quereus/quereus test` → **6165 passing / 9 pending** (full suite,
  `--bail`, includes the convergence spec).
- Convergence describe re-run after adding the diamond test → **6 passing**.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) → clean, exit 0.

No pre-existing failures encountered.

## End
