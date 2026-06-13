description: Review store-backed parity coverage for the constraint-bearing `refresh materialized view` re-validation branch of `rebuildBacking`. A new `describe('constraint-bearing refresh re-validation')` block in the store MV harness pins the `applyMaintenance('replace-all')` + `validateDeclaredConstraintsOverContents` + `conn.commit()` arm on the StoreBackingHost. Test-only change — no production code touched.
files:
  - packages/quereus-store/test/mv-store-backing.spec.ts                  # NEW block at lines 420-518 (the diff under review)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # the memory spec the store block mirrors (diagnostic substrings, stale→drift flow)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch (code under test; unchanged)
  - packages/quereus-store/src/common/backing-host.ts                     # StoreBackingHost.applyMaintenance('replace-all') → applyReplaceAll (reads-own-writes path; unchanged)
difficulty: easy
----

# Review: store-backed constraint-bearing refresh re-validation parity

## What landed

`rebuildBacking` (`materialized-view-helpers.ts:1330`) has two arms. Constraint-less
/ MV-sugar backings take the `replaceContents` fast path (no validation). A
**table-form** maintained table declaring ≥1 applicable CHECK or (FK-enforcement-on)
child-side FK takes the **constraint-bearing branch**:

```
assertRefreshRowsAreSet → host.applyMaintenance(conn, [{kind:'replace-all', rows}])
  → validateDeclaredConstraintsOverContents(db, backing)   // throws BEFORE commit
  → conn.commit()
```

Before this ticket the branch was exercised on **memory** backings only
(`maintained-table-refresh-revalidation.spec.ts`); the store MV harness only covered
constraint-less / MV-sugar store backings (`create materialized view … using store`),
which never enter the branch.

This change adds a `describe('constraint-bearing refresh re-validation')` block to
`packages/quereus-store/test/mv-store-backing.spec.ts` (**lines 420–518**) that drives
the branch on the StoreBackingHost via a **table-form** `using store` maintained table
(`create table mt (…) using store maintained as select … from src`). It is a
**test-only** change — no production source was modified. The point pinned: the bulk
validation scan reads the store connection's **pending** `replace-all` writes
(reads-own-writes) before commit — exactly as memory does — so a violator in the
recomputed set is caught before commit and the pre-refresh **committed** store
contents survive.

The block reuses the harness's existing `db`/`provider`/`storeModule` `beforeEach`,
the `rows()` reader, and `expectThrows(fn, /regex/)`. A local
`isStale(name) = getMaintainedTable('main', name)!.derivation.stale` mirrors the memory
spec's `isStale`. Each sub-block follows the memory spec's stale→drift flow: seed a
clean row (row-time maintained) → `alter table src add column pad` (marks `mt` stale +
detaches its row-time plan) → drift a violator into the now-unmaintained source →
`refresh materialized view mt` and assert.

## Cases included (all green)

- **CHECK violator on the store backing** (primary case — the pending-layer
  reads-own-writes path on the store host):
  - reject: a CHECK-violating drift throws `row derived into maintained table
    'main.mt'`, re-reading `mt` returns the **committed** seed row (rejected pending
    `replace-all` discarded by statement-level rollback), and `mt` stays stale.
  - clean: a conforming drift commits to the store backing and clears stale.
- **child-side FK orphan on the store backing** (FK enforcement on; `parent` also
  `using store`):
  - reject: an FK-orphan drift throws `references a missing 'main.parent'`, committed
    store contents intact, `mt` stays stale.
  - clean: an orphan-drift with a matching parent commits and clears stale.

Diagnostic substrings match the memory spec exactly (`row derived into maintained
table 'main.mt'`, `references a missing 'main.parent'`).

## Cases deliberately deferred (documented inline at lines 509–517)

- **Duplicate-derived-key reject** — DROPPED on purpose. `assertRefreshRowsAreSet`
  runs at the **engine** level **before** `host.applyMaintenance`, so it pins nothing
  store-host-specific (no pending `replace-all` write is reached). It is already owned
  engine-wide by the memory spec's `duplicate-key reject parity` block, and the store
  create-fill NOCASE-PK collision is covered at the harness's `using store(...) args:
  PK key collation` block. An attempted version with a fully-`using store` source also
  revealed that a store-default text PK keys under **NOCASE**, so the case-variant key
  (`'A'` vs `'a'`) collides on `src`'s **own** store PK and throws at the source
  insert — never reaching the refresh. That confirms the case is not about the store
  backing branch; the inline comment records this.
- **Commit-first parity for the constraint-bearing branch** — NOT re-derived. The
  harness already pins refresh-in-transaction / refresh-in-savepoint DDL-commit parity
  for the MV-sugar path (`mv-store-backing.spec.ts` `refresh` block), and the memory
  spec's `commit-first parity` case owns the engine-wide assertion. Per ticket
  guidance, not re-derived for the constraint-bearing branch.

## Validation performed

- `yarn workspace @quereus/store test` → **560 passing, 0 failing**. (Package name is
  `@quereus/store`, not `@quereus/quereus-store` as the original ticket's command read.)
  The log noise — rehydrate-skip warnings, `TransactionCoordinator` savepoint
  out-of-range warnings, and a `Data change listener error: boom` — all originate from
  **other** pre-existing tests (`events.spec.ts`, rehydrate specs) deliberately
  exercising error paths, not from the new block.
- `yarn test` (full workspace sweep) → all green: engine **6149 passing / 9 pending**,
  store **560 passing**, every other package passing, **zero failures**. (The
  `failingKv.iterate` line is a quereus-sync test injecting a KV failure on purpose;
  that package reports 184 passing.)
- `yarn test:store` (LevelDB sqllogic re-run) → **6145 passing, 13 pending, exit 0**,
  ~3 min wall-clock. Clean, well within the agent idle window. No pre-existing-error
  protocol needed.

## Reviewer focus / known gaps (treat tests as a floor)

- The store host's `applyReplaceAll` (`backing-host.ts:202`) lands the recomputed set
  in the coordinator's **pending** state, then `validateDeclaredConstraintsOverContents`
  reads effective (pending-over-committed) contents through the registered attach
  connection. The reject tests assert the committed seed survives, which implies the
  pending write was discarded — but they do **not** independently inspect the
  coordinator's pending stack or the LevelDB/InMemoryKVStore bytes mid-statement. If a
  reviewer wants a stronger guarantee that no partial bytes leaked to the physical
  store on rejection, a direct `provider.stores` byte-level assertion mid-rollback
  would add that (the harness exposes `provider.stores` and `catalogHas`).
- Both reject cases assert intact contents via a post-throw `select … from mt` re-read,
  which exercises the **read** path (effective contents = committed only). That is the
  observable contract the memory spec uses; it is not a white-box check of the pending
  layer.
- The new block runs only against the `InMemoryKVStore` provider the harness wires up
  (the isolated store module). The `test:store` LevelDB pass re-runs the engine
  sqllogic corpus, not this Mocha spec, so the **constraint-bearing refresh branch is
  not exercised against a real LevelDB backing** by this change — only against the
  in-memory KV provider. Coverage on a durable LevelDB provider would be a follow-up if
  desired (no defect expected — `applyReplaceAll` is provider-agnostic).
- No production code changed; risk is confined to the new test block.
