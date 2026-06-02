description: External-change watcher notification feature (`notifyExternalChange` / `notifyExternalTableChange`) — provenance/process ticket created after the feature landed un-ticketed, split across an unrelated FK commit and working-tree edits. Reviewed for completeness and correctness; confirmed complete and green.
files: packages/quereus/src/core/database.ts, packages/quereus/src/core/database-watchers.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/test/external-change-watch.spec.ts, packages/quereus/test/runtime/delta-executor-watch.spec.ts, docs/change-scope.md, docs/usage.md
----

## What landed

A coarse, commit-less "external change" watcher notification path for tables backed by an
external/replicated store (e.g. the optimystic vtab) that learns of remote writes out-of-band,
so the change never touches this `Database`'s commit change-log and the post-commit watcher
path would otherwise never fire.

- `Database.notifyExternalChange(tableName, schemaName?)` — public API; fires every active
  watcher whose scope includes `schema.table` as if the whole table changed, without a local
  commit (`src/core/database.ts:1746`).
- `WatcherManager.notifyExternalTableChange(fqName)` — snapshots matching subscriptions, then
  drives each through its existing `apply` with `globalRelations` set and empty per-relation
  tuples, reusing the commit-path global-fallback branch (`src/core/database-watchers.ts:192`).
- `subscriptionFromChangeScope` `groups`-case fix: `observable = isGlobal || hits.length > 0`
  so a `groups` watch fires (empty hits → "re-query") on any global re-evaluation instead of
  silently missing it (`src/runtime/delta-executor.ts:478`).

## Provenance (the reason this ticket existed)

The feature was not worked through tess. It landed split across:
- commit `b28548c2` (`ticket(implement): lens-parent-side-fk-nullable-key-update-gap`) — the
  `database.ts`/`database-watchers.ts` core + the original spec, swept in from the working tree;
- commit `9046f76c` (the FK ticket's review) — the `delta-executor.ts` `groups` fix, the
  external-change spec extension, a `delta-executor-watch` regression unit test, and the
  `docs/change-scope.md` external-change section.

As of this review the entire feature is committed; the working tree held no uncommitted code.
The "half-finished / `DeltaApplyInput` unused" characterization in the implement handoff was a
transient stale-working-tree lint artifact — `DeltaApplyInput` is used at
`database-watchers.ts:211` and lint is clean. **Nothing was reverted; the feature was meant to
land.**

## Review findings

**Disposition:** feature confirmed intentional and complete. Two minor doc/test gaps fixed
inline; no major findings, so no new fix/plan tickets filed. One pre-existing latent edge noted
below (out of scope, not introduced here).

### Checked — correctness

- **All four watch kinds through the external path** (verified against `apply`, `delta-executor.ts:455`):
  `full` → empty hits; `rows`/`rowsByGroup` (isGlobal) → all registered literal values;
  `groups` → empty hits. Matches the documented coarse contract and the over-fire-never-under-fire
  rule. Each is behaviorally tested in `external-change-watch.spec.ts`.
- **`groups`/`isGlobal` regression on the normal commit path** — *no regression*. The non-global
  branch is byte-identical (`observable = hits.length > 0`); the change only *adds* firing when
  `isGlobal` is set, and `runOne` only adds a relation to `globalRelations` when its base actually
  changed → no spurious fire on unchanged tables. Covered by the new unit test
  `apply: 'groups' watch fires with empty hits when relKey is in globalRelations`
  (`delta-executor-watch.spec.ts`) and the full suite (4377 passing, 0 failures).
- **Matching consistency** — `notifyExternalChange` lowercases `schema.table`; `entry.tables`,
  `baseKeyFor`, and `relationToBase` are all lowercased, so `subscriptionsForTable` (via `tables`)
  and the `relationToBase` global-relation collection agree. Case-insensitivity and explicit-schema
  matching tested.
- **Snapshot-before-fire** — `notifyExternalTableChange` snapshots matching subscriptions and
  skips `entry.disposed` mid-pass, so a handler that (un)subscribes a peer cannot perturb the pass.
- **Error isolation** — per-subscription `apply` wrapped in try/catch (logged, never rejects into
  the caller); handler errors swallowed inside `apply`. Mirrors `runPostCommit`. Tested for both
  sync-throw and async-reject handlers, including "other watchers still fire".
- **Resource cleanup / type safety** — `currentTxnId` reset in `finally`; `DeltaApplyInput` built
  with `new Map()`/`Set<string>`; no `any`. Clean.
- **Caller wiring** — `notifyExternalChange` is a public `Database` method; the caller is the
  embedding host (Lamina / optimystic-backed app), not engine-internal code. The host-side wiring
  is separately tracked by `lens-deployment-export-and-notify` (implement/). "Unwired internally"
  is correct for a host-facing API, not a defect.

### Found & fixed inline (minor)

- **Coverage gap**: no test asserted that a single subscription watching *two* tables fires only
  the named table's watch on an external change (the "don't over-fire to unrelated relations within
  one subscription" half of the contract). Added
  `fires only the named table within a subscription that watches two tables`
  to `external-change-watch.spec.ts`. Passes.
- **Stale ticket reference**: the spec header doc-comment cited a non-existent ticket
  `quereus-external-change-watch-api`; repointed to this ticket's slug.
- **Docs**: `docs/change-scope.md` already documents the external-change path (added in `9046f76c`)
  and is accurate against the implementation. `docs/usage.md` enumerated the public watcher API but
  omitted the out-of-band path — added a brief `notifyExternalChange` pointer there linking to the
  change-scope section.

### Noted — not actioned (pre-existing, out of scope)

- **Re-entrant `currentTxnId`**: `WatcherManager.currentTxnId` is shared mutable state. A watch
  handler that synchronously triggers another commit or `notifyExternalChange` overwrites it, so
  the outer pass's later subscriptions could observe an inner/empty `txnId` on their events. This
  is a pre-existing limitation shared identically with `runPostCommit` (same single-field pattern),
  not introduced by this feature, and impact is limited to an informational label under an exotic
  re-entrant-handler scenario. Left as-is; flagged here for visibility.

### Validation

- `yarn lint` (packages/quereus) — clean, exit 0.
- `packages/quereus/test/external-change-watch.spec.ts` — 13 passing (12 original + 1 added).
- `packages/quereus/test/runtime/delta-executor-watch.spec.ts` — included; `groups` global-fallback
  unit test passes.
- Full quereus suite (`yarn workspace @quereus/quereus run test`) — **4377 passing, 9 pending,
  0 failing** (~52s). No regression from the `delta-executor` `groups` change.
