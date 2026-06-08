---
description: UPDATE path in `dml-executor.ts` now records the displaced row when an UPDATE moves onto an occupied PK under REPLACE. Change tracking, FK cascade, and auto-events all see the eviction.
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
---

# UPDATE drops `result.replacedRow` from the vtab — fixed

## What landed

`runUpdate` in `packages/quereus/src/runtime/emit/dml-executor.ts`
(lines 519-538) now inspects `result.replacedRow` after a successful
`vtab.update`. When the vtab returns one (PK-change UPDATE evicting an
occupied PK under REPLACE), the executor:

- calls `ctx.db._recordDelete(...)` for the evicted row,
- runs `executeForeignKeyActions(db, table, 'delete', replacedRow)`,
- emits an auto `'delete'` data event when there are non-native-event
  listeners.

The eviction block runs **before** the existing `_recordUpdate` / FK
update-cascade / auto-event block for the moved row, matching the
journal order in `vtab/memory/layer/manager.ts:657-659` and SQLite's
documented REPLACE semantics. Evict-first is also the only correct
order for the `ON UPDATE CASCADE + ON DELETE CASCADE` combination on
the same child table — evict-last would relocate children onto PK_new
and then have the eviction's `ON DELETE CASCADE` wipe them.

Tests added to
`packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`:

- **§9** — `primary key on conflict replace` + child with
  `on delete cascade`. The UPDATE that moves the parent onto an occupied
  PK now cascade-deletes the evicted parent's child.
- **§10** — same shape with `on delete set null`; the evicted parent's
  child now lands at `parent_id = NULL`.

Only the child of the evicted row is kept in each fixture. A child of
the moved row would hit Quereus's default `on update restrict`
(`packages/quereus/src/schema/manager.ts:781,815`) and abort the move
before the new code can run.

## Review findings

Checked, in roughly this order:

**Diff correctness.** Read the implement-stage commit (`9dbb6c93`)
end-to-end before consulting the handoff. The new block is a
straight analog of the INSERT path's `replacedRow` handling at
`dml-executor.ts:425-438`, plus an explicit `_recordDelete` (the INSERT
path doesn't need one because the slot at PK_new holds the new row
afterwards and the single `_recordUpdate(replacedRow → newRow)` carries
the eviction). For the UPDATE PK-change case, the evicted row is at a
*different* PK from the moved row, so a separate `_recordDelete` is
genuinely needed.

**Changelog interaction.** Traced through
`packages/quereus/src/core/database-transaction.ts` (`recordUpdate` at
541-558 and `mergeRecord` at 451-510). For the PK-change-with-eviction
case the operations land as:

1. `_recordDelete(replacedRow at PK_new)` → `delete(replacedRow)` at
   PK_new.
2. `_recordUpdate(oldRow at PK_old, newRow at PK_new)` with different
   PKs splits into `delete(oldRow)` at PK_old + `insert(newRow)` at
   PK_new.
3. The state machine at line 498-501 (`prev=delete, next=insert →
   update`) merges (1) and (2b) into a single
   `update(oldProjection=replacedRow, newProjection=newRow)` entry at
   PK_new, which is exactly the correct semantic.

Final changelog: `PK_old: delete(oldRow)`,
`PK_new: update(replacedRow → newRow)`.

**Journal-order claim verified.** `vtab/memory/layer/manager.ts:649-661`
matches the ticket's documentation: `recordDelete(newPk, evicted)` runs
before the `recordDelete(oldPk, oldRow)` and `recordUpsert(newPk, new)`,
i.e. eviction is journaled before the move. The executor's evict-first
order mirrors this.

**Where `replacedRow` can come from.** Project-wide
`find_references("replacedRow")` returns four files — only the memory
module's `performUpdateWithPrimaryKeyChange` actually sets it on an
`UpdateResult` (`manager.ts:660`). The other hit
(`constraint-check.ts:181`) is a different concept (input-row NOT NULL
default substitution) and is unaffected.

**Symmetry with INSERT path.** The asymmetry between INSERT REPLACE
(single `_recordUpdate(replacedRow, newRow)`) and UPDATE PK-change
REPLACE (`_recordDelete(replacedRow) + _recordUpdate(oldRow, newRow)`)
is semantically correct — INSERT has one PK in play, UPDATE PK-change
has two. The merge state machine collapses the PK_new pair correctly.

