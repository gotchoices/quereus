description: Review the per-statement amortization of row-time MV maintenance. The DML generator now owns a per-statement BackingConnectionCache so each covering MV's backing connection is resolved ONCE per (statement, backing) instead of once per source row, while keeping per-row apply (no op-buffering) so within-statement covering-MV UNIQUE enforcement still sees earlier same-statement rows. Connection-caching + per-row apply (the ticket's recommended v1); op-coalescing deliberately NOT shipped.
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, docs/materialized-views.md
----

# Per-statement row-time maintenance batching — review handoff

## What shipped

Before this change `maintainRowTimeStructures` was called per source row from the DML
generators, and each call re-resolved the backing `MemoryTableConnection` by scanning
**all** of the Database's active connections (`getConnectionsForTable` →
`Array.from(...).filter(...)`) + lazy registration. On a bulk statement that scan was
paid N times. This change amortizes that resolution over the whole statement **without
changing visibility**:

1. **`core/database-materialized-views.ts`** — new exported type
   `BackingConnectionCache = Map<string, MemoryTableConnection>` (keyed by lowercased
   backing `schema.table`). `getBackingConnection(manager, qualifiedName, cache?)` now
   checks the cache first and populates it on a miss (whether it found an existing
   connection or lazily created+registered one). The optional `cache` is threaded
   through `maintainRowTime` → `applyMaintenancePlan` → `applyInverseProjection` →
   `getBackingConnection`, and through the MV-over-MV **cascade** recursion (so each
   chain level's backing amortizes too — the cache is keyed by backing base).

2. **`core/database.ts`** — `_maintainRowTimeCoveringStructures(sourceBase, change,
   cache?)` gained the optional cache and forwards it. The `DatabaseInternal` interface
   is **unchanged** (still the 2-arg form): the cold eviction callers
   (`store-table.ts`) keep using it, and TS structural typing allows the concrete method
   to carry an extra optional param.

3. **`runtime/emit/dml-executor.ts`** — each generator (`runInsert`/`runUpdate`/
   `runDelete`) creates one `BackingConnectionCache` at entry and threads it through the
   `processInsertRow`/`processUpdateRow`/`processDeleteRow` closures into every
   `maintainRowTimeStructures` call (6 call sites total).

**Per-row apply is preserved.** Only the connection *resolution* is amortized; each
row's ops are still applied immediately to the cached connection's pending layer. There
is **no** op-buffering / end-of-statement flush — so the central constraint holds (see
below). This is exactly the ticket's recommended v1 ("connection caching + per-row apply
on the cached connection").

## The central correctness constraint (verify this)

Covering-MV UNIQUE enforcement runs *inside* the source vtab's `update()`
(`checkUniqueViaMaterializedView` → `Database._lookupCoveringConflicts` →
`lookupCoveringConflicts`), which **scans the backing table** and relies on it
reflecting *every prior row of the same statement*. Because we kept per-row apply, a
later same-statement row's enforcement scan always observes an earlier row's backing
write. The key argument for why **caching the connection is sound**: within one
generator run nothing interleaves to change which connection a `select` from the MV (or
the enforcement scan) resolves to, so the cached connection is exactly what an uncached
re-resolution would return. The cold enforcement (`lookupCoveringConflicts`) and
REPLACE-eviction paths **omit** the cache and re-resolve the *same* connection
deterministically — they observe and contribute to the same pending layer.

**Reviewer focus:** confirm the within-statement connection-stability invariant. The
subtlest case is a nested FK-cascade DML statement: it gets its OWN generator + cache,
and resolves/reuses the same backing connection (connections are not torn down
mid-transaction), so the parent's cached connection is never invalidated. I believe this
holds; it deserves a second look.

## How to validate

- `yarn build` — full monorepo, **exit 0** (verifies quereus-store still compiles against
  the unchanged `DatabaseInternal`).
- `yarn workspace @quereus/quereus run lint` — **clean (exit 0)**.
- `yarn test` — full suite **green** (quereus: 3948 passing; all other workspaces pass;
  no `N failing` summary anywhere).
- Single-file iteration:
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "53-materialized-views-rowtime|54-covering-mv-enforcement"`
- Shared maintenance surface: `maintenance-equivalence.spec.ts` (the property oracle) +
  `covering-structure.spec.ts` — **70 passing**.
- Store path (shares the maintenance surface; backing is always memory): I ran **53 + 54
  under store mode** (`$env:QUEREUS_TEST_STORE='true'; ... --grep "53-materialized-views-rowtime|54-covering-mv-enforcement"`)
  — both green. Full `yarn test:store` deferred to CI (slow).

## Tests added (the floor — extend, don't trust as ceiling)

- **`53` §21 (new) — per-statement maintenance batching.** Bulk multi-row INSERT (5
  rows, one statement) → all in backing; bulk UPDATE (`set x = x + 100`, no WHERE) →
  every projected key moves; bulk DELETE (`where id <= 3`) → matching backing rows gone;
  transaction rollback of a bulk INSERT reverts the whole backing delta in lockstep;
  reads-own-writes BETWEEN statements within one explicit transaction; **bulk write
  through a 2-level MV-over-MV chain in one statement** (exercises the cache holding two
  backings at once).
- **`54` §9 (new) — the critical enforcement-visibility regression guard.** A duplicate
  buried deep in a bulk INSERT (rows 1..4 distinct, row 5 duplicates row 3): **ABORT**
  detects it via the covering MV's backing (which reflects the earlier same-statement
  rows) and the whole statement rolls back; **OR IGNORE** lands rows 1..4 and skips row
  5; **OR REPLACE** with an intra-statement duplicate evicts the just-written earlier row
  and the later row lands. These prove the cache did not hide an earlier same-statement
  row from a later row's enforcement scan.
- All new cases pass under BOTH memory (`yarn test`) and store (`yarn test:store`) modes.
  (`54` §9 asserts only source-table end-state, keeping it store-safe per the existing
  §1 caution about store-path eviction maintenance.)

## Honest gaps / divergences (review focus)

1. **Enforcement-path resolution is NOT amortized (deliberate v1 scope).** The cache is
   threaded only on the *maintenance* path. `lookupCoveringConflicts` (the per-row
   enforcement scan) and the REPLACE-eviction maintenance calls still re-resolve the
   backing connection via the per-row `getConnectionsForTable` scan. For a
   covering-enforcement MV under bulk INSERT, that resolution is therefore still O(N).
   Separately, the enforcement scan *itself* is a full backing-layer scan (a pre-existing
   O(N²)-on-bulk concern already flagged in `docs/materialized-views.md` § Covering
   structures as "a backing-PK prefix scan is a sound later optimization") — untouched
   here. Threading the cache across the vtab boundary into enforcement would be more
   invasive (crosses into quereus-store) and was out of scope; correctness is unaffected
   because the same connection resolves either way. **Candidate follow-up** if profiling
   shows the enforcement-path resolution is hot.

2. **No op-coalescing (layer 2/3) — by design.** v1 keeps per-row apply. True op-batching
   would risk the enforcement-visibility invariant and must NOT ship without either
   unioning the unflushed buffer in `lookupCoveringConflicts` or flushing-before-every-
   enforcement-read. The docs now state this explicitly so a future reader does not
   "optimize" per-row apply into a correctness bug. There is consequently **no residual
   buffer to flush at generator completion** — the TODO's "flush residual buffered ops"
   item is N/A for this realization (documented).

3. **The cache is allocated unconditionally per generator run**, even for non-covered
   tables (where `_hasRowTimeCoveringStructures` short-circuits before the cache is
   touched). That's one empty `Map` allocation per DML statement — negligible and not
   gated. Flag if you'd prefer it lazily created.

4. **Statement-savepoint rollback of batched writes needed no new plumbing.** Because the
   writes still land on the same connection's pending layer the statement savepoint
   covers, a statement/txn rollback reverts them in lockstep (asserted by `53` §21 bulk
   rollback; existing §13 covers savepoint lazy-attach). Confirm you agree no new
   transactional plumbing was required.

5. **No microbenchmark.** The win is structural (N connection-scans → 1 per backing per
   statement); I did not add a perf number. `bench/` exists if a number is wanted.

## Docs updated

- `docs/materialized-views.md` § *Synchronous, transactional, per-statement*: replaced
  the prior wording (which described an op-coalescing "accumulate ops and flush once at
  the statement boundary" model that did NOT ship) with what actually ships —
  connection-resolution amortization via `BackingConnectionCache` + per-row apply — and
  added an explicit **Enforcement-visibility invariant** callout (intra-statement
  duplicate detection; why a future end-of-statement buffer would break it; the
  between-statements + within-statement reads-own-writes guarantee). The existing
  semantic-edge-B cascade invariant (§ MV-over-MV cascade) was already consistent and
  left as-is.

## Regression gates confirmed green

Existing `53`/`54` sections, `maintenance-equivalence.spec.ts`, `covering-structure.spec.ts`,
and the whole memory suite (3948 passing) + all other workspaces. No
`.pre-existing-error.md` written — no unrelated failures surfaced.
