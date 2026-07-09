---
description: If one connection drops a table while another connection has unsaved changes to that same table, those changes vanish and the second connection's save still reports success — it is never told anything was lost.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# `drop table` silently discards another connection's uncommitted writes

## Background

The isolation layer stages every connection's uncommitted writes in a private scratch table (an
"overlay") and only merges them into real storage at `commit`. Several connections may hold
overlays for the same table at once.

`drop table` is not transaction-scoped — the table disappears for every connection immediately.
So the layer's `destroy` hook now deletes every connection's overlay for that table, including
overlays belonging to connections that are still inside an open transaction and never asked for
the drop. Those connections then reach `commit`, find no overlay, and **succeed**. Their writes
are gone and nothing told them.

## Why this is inconsistent with the rest of the layer

`alter table` faces the same problem — a schema change invalidates other connections' staged rows
— and solves it by *poisoning* each foreign overlay: the overlay is marked, and the owning
connection's `commit` raises a constraint error instead of quietly succeeding. See
`ALTER overlay migration & cross-connection poison` in `docs/design-isolation-layer.md`.

`drop table` is strictly more destructive than `alter table` and yet is the only DDL path that
loses another connection's data without telling it. Reporting a successful commit that persisted
nothing is exactly the failure mode the sibling ticket
(`iso-orphaned-overlay-drop-rename`) set out to eliminate for the *dropping* connection; the
foreign connection was left with the old behaviour.

## Expected behavior

A connection whose uncommitted writes are destroyed by another connection's `drop table` must
learn about it. Concretely: `destroy` should mark each foreign overlay the way `alterTable` does,
so the foreign connection's `commit` fails and its transaction rolls back, rather than reporting
success.

Open questions the implementer should settle:

- Should the *dropping* connection's own overlay also be surfaced, or silently discarded as today?
  (Silently discarding it is defensible — that connection asked for the drop.)
- Which status code: reuse the constraint error `alterTable`'s poison raises, or a distinct one?
- Does a foreign connection sitting in a savepoint need anything beyond the poison flag?

## Where it is today

`IsolationModule.destroy` in `packages/quereus-isolation/src/isolation-module.ts` sweeps
`connectionOverlays` and `preOverlaySavepoints` across all connection ids and deletes the entries.
The current behaviour is pinned by the test
`DROP TABLE discards another connection's staged overlay for the same table` in
`packages/quereus-isolation/test/isolation-layer.spec.ts`; that test asserts the silent discard and
will need to be rewritten to assert the foreign commit now fails.

`docs/design-isolation-layer.md` currently documents the silent discard as correct (under
*Invariant: every staged overlay resolves to an underlying table at commit*) and must be updated
alongside.
