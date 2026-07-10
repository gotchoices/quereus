---
description: When a connection adds a UNIQUE constraint or index in the middle of an open transaction, the check that looks for existing duplicate rows ignores the rows that same transaction just wrote, so duplicates slip through — and in one case a row is silently thrown away.
files:
  - packages/quereus/src/vtab/module.ts                        # VirtualTableModule.createIndex / .alterTable signatures
  - packages/quereus/src/vtab/table.ts                         # VirtualTable.createIndex signature
  - packages/quereus/src/vtab/memory/table.ts                  # MemoryTable.createIndex / alterTable forwarding
  - packages/quereus/src/vtab/memory/layer/manager.ts          # validateUniqueOverEffectiveRows @2876; call sites @2260, @2671, @2918
  - packages/quereus-store/src/common/store-module.ts          # createIndex @799, buildIndexEntries @~990, validateUniqueOverExistingRows @1143, addConstraint @1548, alterColumn @1684
  - packages/quereus-isolation/src/isolation-module.ts         # createIndex @870, dropIndex @906, migrateOverlayForDropIndex @942, alterTable @983, migrateOverlayForAlter @1245
  - packages/quereus-isolation/src/flush.ts                    # applyOverlayToUnderlying — existing overlay/underlying merge logic to reuse
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic   # the acceptance test
  - packages/quereus/test/logic.spec.ts                        # MEMORY_ONLY_FILES @39 — delete the 10.1.2 entry
  - docs/module-authoring.md                                   # § "DDL inside an open transaction" — the contract to extend
difficulty: hard
---

# Row-validating DDL under the isolation layer must see the issuing transaction's own rows

## What is broken

The isolation layer (`packages/quereus-isolation/`) gives each connection a private **overlay**:
an in-memory table holding the rows that connection has written but not yet committed. Reads by
that connection merge the overlay over the shared underlying table, so it sees its own writes.
The underlying table sees nothing of the overlay until commit.

`IsolationModule.createIndex` and `IsolationModule.alterTable` forward straight to the underlying
module. The underlying module dutifully validates *its own* rows — which are the committed rows
only. The transaction's own pending rows are invisible to it. Both bundled backends already
validate against their **effective** rows (committed merged with their own pending writes); that
machinery is simply unreachable here, because under isolation the pending rows are not in the
backend at all.

## Reproduction (confirmed)

Store module behind the isolation layer, in-memory KV provider. Each numbered section matches a
section of `packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic`, which passes on the
memory backend and is currently listed in `MEMORY_ONLY_FILES` **only** because of this bug.

| § | Scenario | Expected | Actual today |
|---|---|---|---|
| 1 | `begin; insert (1,'a'); insert (2,'a'); create unique index ix on t(v)` | `UNIQUE constraint failed` | index created |
| 2 | committed `(1,'a')`; `begin; insert (2,'a'); create unique index` | `UNIQUE constraint failed` | index created |
| 3 | `begin; insert (1,'a'); insert (2,'a'); alter table t add constraint u unique (v)` | `UNIQUE constraint failed` | **accepted, and row `(2,'a')` silently vanishes** |
| 4 | `begin; insert (1,'a'); create unique index; insert (2,'a')` | second insert fails | accepted; commit leaves `1 a / 2 a / 3 b` under a unique index |
| 5 | same as §4 but via `add constraint` | second insert fails | passes today (by accident — see below) |
| 6 | committed `(1,'a'),(2,'a')`; `begin; delete id=2; create unique index` | index built | `UNIQUE constraint failed` — spurious |
| 7 | two pending `NULL`s, `create unique index` | index built | passes |

Three distinct defects are tangled here.

### Defect A — validation reads the wrong row set (§1, §2, §3, §6)