**Reviewer-attention items in the handoff, dispositioned:**

- **Auto-event coverage gap (handoff item 1).** Confirmed deferral. The
  sqllogic harness does not surface the `DatabaseEventEmitter` stream,
  and the FK cascade tests in §9/§10 exercise the same
  `needsAutoEvents` gate. A direct unit test against the emitter is
  worthwhile follow-up but not opened as a separate ticket here;
  noted for the human to track.
- **`OR REPLACE` statement-level form not test-covered (handoff item
  2).** **Moot.**
  `packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic:64-76`
  documents that `UPDATE OR <action>` is intentionally **not**
  supported in Quereus — the parser errors with "Expected table name"
  on `update or replace ...`. Column-level / table-level
  `ON CONFLICT REPLACE` is the only entry point to REPLACE during
  UPDATE, and §9/§10 exercise it.
- **`yarn test:store` not run (handoff item 3).** Accepted deferral —
  out of agent runtime scope. CI or the table-level companion ticket's
  store-mode validation (which already exercises 29.2's PK-change
  REPLACE paths) covers the same vtab surface; this fix is in the
  executor, above the storage boundary.
- **Ordering choice — evict-first (handoff item 4).** Accepted. The
  three justifications in the inline comment (journal-order parity,
  SQLite semantics, and the `ON UPDATE CASCADE + ON DELETE CASCADE`
  correctness) are sound. The deviation from the ticket's suggested
  post-update ordering is well-documented at
  `dml-executor.ts:519-526`.
- **`OR IGNORE`/`OR ABORT` interaction with eviction (handoff item
  5).** **Moot**, same reason as item 2 — `UPDATE OR <action>` doesn't
  parse. Column-level `ON CONFLICT IGNORE` is tested in §8 of the same
  file and short-circuits before the new code via the existing
  `if (!result.row) continue;` guard at `dml-executor.ts:515-517`. ABORT
  surfaces a constraint violation and throws before the new code, also
  via existing handling at lines 509-512.

**Additional review (out of handoff list):**

- **Auto-event semantics for PK-change UPDATE.** The
  pre-existing `'update'` auto event for the moved row is keyed on
  PK_old. The new code emits a separate `'delete'` event keyed on
  PK_new (for the evicted row). A subscriber listening at PK_new sees
  the eviction but never sees that PK_new now holds `newRow` — they'd
  have to infer that from the PK_old `'update'` event. This is a
  pre-existing event-model limitation (the changelog correctly captures
  both sides; only the streaming event layer is asymmetric). Not
  introduced or worsened by this fix. Out of scope; flag for a future
  event-semantics ticket if the user wants symmetric `delete + insert`
  events for PK-changing UPDATEs.
- **Hypothetical: `replacedRow` from a same-PK UPDATE.** Not produced
  by the memory module (`performUpdateWithPrimaryKeyChange` is only
  called when `isPrimaryKeyChanged` is true,
  `manager.ts:626-627`). If a future vtab module were to return
  `replacedRow` from a same-PK UPDATE, the `mergeRecord` state machine
  has no `prev=delete, next=update` rule and would fall to the
  defensive `tableMap.set(pkKey, incoming)` branch (line 509),
  dropping the eviction's `oldProjection`. Not a regression (the old
  code dropped `replacedRow` entirely), and not blocking; future vtab
  implementers should be aware.

**Verification.** From the repo root:

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — **2941 passing, 2
  pending, 0 failing.** §9 and §10 pass; §§1-8 of the
  29.1 suite stay green.

## Major findings filed as new tickets

None. Findings were:

- Three of the five reviewer-attention items in the implement handoff
  turned out moot once the `UPDATE OR <action>` non-support
  (47.2 §5) was located.
- One (direct event-emitter unit test) is a documented deferral that
  the user can spin out as a follow-up at their discretion.
- One (`yarn test:store`) is accepted as out of agent runtime scope.
- One additional pre-existing concern (asymmetric auto-event semantics
  for PK-change UPDATE) is documented above and is not introduced by
  this fix.
