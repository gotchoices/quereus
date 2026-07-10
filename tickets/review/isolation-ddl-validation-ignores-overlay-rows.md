---
description: Adding a UNIQUE constraint or index mid-transaction now sees the rows that transaction has written but not yet committed, so duplicates are rejected instead of slipping through — and a rejected change no longer throws away a row.
files:
  - packages/quereus/src/vtab/module.ts                         # NEW: EffectiveRowSource; createIndex/alterTable gained an optional rows param
  - packages/quereus/src/vtab/table.ts                          # VirtualTable.createIndex gained the same param
  - packages/quereus/src/index.ts                               # exports EffectiveRowSource, serializeKeyNullGrouping
  - packages/quereus/src/vtab/memory/layer/base.ts              # populateIndexFromRowsAsync + shared addRowToIndex
  - packages/quereus/src/vtab/memory/layer/manager.ts           # validateUniqueOverEffectiveRows now async + rowSource-aware; 3 call sites
  - packages/quereus/src/vtab/memory/table.ts                   # MemoryTable.createIndex forwards rows
  - packages/quereus/src/vtab/memory/module.ts                  # module-level createIndex/alterTable forward rows
  - packages/quereus-store/src/common/store-module.ts           # createIndex validates up front; buildIndexEntries skip flag; assertNoDuplicateRows/indexDedupeNormalizers/rowsFromEntries
  - packages/quereus-isolation/src/overlay-rows.ts              # NEW: collectOverlayEntries, makePkKeySerializer, iterateEffectiveRows
  - packages/quereus-isolation/src/flush.ts                     # now reuses collectOverlayEntries
  - packages/quereus-isolation/src/isolation-module.ts          # effectiveRowsFor/issuerEffectiveRows; createIndex rebuild; insertIntoRebuiltOverlay; adoptRebuiltOverlay
  - packages/quereus-isolation/src/isolated-table.ts            # instance createIndex/dropIndex now delegate to the module
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic   # acceptance test, now runs in store mode
  - packages/quereus/test/logic.spec.ts                         # 10.1.2 removed from MEMORY_ONLY_FILES
  - packages/quereus-store/test/isolated-store.spec.ts          # 3 new tests: rejected DDL loses no staged row
  - packages/quereus-isolation/test/isolation-layer.spec.ts     # 1 new test: foreign overlay poisoned, not truncated
  - docs/module-authoring.md                                    # § "When the pending rows live outside your module"
  - docs/memory-table.md                                        # § DDL and transactions — wrapper-supplied rows
difficulty: hard
---

# Row-validating DDL under the isolation layer now sees the issuing transaction's own rows

## What was wrong, in plain terms

The isolation layer gives each connection a private staging area (an "overlay") holding the rows
it has written but not yet committed. When that connection ran `create unique index` or
`alter table … add constraint … unique`, the check for existing duplicate rows ran inside the
*underlying* storage module, which can only see committed rows. Three distinct defects fell out:

*   **A — wrong row set.** A duplicate the transaction had just inserted was invisible, so the
    constraint was created over data that violates it. Symmetrically, a duplicate the transaction
    had already *deleted* was still visible, so a perfectly legal index build was rejected.
*   **B — the new constraint was not enforced afterwards.** The overlay was built from the
    pre-index schema, so a second colliding insert later in the same transaction was accepted.
*   **C — silent row loss.** `MemoryTable.update` *returns* `{status: 'constraint'}` rather than
    throwing it. The overlay-rebuild loops ignored that return value, so a row the new schema
    rejected was dropped on the floor and the transaction committed without it.

## What was built

**A new optional parameter, `EffectiveRowSource`.** `VirtualTableModule.createIndex` and
`.alterTable` (and `VirtualTable.createIndex`) now take an optional `() => AsyncIterable<Row>`.
It is supplied only by a wrapper module that holds the issuing connection's pending rows outside
the target module. When present, the target module must judge *that* stream for every
row-content decision, and must not reject the DDL over a duplicate that exists only in its own
committed data. The engine's own emitters pass nothing, so unwrapped modules behave exactly as
before. Contract documented in `docs/module-authoring.md`.

**Both bundled backends honor it.** Memory: `validateUniqueOverEffectiveRows` became async and
prefers the supplied rows over `effectiveDdlRows()`; wired at all three call sites (createIndex,
addConstraint, alterColumn SET COLLATE). Store: `createIndex`'s duplicate check was hoisted out
of `buildIndexEntries` (which now takes a `skipDuplicateCheck` flag) and runs *before*
`getIndexStore`, so a rejection leaves no index-store directory behind;
`validateUniqueOverExistingRows` now consumes rows rather than KV entries, with `rowsFromEntries`
adapting the existing call sites.

Building the physical index from the module's own committed rows while validating over the merged
view is deliberate: an index entry with no live row behind it is harmless, because every reader
resolves an entry back to its live row and drops it if the row is gone. Both modules already
documented this at their build sites.

**The isolation layer supplies the stream and rebuilds its overlays.** `overlay-rows.ts` (new)
holds the shared overlay/underlying merge walk — `collectOverlayEntries` is now also used by
`flush.ts`, replacing a duplicate copy. `IsolationModule.createIndex` passes the issuer's merged
view down, asserts the underlying refreshed its cached `tableSchema`, then rebuilds every
non-poisoned overlay under the post-index schema (which is what fixes B, and what gives a later
merged secondary-index scan an overlay that can serve it). `dropIndex` shares that rebuild.
`alterTable` passes the same row source down.

