---
description: When one connection drops a table while another still has unsaved changes to it, the second connection's save must now fail with a clear error instead of quietly reporting success after its changes were thrown away.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# `drop table` must poison, not silently sweep, foreign staged overlays

## Reproduced

A temporary spec (two `Database` instances sharing one `IsolationModule`, foreign overlay injected
via `setConnectionOverlay` exactly as the cross-connection ALTER suite does) confirmed the bug:

```
await dbA.exec('drop table t');
iso.getConnectionOverlay(dbB, 'main', 't')   // undefined — swept
await iso.commitConnectionOverlays(dbB);     // resolves; nothing thrown, nothing persisted
```

`IsolationModule.destroy` (`isolation-module.ts:773`) deletes every `connectionOverlays` /
`preOverlaySavepoints` entry whose key suffix matches the dropped table, across all db ids. The
foreign connection then commits against an empty overlay set and succeeds.

## Design

Reuse the existing poison mechanism verbatim — nothing new is needed downstream:

- `ConnectionOverlayState.poison?: { message: string }` already exists.
- `commitConnectionOverlays` already checks `state.poison` **before** the `underlyingTables`
  lookup and throws `StatusCode.CONSTRAINT` (`isolation-module.ts:466`). A poisoned overlay for a
  table with no underlying therefore raises the poison error, not the `INTERNAL` orphan error.
  **No change to `commitConnectionOverlays` logic is required.**
- `IsolatedTable.assertOverlayUsable` (`isolated-table.ts:170`) already throws the poison message on
  `update` and on the merged branch of `query`, and leaves the `readCommitted` path alone.
- `alterTable` and `dropIndex` already skip poisoned overlays; `renameTable` re-keys the state
  object in place, carrying `poison` along.

So the whole fix lives in `destroy()`. New behaviour, per overlay key matching the dropped table:

| overlay | action |
|---|---|
| the **dropping** connection's own (`key` starts with its `<dbId>:`) | delete — it asked for the drop |
| a **foreign** overlay with `hasChanges === true` | **poison**; keep the entry |
| a **foreign** overlay with `hasChanges === false` | delete — it staged nothing, nothing is lost |

`preOverlaySavepoints`: delete every matching key **except** those whose overlay survives as
poisoned. A surviving poisoned overlay's savepoint set is still consulted by `ensureOverlay`
padding and is reaped by the owning connection's `onConnectionRollback`
(`clearPreOverlaySavepoints`), which fires when its failed commit rolls back.

### Answers to the ticket's open questions

- **Dropping connection's own overlay** — silently discarded, as today. It issued the DROP; there is
  no one to tell.
- **Status code** — reuse `StatusCode.CONSTRAINT`, the code the ALTER poison already raises. Both
  `assertOverlayUsable` and `commitConnectionOverlays` throw it unconditionally off `state.poison`,
  so reusing it means zero call-site changes and one uniform "your transaction must roll back"
  signal. Distinguish the two causes by **message**, not by code — add a `buildDropPoisonMessage`
  next to `buildAlterPoisonMessage` (`isolation-module.ts:1041`).
- **Savepoints** — nothing beyond the flag. Poison lives on the `ConnectionOverlayState` object,
  which `rollbackToSavepoint` does not replace, so it survives an inner-savepoint unwind and is
  cleared only by a full rollback or a rollback to a pre-overlay savepoint (which drops the state).
  That matches ALTER's documented poison lifecycle. It is deliberately over-strict for a connection
  that unwinds all its staged rows past the drop and could arguably commit clean — the table is gone
  either way, so failing is the safe answer. Document, don't special-case.

### Ordering constraint (already satisfied, don't regress)

Nothing is discarded or poisoned until `underlying.destroy` **succeeds** — a throwing destroy means
the table still exists and every overlay is still flushable. The existing test
`a failed underlying destroy leaves the overlay and underlying maps untouched` pins this; keep
`await this.underlying.destroy(...)` first.

### Capability posture (per Nate's note)

This lands the *clean* semantic for a fully cooperating module: no data loss without notification.
No new capability flag is warranted — the guarantee is provided by the isolation layer itself, not by
the underlying, so every underlying gets it. Nothing to advertise.

## TODO

- Add `buildDropPoisonMessage(schemaName, tableName)` to `IsolationModule`, mirroring
  `buildAlterPoisonMessage`. Message should name `schema.table` and say the table was dropped by
  another connection and this transaction must be rolled back.
- Rewrite `IsolationModule.destroy` to partition matching `connectionOverlays` keys into own /
  foreign-dirty / foreign-clean per the table above. Own key = `makeConnectionOverlayKey(db, …)`.
  Poison foreign-dirty in place (`state.poison = { message: buildDropPoisonMessage(...) }`); delete
  the other two. Leave an already-poisoned foreign overlay poisoned (do not overwrite its message —
  the first cause is the one worth reporting).
- Sweep `preOverlaySavepoints` for every matching key whose overlay did **not** survive.
- Rewrite the destroy doc comment (`isolation-module.ts:752-772`) — it currently argues the silent
  discard is correct.
- Update `commitConnectionOverlays`'s "**Invariant: every staged overlay resolves to an underlying
  table here**" paragraph (`isolation-module.ts:444-453`): `destroy` no longer drops *every*
  connection's overlay, so the invariant now reads "…every staged overlay resolves to an underlying
  table **or is poisoned**", with the poison check ahead of the lookup as the enforcement point.
- Tests in `packages/quereus-isolation/test/isolation-layer.spec.ts`, suite
  `orphaned overlays across DROP TABLE / RENAME TO` (~line 1325):
  - Rewrite `DROP TABLE discards another connection's staged overlay for the same table` →
    the foreign overlay survives, is poisoned, and `iso.commitConnectionOverlays(other)` rejects with
    `StatusCode.CONSTRAINT`. Assert the message names the dropped table.
  - New: a foreign overlay with `hasChanges === false` is deleted, not poisoned.
  - New: the *dropping* connection's own dirty overlay is deleted silently and its
    `preOverlaySavepoints` key is gone.
  - New: `preOverlaySavepoints` survives for the poisoned foreign key and is gone for every other.
  - New: an already-poisoned foreign overlay (ALTER poison) keeps its original message across a DROP.
  - Existing `a failed underlying destroy leaves the overlay and underlying maps untouched` must
    still pass unchanged.
- Update `docs/design-isolation-layer.md`:
  - § *Invariant: every staged overlay resolves to an underlying table at commit* (lines ~147-160) —
    replace the "discarding their staged writes is correct" claim with the poison rule.
  - § *DDL through the isolation layer* bullet "Open overlays are never orphaned" (line ~706).
  - § *ALTER overlay migration & cross-connection poison* (lines ~708-722) — generalize the poison
    section to cover both ALTER and DROP as poison sources; note the drop poison's lifecycle is
    identical.
- Run `yarn workspace @quereus/isolation test` and `yarn build`.
