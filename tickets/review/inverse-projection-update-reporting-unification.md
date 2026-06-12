description: Unify the inverse-projection arm's same-key real-change reporting to a single `update` (upsert-only when old/new projected images share the backing key) instead of the current delete+insert pair, matching the residual arms' post-suppression reporting shape.
difficulty: easy
files:
  - packages/quereus/src/core/database-materialized-views.ts   # applyInverseProjection UPDATE branch
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts  # pins the current delete+insert shape ("real same-key change still reports (delete + insert, as before)")
----

# Inverse-projection same-key changes: report one `update`

Since `mv-noop-upsert-suppression`, the residual arms (aggregate, join forward/lookup,
prefix-delete) report a real same-key recompute as **one `update`** — the host's
collation-aware upsert key identity replaces the old row wholesale, no delete-first.
The inverse-projection (covering-index) arm was deliberately left reporting
**delete + insert** for a real same-key payload change (its update branch emits
`delete-key(old image)` + `upsert(new image)` unconditionally once the equal-image
short-circuit doesn't fire), to keep reporting stable during that ticket.

## Why unify

- **Cascade cost**: an MV-over-MV consumer is dispatched twice (delete then insert)
  for what is semantically one row update — the dominant covering-index arm is the
  one place this still happens.
- **Change-log shape**: a future change-logged (synced) backing should emit one
  update entry, not a delete+insert pair, for a payload change at a stable key.
- **Secondary-index bookkeeping**: a key-equal delete+insert churns index entries an
  update pairing would leave in place.

## Expected behavior

When both images are in scope and their projected backing keys are equal (under the
backing PK columns' collations — byte-different collation-equal keys count as equal
key identity, and the upsert re-keys the stored bytes), emit the `upsert` only; the
host reports `update` (or nothing when value-identical — already the case). Keys
differing, or either image out of scope, keep the current delete/upsert pairing
(predicate-scope transitions and key-changing updates are genuinely two-sided).

The maintenance-equivalence no-op suppression suite pins the current delete+insert
shape ("regression: a real same-key change still reports (delete + insert, as
before)") — that pin flips to `['update']` as part of this change. The byte-exact
equivalence oracle must stay green throughout (final backing state is unchanged by
this; only the reported shape moves).

## Implement handoff (2026-06-12)

Implemented. `applyInverseProjection` UPDATE branch (src/core/database-materialized-views.ts): when both images in scope and projected backing keys equal under `backingPkEqual` (per-PK-component `compareSqlValues` with the column's collation — collation-equal byte-different keys count equal; the host upsert re-keys stored bytes), emit upsert only → host reports one `update`. Key-changing / scope-transition cases keep delete+upsert. Pin in `test/incremental/maintenance-equivalence.spec.ts` flipped to `['update']`; new NOCASE-backing-key suite asserts a case-only key rewrite takes the single-update path and stays byte-equivalence green. docs/materialized-views.md update-arm row updated. Full suite 5909 passing.

NOTE for reviewer: the implement diff for this ticket is NOT under its own commit — a concurrent runner commit (c04e512e, "ticket(implement): maintained-table-attach-detach-verbs") swept these changes in along with ticket 6.2's work. Review the files named above within that commit.
