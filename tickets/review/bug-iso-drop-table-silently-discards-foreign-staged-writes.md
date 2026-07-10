---
description: When one connection drops a table while another still has unsaved changes to it, the second connection's save now fails with a clear error instead of quietly reporting success after its changes were thrown away.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# `drop table` poisons foreign staged overlays instead of sweeping them

## What changed

`IsolationModule.destroy` used to delete **every** `connectionOverlays` entry whose key suffix
matched the dropped table, across all database ids. A second connection with staged (uncommitted)
rows for that table would then commit against an empty overlay set, resolve successfully, and
persist nothing — silent cross-connection data loss.

`destroy` now partitions the matching overlay keys three ways:

| overlay | action |
|---|---|
| the dropping connection's own (`key === makeConnectionOverlayKey(db, …)`) | delete — it issued the DROP |
| foreign, `hasChanges === true` | **poison** (`state.poison = { message }`); keep the entry |
| foreign, `hasChanges === false` | delete — staged nothing, nothing lost |

`preOverlaySavepoints` is swept for every matching key whose overlay did **not** survive. A
surviving poisoned overlay keeps its set; the owning connection's `onConnectionRollback` reaps it
when its failed commit rolls back.

No downstream change was needed. `commitConnectionOverlays` already checks `state.poison` **before**
the `underlyingTables` lookup, so a poisoned overlay for a now-absent table raises the poison message
(`StatusCode.CONSTRAINT`) rather than the `INTERNAL` orphan error. `IsolatedTable.assertOverlayUsable`
already throws on `update` and on the merged branch of `query`, and still leaves the `readCommitted`
path alone.

New `IsolationModule.buildDropPoisonMessage(schemaName, tableName)` sits beside
`buildAlterPoisonMessage`. Both poison sources raise the same `StatusCode.CONSTRAINT`; they are told
apart by **message**, not code. An already-poisoned overlay keeps its original message across a DROP.

Ordering is unchanged and still load-bearing: `await this.underlying.destroy(...)` runs first, so a
throwing destroy leaves every map entry untouched.

### Files touched

- `packages/quereus-isolation/src/isolation-module.ts` — `destroy` rewritten;
  `buildDropPoisonMessage` added; doc comments on `destroy`, `commitConnectionOverlays`'s invariant
  paragraph, and `ConnectionOverlayState.poison` updated.
- `packages/quereus-isolation/src/isolated-table.ts` — three poison doc/comment sites generalized
  from "cross-connection ALTER" to "cross-connection ALTER or DROP TABLE". No logic change.
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — one test rewritten, four added.
- `docs/design-isolation-layer.md` — `destroy()` bullet under *Invariant: every staged overlay
  resolves to an underlying table at commit*; the *Open overlays are never orphaned* DDL bullet; the
  poison section renamed *ALTER / DROP overlay poison* and split into ALTER / DROP / Observing /
  Lifecycle subsections.

## How to validate

```
yarn workspace @quereus/isolation test    # 187 passing, 0 failing
yarn build                                # clean
yarn test                                 # full sweep, 0 failing
npx tsc -p packages/quereus-isolation/tsconfig.json --noEmit   # exit 0
```

Suite `orphaned overlays across DROP TABLE / RENAME TO` (`isolation-layer.spec.ts` ~line 1325) —
14 passing. Tests construct two `Database` instances sharing one `IsolationModule` (distinct db ids
⇒ distinct overlay keys) and inject the foreign overlay via `setConnectionOverlay`, exactly as the
cross-connection ALTER suite does.

### Use cases pinned

- **Foreign dirty overlay survives, poisoned, and its commit fails.**
  `DROP TABLE poisons another connection's staged overlay instead of discarding it` — asserts the
  overlay key survives, `poison` is set, the message contains `main.shared`, and
  `iso.commitConnectionOverlays(other)` rejects with `QuereusError` / `StatusCode.CONSTRAINT`.
  This is the reported bug; it fails on the pre-fix code at the first survival assertion.
- **Foreign clean overlay is deleted, not poisoned** — poisoning it would fail a commit with no
  staged rows to protect.
- **The dropping connection's own dirty overlay is discarded silently**, never poisoned, and its
  `preOverlaySavepoints` key is reaped.
- **Savepoint sets:** only the surviving poisoned overlay's set is kept; the dropping connection's
  and the clean foreign one's are reaped.
- **An already-poisoned (ALTER) foreign overlay keeps its original message across a DROP.**
- **`a failed underlying destroy leaves the overlay and underlying maps untouched`** still passes
  unchanged, as does `commitConnectionOverlays throws INTERNAL for a staged overlay with no
  underlying` (that guard is still reachable for a *rename*-orphaned, un-poisoned overlay).

## Known gaps — treat these as the floor, not the ceiling

- **No end-to-end SQL test of the poisoned commit.** Every cross-connection test in this file —
  pre-existing ALTER poison suite included — injects the foreign overlay with `setConnectionOverlay`
  and drives `iso.commitConnectionOverlays(other)` directly rather than issuing `commit` through a
  second `Database` doing real DML inside `begin`. I followed that precedent. The uncovered claim is
  that a real `begin; insert; …; commit` on connection B, with connection A dropping the table
  in between, surfaces the `CONSTRAINT` through the engine's commit loop. `IsolatedConnection.commit`
  calls `commitConnectionOverlays`, so it should, but it is not asserted.
- **Poison reap depends on a registered `IsolatedConnection` for the foreign table.** The surviving
  poisoned overlay and its savepoint set are cleared by `IsolatedTable.onConnectionRollback`. That
  fires only if the foreign connection registered an `IsolatedConnection` for that table — true when
  the overlay arose from real DML (`update` → `ensureConnection`), which the injected-overlay tests
  bypass. If some path can stage an overlay without registering a connection, a poisoned overlay
  would leak for the life of the `Database`. Not investigated.
- **Rollback-to-savepoint interaction is asserted only for ALTER poison,** not for drop poison. The
  existing `rollback to a post-overlay savepoint leaves the poison set` test covers the shared
  mechanism (poison lives on the `ConnectionOverlayState`, which `rollbackToSavepoint` does not
  replace), so drop poison inherits it by construction — but there is no drop-specific test.
- **Concurrency.** `destroy` mutates `connectionOverlays` while foreign connections may be mid-scan.
  The module clamps to `'reentrant-reads'`, and DROP TABLE was already mutating these maps before
  this change, so the exposure is unchanged — but this change makes an overlay *survive* a drop, so
  a foreign scan already inside `mergedQuery` when the drop lands will now merge against an overlay
  whose underlying table has been destroyed. Pre-fix it merged against a deleted overlay entry
  instead. Neither is obviously safe; neither is tested. Worth a reviewer's eye.
- **Tripwire parked, not filed:** the drop poison is deliberately over-strict for a foreign
  connection that unwinds *all* its staged rows past the drop (rollback to a post-overlay savepoint)
  and could arguably commit clean. Poison rides on the `ConnectionOverlayState`, not on the rows.
  Recorded as a `NOTE:` on `IsolationModule.destroy`'s doc comment, and in
  `docs/design-isolation-layer.md` § *DROP TABLE: discard, or poison*.

## Pre-existing, not mine

Two editor-only TypeScript diagnostics in `isolated-table.ts` / `isolation-module.ts`
(`tombstoneIndex` unused in `checkMergedPKConflict`, `_exhaustive` unused in `translateOverlayRow`).
Both are present at HEAD, both are outside this diff, and neither is a build or test failure —
`tsc --noEmit` on the package exits 0. Not reported to `.pre-existing-error.md` because they are not
test failures.
