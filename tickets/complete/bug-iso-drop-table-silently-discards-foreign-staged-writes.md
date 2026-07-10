---
description: When one connection drops a table while another still has unsaved changes to it, the second connection's save now fails with a clear error instead of quietly reporting success after its changes were thrown away.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# `drop table` poisons foreign staged overlays instead of sweeping them

## What shipped

`IsolationModule.destroy` used to delete **every** `connectionOverlays` entry whose key suffix
matched the dropped table, across all database ids. A second connection with staged (uncommitted)
rows for that table would then commit against an empty overlay set, resolve successfully, and
persist nothing — silent cross-connection data loss.

`destroy` now partitions the matching overlay keys three ways, after `await this.underlying.destroy(...)`
succeeds (a throwing destroy still leaves every map entry untouched):

| overlay | action |
|---|---|
| the dropping connection's own | delete — it issued the DROP |
| foreign, `hasChanges === true` | **poison** (`state.poison = { message }`); keep the entry |
| foreign, `hasChanges === false` | delete — staged nothing, nothing lost |

`preOverlaySavepoints` is swept for every matching key whose overlay did not survive. A surviving
poisoned overlay keeps its set; the owning connection's `onConnectionRollback` reaps it when its
failed commit rolls back.

No downstream change was needed. `commitConnectionOverlays` already checks `state.poison` **before**
the `underlyingTables` lookup, so a poisoned overlay for a now-absent table raises the poison message
(`StatusCode.CONSTRAINT`) rather than the `INTERNAL` orphan error. `IsolatedTable.assertOverlayUsable`
already throws on `update` and on the merged branch of `query`, and still leaves the `readCommitted`
path alone.

`IsolationModule.buildDropPoisonMessage` (private) sits beside `buildAlterPoisonMessage`. Both poison
sources raise the same `StatusCode.CONSTRAINT`; they are told apart by **message**, not code. An
already-poisoned *foreign* overlay keeps its original message across a DROP.

### Files touched

- `packages/quereus-isolation/src/isolation-module.ts` — `destroy` rewritten; `buildDropPoisonMessage`
  added; doc comments on `destroy`, `commitConnectionOverlays`, and `ConnectionOverlayState.poison`
  updated; two `NOTE:` tripwires added on `destroy` during review.
- `packages/quereus-isolation/src/isolated-table.ts` — three poison doc/comment sites generalized from
  "cross-connection ALTER" to "cross-connection ALTER or DROP TABLE". No logic change.
- `packages/quereus-isolation/test/isolation-layer.spec.ts` — one test rewritten, four added at
  implement, three more added at review; `stageOverlay` helper generalized to take a table name.
- `docs/design-isolation-layer.md` — `destroy()` bullet under *Invariant: every staged overlay resolves
  to an underlying table at commit*; the *Open overlays are never orphaned* DDL bullet; the poison
  section renamed *ALTER / DROP overlay poison* and split into ALTER / DROP / Observing / Lifecycle
  subsections; one paragraph added at review on the own-overlay poison escape.

## Validation (all run at review, all green)

```
yarn workspace @quereus/isolation test                          # 190 passing, 0 failing
npx tsc -p packages/quereus-isolation/tsconfig.json --noEmit    # exit 0
yarn lint                                                       # clean
yarn build                                                      # clean
yarn test                                                       # full sweep, 0 failing
```

Suite `orphaned overlays across DROP TABLE / RENAME TO` (`isolation-layer.spec.ts` ~line 1325) —
17 passing. Tests construct two `Database` instances sharing one `IsolationModule` (distinct db ids ⇒
distinct overlay keys) and inject the foreign overlay via `setConnectionOverlay`, exactly as the
cross-connection ALTER suite does.

## Review findings

### Correctness of the diff — no defects found

Traced end to end and found nothing wrong with the partition logic. Specifically verified:

- **Key comparison is sound.** `makeConnectionOverlayKey` lowercases, and `connectionScopedKeys`
  returns live map keys (also lowercased), so `key !== ownKey` cannot misfire on table-name casing.
- **`preOverlaySavepoints` survival is required, not merely harmless.** Deleting a surviving poisoned
  overlay's set would silently change `onConnectionRollbackToSavepoint` behaviour: `savepointsBeforeOverlay`
  lazily re-creates an empty set, so a rollback to a genuinely pre-overlay savepoint would stop clearing
  the overlay. Keeping it is correct.
- **Poison precedence holds against every other overlay-rebuilding path.** `alterTable` skips a poisoned
  overlay before its issuer/foreign split, and `dropIndex` skips it in its post-drop rebuild loop, so a
  drop-poisoned overlay cannot be silently un-poisoned by a later DDL.
- **The commit abort really is before any apply.** `commitConnectionOverlays` throws on poison inside the
  entry-collection loop, which fully precedes Phase 1, so no earlier table in a multi-table transaction is
  left committed. Now pinned by a test (below).
- **`destroy` has exactly one engine caller** — `SchemaManager.dropTable` (`packages/quereus/src/schema/manager.ts:1479`),
  reached only from `DROP TABLE`. Nothing in `Database.close()` routes there, so closing a connection cannot
  poison a peer's overlays.
