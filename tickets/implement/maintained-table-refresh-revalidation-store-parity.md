description: Store-backed parity coverage for the constraint-bearing `refresh materialized view` re-validation branch of `rebuildBacking`. Add a `using store` table-form maintained-table refresh case that exercises the `applyMaintenance('replace-all')` + `validateDeclaredConstraintsOverContents` + `conn.commit()` branch (the memory-only spec from `maintained-table-refresh-revalidation` never reaches it on a store backing).
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch (the code under test; read-only)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # the memory-backed spec to mirror
  - packages/quereus-store/test/mv-store-backing.spec.ts                   # store MV harness — add the constraint-bearing refresh case here
  - packages/quereus-store/src/common/backing-host.ts                      # StoreBackingHost.applyMaintenance('replace-all') (reads-own-writes path; read-only)
difficulty: medium
----

# Store-backed parity: constraint-bearing refresh re-validation

`rebuildBacking` (`packages/quereus/src/runtime/emit/materialized-view-helpers.ts:1330`)
has two arms. Constraint-less / MV-sugar backings take the `replaceContents` fast
path (no validation). A **table-form** maintained table that declares ≥1 applicable
CHECK or (FK-enforcement-on) child-side FK takes the constraint-bearing branch:

```
assertRefreshRowsAreSet → host.applyMaintenance(conn, [{kind:'replace-all', rows}])
  → validateDeclaredConstraintsOverContents(db, backing)   // throws BEFORE commit
  → conn.commit()
```

The landed memory spec
(`packages/quereus/test/maintained-table-refresh-revalidation.spec.ts`) exercises
this branch on **memory** backings only. The store MV harness
(`packages/quereus-store/test/mv-store-backing.spec.ts`) only covers
**constraint-less / MV-sugar** store backings via `create materialized view mv
using store …`, which never enters the branch.

This ticket adds a store-backed table-form case so the branch is pinned on the
store backing host. The point under test is that the bulk validation scan reads
the store connection's **pending** `replace-all` writes (reads-own-writes) before
commit — the same way memory does — so a violator in the recomputed set is caught
before it commits and the pre-refresh committed contents survive.

## Why low-risk (confirmed)

The attach core (`attachMaintainedDerivation`) already runs the *identical*
sequence on store backings and is store-tested; the only untested variable is the
**trigger** (refresh vs attach). `StoreBackingHost.applyMaintenance` supports the
`replace-all` op (`packages/quereus-store/src/common/backing-host.ts:171` →
`applyReplaceAll`), landing the diff in the coordinator's pending state;
`validateDeclaredConstraintsOverContents` is a plain table read of the backing
that observes effective (pending-over-committed) contents through the registered
attach connection. Syntax for a store-backed table-form maintained table is valid
(`create table mt (…) using store maintained as select …` — see
`packages/quereus-store/test/mv-rehydrate-adopt.spec.ts:229`). No defect is
expected; this is coverage hardening.

## Orchestration (mirror the memory spec's stale→drift flow)

The memory spec's flow, ported to a store backing:
  1. seed a clean row (row-time maintained into `mt`);
  2. body-relevant source change (`alter table src add column pad integer null`) →
     `mt` goes stale and its row-time plan detaches, so step 3 is NOT maintained in;
  3. drift a violator into the now-unmaintained source;
  4. `refresh materialized view mt` and assert the maintained-table-attributed
     CONSTRAINT diagnostic + intact pre-refresh committed contents + stays stale.

Use the harness's existing `db` / `provider` / `storeModule` `beforeEach`, the
`rows()` reader, and `expectThrows(fn, /regex/)`. Stale check:
`db.schemaManager.getMaintainedTable('main', mt)!.derivation.stale`.

## Edge cases & interactions

- **CHECK violator on the store backing.** A drifted CHECK-violating row in the
  recomputed set must throw the maintained-table-attributed diagnostic (memory
  spec matches `row derived into maintained table 'main.mt'`) BEFORE `conn.commit()`,
  leaving the pre-refresh committed store contents intact and `mt` stale. This is
  the primary case — it exercises the pending-layer reads-own-writes path on the
  store host specifically.
- **FK orphan on the store backing (FK enforcement on).** A drifted child-side FK
  orphan must throw the FK diagnostic (memory spec matches
  `references a missing 'main.parent'`). `parent` may be memory- or store-backed
  (the anti-join is a plain SQL query); keep `src` + `mt` `using store` so the
  backing under test is the store backing. Optional if it bloats the ticket, but
  preferred — pins that the FK bulk scan also reads pending store writes.
- **Clean drift commits.** A drift that violates nothing must succeed: the
  recomputed set commits to the store backing and `mt` clears stale. Confirms the
  branch is not failing-closed.
- **Pre-refresh contents are the COMMITTED store contents.** After a rejected
  refresh, re-read `mt` and assert it equals the seed row — the rejected pending
  `replace-all` was discarded by statement-level rollback, not committed to the
  store.
- **Commit-first parity (already covered for memory; spot-check store).** The
  branch ends in an explicit `conn.commit()`. The store harness already pins
  refresh-in-transaction / refresh-in-savepoint DDL-commit parity for the
  MV-sugar path (`mv-store-backing.spec.ts:296,328`); no need to re-derive it for
  the constraint-bearing branch unless trivially cheap — the memory spec's
  `commit-first parity` case already owns that assertion engine-wide.
- **Duplicate-derived-key reject (optional).** `assertRefreshRowsAreSet` runs
  before the pending reconcile. The store harness already has a NOCASE-PK
  collision case for the MV-sugar create-fill path
  (`mv-store-backing.spec.ts:452`); a refresh-triggered duplicate on the
  constraint-bearing store branch is in-scope only if it doesn't oversize the
  ticket.

## TODO

- Read `rebuildBacking` and `validateDeclaredConstraintsOverContents` in
  `materialized-view-helpers.ts` and the memory spec's `stale fast-path CHECK
  violation` + `stale fast-path child-side FK orphan` describe blocks so the store
  case mirrors their assertions exactly (same diagnostic substrings).
- Add a `describe('constraint-bearing refresh re-validation')` block to
  `packages/quereus-store/test/mv-store-backing.spec.ts` with: (a) a CHECK-violating
  stale drift that throws + leaves the committed store contents intact + stays
  stale; (b) a clean drift that commits + clears stale. Add the FK-orphan case if
  it fits comfortably.
- Build + run the store test file:
  `yarn workspace @quereus/quereus-store test 2>&1 | tee /tmp/store-mv.log; tail -n 60 /tmp/store-mv.log`
  (stream, never silent-redirect). Also run `yarn test` to confirm no regression in
  the engine spec.
- One-off `yarn test:store` pass (the LevelDB sqllogic re-run) was NOT run for the
  original ticket — run it here and capture the tail:
  `yarn test:store 2>&1 | tee /tmp/test-store.log; tail -n 80 /tmp/test-store.log`.
  If it exceeds the ~10-min agent idle window or surfaces a failure clearly outside
  this diff, follow the pre-existing-error protocol (write
  `tickets/.pre-existing-error.md`) and document the deferral rather than chasing it.
- Hand off to `review/` with a note on which optional cases (FK, duplicate-key)
  were included vs. deferred, and the `test:store` outcome.
