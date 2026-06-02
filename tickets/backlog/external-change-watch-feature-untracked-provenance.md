description: An external-change watcher notification feature (`notifyExternalChange` / `notifyExternalTableChange`) is landing un-ticketed, split across an unrelated FK ticket's commit and uncommitted working-tree edits. Give it a proper ticket/review trail and confirm completeness.
files: packages/quereus/src/core/database.ts, packages/quereus/src/core/database-watchers.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/test/external-change-watch.spec.ts
----

## What this is

A coherent feature — coarse, commit-less "external change" watcher notification for tables
backed by an external/replicated store (e.g. the optimystic vtab) that learns of remote
writes out-of-band, so the change never touches this `Database`'s commit change-log and the
post-commit watcher path would otherwise never fire.

Surface (as observed during the `lens-parent-side-fk-nullable-key-update-gap` review):

- `Database.notifyExternalChange(tableName, schemaName?)` — fires all active watchers whose
  scope includes `schema.table` as if the whole table changed, without a local commit
  (`src/core/database.ts`).
- `WatcherManager.notifyExternalTableChange(fqName)` and supporting plumbing
  (`src/core/database-watchers.ts`).
- `subscriptionFromChangeScope` `groups`-case fix so a `groups` watch fires on a global /
  external change instead of silently missing it (`src/runtime/delta-executor.ts`).
- `test/external-change-watch.spec.ts` — behavioral coverage (currently 12 passing).

## Why this ticket exists

The feature was **not** worked through tess. It landed split across boundaries:

- Part of it (`database.ts` +26, `database-watchers.ts` +60, the +166-line spec) was
  **committed inside an unrelated FK ticket's implement commit** `b28548c2`
  (`ticket(implement): lens-parent-side-fk-nullable-key-update-gap`) because it sat in the
  working tree when the runner committed.
- Further edits (`delta-executor.ts` +9, `external-change-watch.spec.ts` +54) were
  **uncommitted in the working tree** during the FK review session and will likely be swept
  into that review's commit too.

The code itself looks complete and is green (tests + lint pass), so this is a
**provenance / process** concern, not a known defect. The implement handoff mis-characterized
it as "half-finished" based on a transient stale-working-tree lint artifact (`DeltaApplyInput`
unused) that no longer reproduces.

## What a human should decide / requirements

- Confirm whether this feature is intentional and complete, or still in progress.
- Give it its own review trail: is `notifyExternalChange` correct for all watch kinds
  (`full`, `rows`, `rowsByGroup`, `groups`), the documented "over-fire never under-fire"
  contract actually upheld, and is it wired to a real external-store caller (optimystic vtab)?
- Confirm the `delta-executor.ts` `groups`/`isGlobal` change has no regression for the
  normal (non-global) commit path.
- Decide whether docs (watcher/runtime docs) need a section for the external-change path.
- This is bookkeeping for code that already merged on `view-updates-lens`; nothing needs
  reverting unless the human finds the feature was not meant to land yet.
