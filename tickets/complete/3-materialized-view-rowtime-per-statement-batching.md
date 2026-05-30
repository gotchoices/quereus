description: Per-statement amortization of row-time MV maintenance. The DML generators own a per-statement BackingConnectionCache so each covering MV's backing connection is resolved once per (statement, backing) instead of once per source row, while keeping per-row apply (no op-buffering) so within-statement covering-MV UNIQUE enforcement still observes earlier same-statement rows. Connection-caching + per-row apply (the recommended v1); op-coalescing deliberately NOT shipped. Reviewed and completed.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, docs/materialized-views.md
----

# Per-statement row-time maintenance batching — completed

## Summary

`maintainRowTime` was previously called per source row, re-resolving the backing
`MemoryTableConnection` each time by scanning **all** the Database's active connections
(`getConnectionsForTable`) + lazy registration — paying that scan N times on a bulk
statement. This change introduces a per-statement `BackingConnectionCache`
(`Map<lowercased backing schema.table, MemoryTableConnection>`) created once per DML
generator run and threaded through `maintainRowTime → applyMaintenancePlan →
applyInverseProjection → getBackingConnection` (and through the MV-over-MV cascade), so
each backing's connection is resolved at most once per statement.

**Per-row apply is preserved** — only connection *resolution* is amortized; each row's
ops still land immediately on the cached connection's pending layer. There is no
op-buffering / end-of-statement flush, so the enforcement-visibility invariant holds (a
later same-statement row's enforcement scan observes earlier rows' backing writes).

This is the implement-stage work (commit `ca31c1ae`); the review pass below validated it
and corrected/added one test.

## Review findings

### What was checked

- **Implement diff, fresh eyes** — read all five touched source/test files plus the docs
  change before the handoff summary: `database-materialized-views.ts` (the
  `BackingConnectionCache` type, threading through `maintainRowTime` /
  `applyMaintenancePlan` / `applyInverseProjection`, and the cache hit/miss logic in
  `getBackingConnection`), `database.ts` (`_maintainRowTimeCoveringStructures` optional
  `cache` param), `dml-executor.ts` (6 maintenance call sites across
  runInsert/runUpdate/runDelete, each threading a generator-owned `new Map()`), the
  `53` §21 / `54` §9 test additions, and `docs/materialized-views.md`.
- **Connection-stability correctness argument** — traced the per-row order (enforcement
  scan → source write → maintenance) and confirmed: the backing connection is lazily
  created + registered on first use and persists for the statement; subsequent *uncached*
  enforcement scans (`lookupCoveringConflicts`, which deliberately omits the cache) and
  *cached* maintenance calls both resolve the **same** persisted connection object;
  connections are not torn down mid-statement; the cascade threads the same cache (each
  level keyed by its own backing base); a nested FK-cascade DML statement gets its own
  generator+cache but still resolves the same persisted backing connection, so the
  parent's cached connection is never invalidated. Caching is therefore behaviorally
  identical to uncached re-resolution. **Holds.**
- **Type surface** — `_maintainRowTimeCoveringStructures` is declared on the
  `DatabaseInternal` interface as the **2-arg** form (`database-internal.ts:123`); the
  concrete `Database` method carries the optional 3rd `cache` param, and structural typing
  lets that satisfy the interface. Both omit-cache call sites type-check against the 2-arg
  interface form: the store path (`store-table.ts`, via `this.db as DatabaseInternal`) and
  the memory REPLACE-eviction path (`vtab/memory/layer/manager.ts:1095`). `dml-executor.ts`
  is typed against the concrete `Database` (`runtime/types.ts:15`) and calls the 3-arg
  cache-aware form. `yarn build` clean (0 TS errors).
- **Enforcement-visibility invariant** — confirmed covering-UNIQUE enforcement runs on the
  UPDATE path as well as INSERT: `manager.performUpdate` and
  `performUpdateWithPrimaryKeyChange` both call
  `checkUniqueConstraints → checkSingleUniqueConstraint → checkUniqueViaMaterializedView`,
  which scans the MV backing for prior same-statement rows
  (`vtab/memory/layer/manager.ts`). The `53` §21 / `54` §9 additions and the corrected
  §10 (below) all pass.