**Defect C is closed with a typed failure.** `insertIntoRebuiltOverlay` converts a returned
`constraint` status into a throw. `adoptRebuiltOverlay` then routes it: for the *issuing*
connection it is `StatusCode.INTERNAL` (the DDL's own validation pass judged a superset of those
rows and accepted them, so validation and migration have drifted); for a *foreign* connection it
poisons that one overlay, which is a real and legitimate outcome — its staged rows may violate a
constraint another connection just declared. A failed rebuild leaves the old overlay installed
whole, never with a row missing.

Only the **issuing** connection's overlay feeds validation. A foreign connection's staged
duplicates are its own problem at commit, exactly as a concurrent duplicate insert would be.

## Use cases to exercise

The acceptance test `packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic` is now
removed from `MEMORY_ONLY_FILES` and runs against both backends. Its seven sections:

| § | Scenario | Expected |
|---|---|---|
| 1 | `begin; insert (1,'a'); insert (2,'a'); create unique index` | `UNIQUE constraint failed` |
| 2 | committed `(1,'a')`; `begin; insert (2,'a'); create unique index` | `UNIQUE constraint failed` |
| 3 | `begin; insert (1,'a'); insert (2,'a'); add constraint unique` | `UNIQUE constraint failed`, **no row lost** |
| 4 | `begin; insert (1,'a'); create unique index; insert (2,'a')` | second insert fails |
| 5 | same as §4 via `add constraint` | second insert fails |
| 6 | committed dup; `begin; delete the dup; create unique index` | index builds (no spurious rejection) |
| 7 | two pending `NULL`s; `create unique index` | index builds (multiple NULLs are distinct) |

Beyond the sqllogic (which can only observe that the DDL raised), four white-box tests:

*   `isolated-store.spec.ts` → "row-validating DDL over an open transaction" — three cases
    asserting a **rejected** `ADD CONSTRAINT UNIQUE` / `CREATE UNIQUE INDEX` leaves *both* staged
    rows readable and the transaction usable, and that an **accepted** `CREATE UNIQUE INDEX`
    rebuilds the overlay preserving both live rows and tombstones, then enforces the new index.
*   `isolation-layer.spec.ts` → "poisons a foreign overlay whose staged rows violate a newly
    created UNIQUE index" — the one test that actually reaches the Defect C guard, asserting the
    foreign overlay is poisoned (not truncated), still holds both rows, and fails its commit.

## Validation performed

*   `yarn build` — clean.
*   `yarn lint` — clean (this also type-checks `packages/quereus` test files).
*   `yarn test` — 6802 + 191 + 901 + 450 + … passing, **0 failing**.
*   `yarn workspace @quereus/quereus test:store` — **6797 passing, 0 failing**, 14 pre-existing
    pending. Confirmed `10.1.2-ddl-in-transaction.sqllogic` executes under the real LevelDB store
    behind the isolation layer, not just the in-memory KV harness.

## Known gaps — please probe these

*   **The issuer-side Defect C guard is unreachable by construction, so it is untested.** Only
    the foreign-overlay arm has a test. The INTERNAL branch is defense-in-depth: if you can
    construct a case where the issuer's rebuild trips a constraint the row-source validation
    accepted, that is a real bug in the validation, not in the guard.
*   **`ALTER COLUMN … SET COLLATE` on a PRIMARY KEY member is still holed** (explicitly out of
    scope in the source ticket). The wrapper's staged rows are re-keyed inside its own overlay
    and the module's inside its own store, so a pending row that collides with a committed one
    *only under the new collation* is checked by neither side. `NOTE:` comments sit at both
    re-key sites (`store-module.ts` PK-rekey branch, `manager.ts` `validateRekeyedPrimaryKey`
    call) and the gap is stated in `docs/module-authoring.md`. It is not exercised by any test.
    Note that with Defect C closed, a case that previously lost a row silently now raises
    `INTERNAL` — louder, still not correct.
*   **`IsolatedTable.createIndex` / `.dropIndex` behavior changed.** They were dead code
    (nothing in-tree calls the instance-level hooks; the engine reaches the module) that drove
    the underlying and overlay directly, skipping both the row source and the overlay rebuild. I
    rerouted them through `IsolationModule`, so a hypothetical outer wrapper gets the same
    protocol. Worth a second opinion on whether they should exist at all.
*   **Foreign overlays are never validated, only rebuilt.** By design, and documented — but it
    means `create unique index` can succeed while another open transaction holds staged rows that
    violate it. That transaction is poisoned and must roll back. Confirm that is the semantics we
    want versus failing the DDL.
*   **`makePkKeySerializer` uses `serializeKeyNullGrouping`, not `serializeRowKey`.** PK columns
    are NOT NULL in practice, but the null-poisoning variant would collapse a degenerate nullable
    PK to a single bucket. Worth a look if you disagree about which is safer here.
*   `serializeKeyNullGrouping` is newly exported from `@quereus/quereus`; it was previously
    internal.

## Tripwires parked (not tickets)

*   `isolation-module.ts` `effectiveRowsFor` — each call re-materializes the overlay and re-scans
    the underlying. `alter column … set collate` calls once per covering UNIQUE constraint. Fine
    now; `NOTE:` at the site says to share one PK map across the calls if it ever shows up as slow.

## Separate defect found and filed

`tickets/backlog/bug-set-not-null-ignores-uncommitted-rows.md` — `alter column … set not null`
inside an open transaction ignores that transaction's own pending rows and accepts a change that
leaves a NULL under a NOT NULL column. Reproduced on **both** backends (so it is not an isolation
bug), which is why it was not folded into this ticket. Same shape as Defect A; `effectiveDdlRows()`
and the new `EffectiveRowSource` parameter are both already in place to fix it.