The underlying module validates over its committed rows. It must instead validate over the rows
the **issuing connection** can see: committed rows, minus the ones its overlay tombstones,
superseded by the ones its overlay rewrote, plus the ones its overlay added. §1/§2/§3 are false
negatives (a duplicate the transaction staged is not seen). §6 is a false *positive*: the
duplicate the underlying trips over is a row the transaction has already deleted.

Note the asymmetry §6 exposes — this cannot be fixed by having the isolation layer pre-check the
merged view and then delegate unchanged. The underlying's own committed-row check would still
reject §6. The underlying has to be told which rows to judge.

### Defect B — the overlay never learns about the new constraint (§4)

After `createIndex` succeeds, the issuing connection's overlay is still the table built from the
pre-index schema, so its own UNIQUE check knows nothing about the new index. And
`IsolatedTable.findMergedUniqueConflict` only scans the *underlying* table — it can catch
"pending row collides with a committed row", never "pending row collides with another pending
row". That second case is the overlay's job, and the overlay is not equipped for it.

`alterTable` does not have this problem: `migrateOverlayForAlter` already rebuilds the overlay
under the post-alter schema, which is why §5 passes. `dropIndex` likewise rebuilds
(`migrateOverlayForDropIndex`). `createIndex` is the only DDL hook that skips the rebuild.

For symmetry the rebuild is also wanted for a **non-unique** `create index`: without it the
overlay has no such index, and a merged secondary-index scan later in the same transaction is
reading an overlay that cannot serve it.

### Defect C — overlay migration silently discards rows that violate a constraint (§3)

`MemoryTable.update` **returns** `{ status: 'constraint', … }`; it does not throw. Both overlay
rebuild loops ignore the returned `UpdateResult`:

- `migrateOverlayForAlter` — `isolation-module.ts:1273`
- `migrateOverlayForDropIndex` — `isolation-module.ts:954`

So in §3 the `add constraint` is accepted, `migrateOverlayForAlter` re-inserts row `(1,'a')` into
the new overlay, then re-inserts `(2,'a')`, gets a `constraint` status back, drops it on the
floor — and the transaction commits holding only row 1. This is silent data loss, and it is
reachable today by exactly the statement in §3. It must be fixed even independently of A and B.

## The fix

### 1. Let a wrapping module supply the rows that row-validating DDL judges

Add an optional row-source parameter to the two DDL hooks. Suggested shape, declared next to the
other vtab types in `packages/quereus/src/vtab/module.ts`:

```ts
/**
 * The rows the DDL-issuing connection can currently SEE — committed rows merged with that
 * connection's own uncommitted writes.
 *
 * Supplied only by a wrapper module (today: the isolation layer) that holds those pending rows
 * outside the target module, where the target module cannot reach them. When present, the target
 * module MUST use this stream for every row-CONTENT judgement it makes (UNIQUE duplicate
 * detection, collation-rekey collision detection) and MUST NOT reject the DDL over a duplicate
 * that exists only in its own committed data. Physical structures are still built from the
 * module's own rows.
 *
 * Re-callable: each call returns a fresh stream (a single ALTER may validate more than once).
 */
export type EffectiveRowSource = () => AsyncIterable<Row>;
```

Thread it through:

```ts
// VirtualTableModule
createIndex?(db, schemaName, tableName, indexSchema, rows?: EffectiveRowSource): Promise<void>;
alterTable?(db, schemaName, tableName, change, rows?: EffectiveRowSource): Promise<TableSchema>;

// VirtualTable (instance-level hook the isolation layer prefers for MemoryTable)
createIndex?(indexSchema, rows?: EffectiveRowSource): Promise<void>;
```

The engine's own emitters (`runtime/emit/create-index.ts`, `runtime/emit/alter-table.ts`) pass
nothing and keep today's behavior — each module falls back to its own effective stream.