- **The `ensureBackingForAttach` / `retireBackingForAttach` / `discardBackingForAttach` seams** still evict
  `underlyingTables` without any overlay sweep. That remains safe for the documented reason (materialized-view
  backing writes bypass the overlay) and is untouched by this change; the existing `NOTE:` at
  `isolation-module.ts:241` already records it.

### Handoff gap closed

- **"Poison reap depends on a registered `IsolatedConnection`; if some path can stage an overlay without
  one, a poisoned overlay would leak."** Investigated and resolved — no leak. `ensureOverlay` is called
  from exactly one site, `IsolatedTable.update` (`isolated-table.ts:860`), immediately after
  `ensureConnection()` on the line before. Every overlay that reaches `hasChanges === true` therefore has a
  registered `IsolatedConnection` whose `rollback` reaps it. The only other stager is the public
  `setConnectionOverlay`, a host/test seam. No ticket filed.

### Test gaps — fixed in this pass (minor)

Three tests added; the implementer's five were a genuine floor but left the drop-specific behaviour of the
*shared* poison machinery unasserted.

- `a drop-poisoned connection errors at its merged read and its next write` — connects an `IsolatedTable`
  for the foreign db *before* the drop (after it, `connect` can no longer resolve an underlying), then
  asserts `query` and `update` both throw `CONSTRAINT` naming `main.shared`. The ALTER suite had the
  equivalent; DROP had only the commit path.
- `a drop-poisoned overlay aborts the foreign multi-table commit before any table applies` — stages `keep`
  first so `commitConnectionOverlays` walks it before reaching the poisoned `shared`, then asserts the
  commit throws `CONSTRAINT`, `keep`'s underlying storage is still empty, and both overlays survive for the
  ensuing rollback. This is the regression guard for the poison check staying out of the apply loop.
- `the dropping connection escapes a poison it was already carrying for that table` — pins the semantic
  found during review (below).
- `stageOverlay` generalized to take a table name rather than hard-coding `shared` (DRY; the multi-table
  test needs two).

### Semantics found during review, pinned rather than changed

A connection already poisoned by *another* connection's ALTER **escapes that poison** for a table it then
drops itself: the own-overlay branch deletes the state, poison and all, so its commit succeeds. This is
correct as written — the rows it discards belong to a table it just asked to remove, and the escape is
scoped to that one table (an overlay poisoned on any other table still aborts the commit) — but it was
undocumented and untested. Now covered by the test above, by a `NOTE:` on `destroy`, and by a paragraph in
`docs/design-isolation-layer.md` § *DROP TABLE: discard, or poison*.

### Tripwires parked (conditional; not filed as tickets)

- **Concurrent DROP versus a foreign mid-scan merged read.** `destroy` mutates `connectionOverlays` while a
  foreign connection may be inside `IsolatedTable.query`'s merged branch; that scan will now keep merging
  against an overlay whose underlying was destroyed (pre-fix it merged against a deleted entry — neither is
  obviously safe, and the exposure is unchanged by this ticket). The module clamps to `'reentrant-reads'`, so
  no in-tree host reaches it. Parked as a `NOTE:` on `IsolationModule.destroy` naming the fix if a host ever
  does: give the merged iterator a per-scan snapshot of the overlay + underlying pair.
- **Over-strict drop poison for a clean unwind.** Poison rides on the `ConnectionOverlayState`, not on its
  rows, so a foreign connection that rolls back every staged row past the drop still fails its commit. Parked
  by the implementer as a `NOTE:` on `destroy` and in the design doc; confirmed correct and left as is.
- **Own-overlay poison escape** — see above; parked as a `NOTE:` on `destroy`.

### Known limitation, accepted (not a ticket)

**No end-to-end SQL test of the poisoned commit** (`begin; insert; …; commit` on connection B with A dropping
the table in between). Not an oversight the reviewer can cheaply close: each `Database` owns its own schema
catalog, so a second `Database` sharing the module cannot see a table the first created without issuing its
own `create table`, which re-creates the underlying and hands the first connection a stale handle. Every
cross-connection test in this file — the pre-existing ALTER poison suite included — injects overlays via
`setConnectionOverlay` for exactly this reason. `IsolatedConnection.commit` calls `commitConnectionOverlays`
directly, so the path is a single unbranched call away from what *is* asserted. Closing this properly means
giving the isolation layer a real multi-connection test fixture (shared schema catalog across `Database`
instances), which is a larger piece of work than this bug and would rewrite the ALTER suite too. Left
unfiled: it is a testability improvement for the whole package, not a defect in this change.

### Major findings

None. No new `fix/`, `plan/`, or `backlog/` tickets filed.

### Pre-existing, not this ticket

Two editor-only TypeScript diagnostics in `isolated-table.ts` / `isolation-module.ts` (`tombstoneIndex`
unused in `checkMergedPKConflict`, `_exhaustive` unused in `translateOverlayRow`). Both present at HEAD,
both outside this diff, neither a build, lint, or test failure — `tsc --noEmit` on the package exits 0 and
`yarn lint` is clean. Not written to `.pre-existing-error.md`: that file is for test failures, and there
are none.
