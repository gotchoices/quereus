description: A resumed streaming-snapshot transfer can lose completed-table CRDT metadata. The receiver (applySnapshotStream) unconditionally clears ALL sync metadata at the top of every apply, but the sender (resumeSnapshotStream) skips completedTables and never re-emits them — so on resume the completed tables' metadata is wiped and never rewritten.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts   # applySnapshotStream (clears all metadata up-front); resumeSnapshotStream / streamSnapshotChunks (skips completedTables)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # applySnapshotStream / resumeSnapshotStream / getSnapshotCheckpoint wiring
  - packages/quereus-sync/src/sync/manager.ts           # SnapshotCheckpoint shape; manager interface
difficulty: medium
----

# Resumed snapshot stream wipes completed-table metadata

## Problem

Streaming snapshot apply has two ends:

- **Sender** — `resumeSnapshotStream(checkpoint)` (delegates to `streamSnapshotChunks` with
  `completedTables = new Set(checkpoint.completedTables)`) **skips** any table already marked
  completed and does **not** re-emit its `table-start` / `column-versions` / `table-end` chunks.
- **Receiver** — `applySnapshotStream` unconditionally **clears all** CRDT metadata
  (column-versions, tombstones, change-log) in a single batch at the very top of every apply,
  *before* processing any chunk.

When a transfer resumes, the receiver runs `applySnapshotStream` again over the resumed stream. It
clears **all** metadata, but the sender only re-sends the not-yet-completed tables. The completed
tables' column-version / change-log metadata is therefore deleted and never rewritten → those tables
look empty to subsequent delta sync even though their row data may still be present in the store
(metadata/data divergence; effectively lost CRDT state for completed tables).

This is **pre-existing** and independent of the per-change error-handling work
(`sync-apply-per-change-errors-ignored`), which only added an abort-before-`synced` on apply
failure. It surfaced while reviewing that change.

## Repro direction (for the fix agent)

Reproduce by driving `applySnapshotStream` with a checkpoint that lists one table as completed and a
resumed chunk stream (from `resumeSnapshotStream`) that omits it, then assert the completed table's
column versions survive (currently they do not). Cover both the data and the CRDT-metadata sides.

## Possible resolution shapes (decide during fix/plan — do not pre-commit here)

- Make the receiver resume-aware: on a resumed apply, clear only the metadata for tables that will
  be re-sent (or skip the up-front clear entirely and rely on idempotent per-key overwrite), rather
  than a blanket clear.
- Or have the sender always re-emit completed tables on resume (defeats the point of the checkpoint;
  likely undesirable for large transfers).
- Or move the "clear all" to happen lazily per-table as each `table-start` arrives, so untouched
  tables keep their metadata.

Confirm how hosts actually wire resume (`getSnapshotCheckpoint` → `resumeSnapshotStream` →
`applySnapshotStream`) before choosing, and ensure the chosen approach keeps the
`sync-apply-per-change-errors-ignored` invariant intact (no `synced`, checkpoint retained on apply
failure).