**Memory backend.** Three call sites of `validateUniqueOverEffectiveRows`
(`layer/manager.ts:2260` createIndex, `:2671` addConstraint, `:2918` alterColumn SET COLLATE).
When `rows` is supplied, dedupe over that async stream instead of the manager's own effective
rows. The helper becomes async. `BaseLayer.addIndexToBase` already tolerates building over rows a
validation pass rejected — see its own docstring at `layer/base.ts:134` — so nothing else moves.

**Store backend.** Same three sites (`store-module.ts:799` createIndex via `buildIndexEntries`'s
inline `seen` set, `:1561` addConstraint, `:1836` alterColumn SET COLLATE). Store is the awkward
one: its `createIndex` dup check lives *inside* `buildIndexEntries`, interleaved with writing the
index store. Split it:

- `validateUniqueOverExistingRows` already takes an `AsyncIterable`; generalize it (or add a
  row-taking sibling) so it can consume `EffectiveRowSource` rows as well as `KVEntry` values.
- Give `buildIndexEntries` a flag to skip its `seen` dup check. When `rows` is supplied,
  `createIndex` validates over `rows` first (before `getIndexStore`, so a rejection leaves no
  index-store directory behind), then builds with the check disabled.

Building the physical index over the module's committed rows while validating over the merged
view is deliberate and already sound: `store-module.ts:838` and `base.ts:134` both document that
an index entry with no live row behind it is harmless — every reader resolves an entry back to
its live row and drops it if the row is gone. §6's index therefore holds a stale entry for the
row the transaction deletes, until the commit flush deletes both.

### 2. Isolation layer: build the merged stream, rebuild the overlay

In `IsolationModule`, add a private `effectiveRowsFor(underlyingTable, overlayState)` that yields
the issuing connection's merged view:

- read the overlay's rows once into a map keyed by a serialized primary key (the overlay is
  bounded by the transaction's own write set, so this is the same working set `flush.ts`
  already materializes);