### What was found & done

- **Major-leaning, caught and fixed: a handed-off test claim did not match reality —
  `54` §9's INSERT-only coverage left the UPDATE enforcement path unguarded, and my first
  attempt to add it used SQL Quereus does not parse.** The UPDATE generator threads the
  same `BackingConnectionCache` and the UPDATE path enforces covering UNIQUE, yet §9 only
  exercised INSERT (ABORT/IGNORE/REPLACE). I added a §10 UPDATE guard — but my initial
  version used `update or ignore` / `update or replace`, which **Quereus' parser rejects**
  (`updateStatement` has no `OR <conflict>` clause; only INSERT carries one — verified in
  `parser.ts:2033`). That surfaced a transport glitch in this session that briefly
  reported a phantom "passing" for the unparseable file; a clean sequential re-run gave
  the true `QuereusError: Expected table name` at the `update or ignore` line. **Fixed**:
  §10 is now ABORT-only (the sole conflict mode UPDATE supports syntactically) — a single
  bulk `update ... where id in (1,2)` that moves two rows onto the same covered value,
  asserting the statement aborts (order-independent: a broken cache that hid the earlier
  same-statement update would let both rows reach the value instead of aborting). Asserts
  source end-state only (store-safe). **Verified green under both memory and store.**
  Diff: `54-covering-mv-enforcement.sqllogic`, +24 lines.

- **Documented v1 divergences re-confirmed as deliberate, no action** — the handoff's
  honest-gaps list checks out: (1) the per-row *enforcement* connection resolution and the
  REPLACE-eviction path intentionally omit the cache and re-resolve the same connection
  deterministically (amortizing across the vtab boundary into quereus-store was out of
  scope; correctness unaffected); (2) no op-coalescing — per-row apply is required to keep
  the enforcement-visibility invariant, and the docs now explicitly warn future readers
  against "optimizing" it into a correctness bug; (3) the cache is allocated
  unconditionally per generator run (one empty `Map` for non-covered tables — negligible);
  (4) statement/txn rollback needs no new plumbing (writes land on the savepoint-covered
  pending layer; asserted by `53` §21 bulk rollback). All correctly captured in the ticket
  and `docs/materialized-views.md`.

- **Nits noted, not changed** — the three generators each repeat
  `const backingConnCache: BackingConnectionCache = new Map();` with an identical comment
  (acceptable given the closures' distinct signatures); the unconditional allocation could
  be lazily gated behind `_hasRowTimeCoveringStructures`, but the win is immaterial.
  Neither warrants churn (a separate in-flight `implement/rowtime-mv-minor-cleanups`
  ticket already tracks polish in this area).

### Empty categories (explicit)

- **New tickets filed: none.** The §9/UPDATE-path gap was a *minor* test omission fixed
  inline (§10), not a code defect — no `fix/`, `plan/`, or `backlog/` ticket warranted.
  The correctness argument holds; no behavioral defect was found in the shipped code.
- **Performance: no regression, no benchmark added.** The change is a structural win
  (N connection-scans → 1 per backing per statement); the implementer deferred a
  microbenchmark to `bench/` and that deferral stands. The pre-existing enforcement-scan
  O(N²)-on-bulk concern (a full backing-layer scan per row) is untouched and remains
  documented in `docs/materialized-views.md` as a sound later optimization — out of scope.
- **Docs: verified current.** `docs/materialized-views.md` § *Synchronous, transactional,
  per-statement* describes what actually ships (connection-resolution amortization +
  per-row apply) and carries the Enforcement-visibility invariant callout; the prior
  wording (an op-coalescing model that did not ship) is gone. Consistent with the code.
- **No `.pre-existing-error.md` written** — no unrelated failures surfaced.

### Validation (this pass)

- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn build` — exit 0, 0 `error TS`.
- Full quereus suite (`test/**/*.spec.ts`) — **3948 passing, 0 failing**.
- File `54` (incl. new §10) — green under **memory** and **store** modes.