- stream `underlyingTable.query(fullScan)`, skipping any row whose PK is in the map (tombstoned →
  dropped; rewritten → the overlay's version wins);
- then yield each non-tombstone overlay row, tombstone column stripped.

`flush.ts`'s `applyOverlayToUnderlying` walks the same two streams — factor the shared
tombstone/PK handling out rather than writing it twice.

Then:

- **`createIndex`** — resolve the issuer's overlay (`makeConnectionOverlayKey`); if it exists and
  `hasChanges`, pass `effectiveRowsFor(...)` down. After the underlying returns, refresh
  `underlyingState.underlyingTable.tableSchema` to the post-index schema exactly as `alterTable`
  does at `isolation-module.ts:1057` (memory's instance-level `createIndex` and
  `StoreTable.updateSchema` both already refresh it; assert rather than assume), then rebuild
  every non-poisoned overlay under it. Generalize `migrateOverlayForDropIndex` — the column layout
  is unchanged in both directions, only the index/constraint set moves — into one
  `rebuildOverlayForIndexChange` used by `createIndex` and `dropIndex`.

- **`alterTable`** — pass the same row source to `underlying.alterTable`. Tier-2
  pre-validation (`validateOverlayMigration`) stays as-is; the underlying's own rowSource-driven
  check now fires *before* it mutates anything, so the atomic-abort guarantee in `alterTable`'s
  docstring still holds.

- **Only the issuing connection's overlay feeds validation.** A foreign connection's overlay may
  hold colliding rows; that is its problem when it commits, exactly as an ordinary concurrent
  duplicate insert would be. Do not widen this into cross-connection constraint checking.

### 3. Overlay rebuild must not eat rows (Defect C)

Every `newOverlayTable.update(...)` in a rebuild loop must inspect the returned `UpdateResult`:

- **Issuer's own overlay** — a `constraint` status is unreachable, because the rowSource
  validation in step 1 already judged a superset of these rows. Throw `StatusCode.INTERNAL` with a
  message naming the table and the constraint: it means validation and migration have drifted.
- **Foreign overlay** — a `constraint` status poisons that overlay and leaves it unmigrated,
  mirroring the existing tier-3 NOT-NULL handling at `isolation-module.ts:1072-1084`. Extend
  `buildAlterPoisonMessage` (or add a sibling) to name a UNIQUE violation; today it only speaks
  about `addColumn` NOT NULL.
- Any other non-`ok` status (`ignore` suppression cannot arise here — the rebuild passes no
  `onConflict`) is likewise `INTERNAL`.

## Acceptance

`packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic` is already in the tree and
already passes on memory. Delete its entry from `MEMORY_ONLY_FILES`
(`packages/quereus/test/logic.spec.ts:39`, along with the three-line comment above it explaining
why it was excluded) and make store mode pass.

Run: `yarn workspace @quereus/quereus test:store` (streams; ~minutes) and `yarn test`.
A focused loop while iterating:

```
QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts --grep 10.1.2
```

Note the sqllogic runner bails at the first mismatch, so it reports one section at a time. A
seven-section probe against `createIsolatedStoreModule` + `InMemoryKVStore` (the harness in
`packages/quereus-store/test/isolated-store.spec.ts`) shows all sections at once and is much
faster to iterate on — worth recreating locally.

Also add a regression test to `packages/quereus-store/test/isolated-store.spec.ts` for Defect C
specifically: the row-loss path is invisible to a test that only asserts the DDL raised.

## Out of scope

`ALTER COLUMN … SET COLLATE` on a **primary-key** member re-keys the underlying's committed rows
and can collide there (`recreatePrimaryTreeWithNewColumn` / `StoreTable.rekeyRows`). Overlay rows
are not part of that collision check, so the same class of hole exists on the PK-rekey path. It is
not exercised by `10.1.2` and `41.7.1-alter-column-collate-unique.sqllogic` passes today. If the
rowSource plumbing makes it cheap to close, close it; otherwise leave a `NOTE:` at the rekey site
rather than growing this ticket.

## TODO

Phase 1 — plumb the row source

- [ ] Add `EffectiveRowSource` to `packages/quereus/src/vtab/module.ts`; extend
      `VirtualTableModule.createIndex` / `.alterTable` and `VirtualTable.createIndex`.
- [ ] Memory: make `validateUniqueOverEffectiveRows` async and rowSource-aware; wire its three
      call sites; forward the parameter through `MemoryTable`.
- [ ] Store: hoist `createIndex`'s dup check out of `buildIndexEntries` (flag to skip `seen`);
      make `validateUniqueOverExistingRows` consume either a `KVEntry` stream or an
      `EffectiveRowSource`; wire `createIndex`, `addConstraint`, `alterColumn` SET COLLATE.
- [ ] Confirm `yarn test` and `yarn test:store` are unchanged — this phase alters no behavior.

Phase 2 — isolation layer

- [ ] Extract the overlay/underlying merge walk shared with `flush.ts`; add
      `IsolationModule.effectiveRowsFor(...)`.
- [ ] `createIndex`: pass the row source, refresh the cached underlying `tableSchema`, rebuild
      every non-poisoned overlay (generalize `migrateOverlayForDropIndex`).
- [ ] `alterTable`: pass the row source to `underlying.alterTable`.
- [ ] Both rebuild loops: check `UpdateResult.status` — `INTERNAL` for the issuer, poison for a
      foreign overlay. Extend the poison message for UNIQUE.

Phase 3 — tests and docs

- [ ] Delete the `10.1.2-ddl-in-transaction.sqllogic` entry (and its comment) from
      `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`.
- [ ] Add an `isolated-store.spec.ts` case asserting no row is lost when `add constraint … unique`
      is rejected over pending rows.
- [ ] Extend `docs/module-authoring.md` § "DDL inside an open transaction" with the
      `EffectiveRowSource` contract: who supplies it, what the receiver may and may not reject on.
- [ ] `yarn lint`, `yarn test`, `yarn workspace @quereus/quereus test:store`.
