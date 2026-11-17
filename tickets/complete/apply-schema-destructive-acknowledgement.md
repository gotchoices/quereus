description: Applying a declared schema now refuses, before running anything, any change that drops a table, drops a column, changes a column's type or moves a table to another storage module, unless the user passes allow_destructive. One error lists everything at risk and suggests a rename hint when a drop was really a rename.
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/schema/schema-differ.ts              # DestroyedData, MigrationStep.destroys, UndoRenderer.droppedTable / droppedColumn / retypedColumn
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema gate order, refuseUnacknowledgedDataLoss, dataLossRefusal, refusalPart
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # "destr_gate" block
  - packages/quereus/test/schema/differ-undo-plan.spec.ts      # rename + module-move repro, cannotUndo carries no destroys
  - docs/schema-declarative.md
  - docs/sql-ddl.md
  - docs/schema-undo-plan.md
  - docs/todo.md
----
# Gate every data-destroying `apply schema` step on `allow_destructive`

## What landed

- **Representation.** `MigrationStep.destroys` (type `DestroyedData`: a dropped table, a dropped column, or a retyped column) is set only by the three `UndoRenderer` arms that discard stored data, alongside their existing `irreversible` reason. An `irreversible` that only reports a catalog entry lacking its restore (`cannotUndo`) carries no `destroys`.
- **Gate.** `emitApplySchema` now builds the migration plan before any refusal, then calls `refuseUnacknowledgedDataLoss` unless `allow_destructive = true`. It refuses when any step has `destroys` or `diff.moduleMigrations` is non-empty, before `beginSchemaBatch`, so no DDL, hook or event happens. The old module-move-only gate and its message builder are gone. The dangling-foreign-key refusal for module moves now runs after the acknowledgement.
- **Message.** One error, grouped: dropped tables, dropped columns, retyped columns, plain module moves, maintained module moves. A module move's own `DROP TABLE` is described once, as the move. The rename-hint sentence is added when a table or column drop is listed.
- **Fix found during implementation.** `droppedTable` looked the table up by its pre-apply name, so a table renamed and moved to another module in one plan (dropped under its new name) was classified as a no-op drop. A later failure would then have tried to rename back a table the drop had destroyed. It now uses `tableNow` (lookup through the renames in force), like every other arm.
- **Tests.** One new sqllogic block (`destr_gate`); existing applies that intentionally destroy data now pass the flag (no assertion weakened); `10.5.7` § 12 drops five leftover tables so its "otherwise-empty main schema" comment is true.
- **Docs.** `schema-declarative.md`, `sql-ddl.md` (Safety rewritten; two stale "seed clears the table" statements corrected), `schema-undo-plan.md`, `todo.md`.

## Review findings

Read the `ticket(implement): apply-schema-destructive-acknowledgement` diff first, then the handoff.

**Correctness — checked, no defects found.**
- Gate placement: throws before `beginSchemaBatch` and before seeding; the applied-state fast path skips it only when the plan would be empty. Correct.
- `destroys` reaches `MigrationStep` through `pushText`'s spread of the `StepUndo`; only the three arms set it. Confirmed by reading every `irreversible` producer.
- Probed (throwaway script, deleted): a table renamed `a` → `B` and moved `memory` → `mem2`, plus a dropped table `gone`, lists `'gone'` as dropped and `'B'` once, as a move (case-insensitive match works). `allow_destructive = false` written explicitly behaves as absent.
- Bundle importer (`quereus-bundle/src/import-schema.ts`): its `isDestructive` covers every drop, `DROP COLUMN`, `DROP CONSTRAINT`, `SET DATA TYPE` and renames under `deny`, a superset of this gate, so the engine cannot refuse an import the bundle let through. No change needed.
- Other plan steps considered and not data-destroying: `ALTER PRIMARY KEY` (fails on duplicates rather than losing rows), `set maintained as` / `drop maintained`, view / index / assertion / constraint drops.

**Tests.**
- Added `differ-undo-plan.spec.ts` "a table renamed and moved to another module in one plan: the drop under the new name destroys the rows" — the reproduction of the `droppedTable` fix the implementer verified only by probe. Confirmed it fails with the old pre-apply-name lookup and passes with `tableNow`.
- Added one assertion to the existing `cannotUndo` test in the same file: those `irreversible` steps carry no `destroys`. This pins the ticket's central rule (the gate must not key on `irreversible`) on the steps that would break it.
- Reviewed every spec / sqllogic change in the implement diff: each only adds the flag to an apply that intentionally destroys data, or routes the flag through a shared helper (`applies`, `declareAndApply`, `refusedApply`, `expectRefused`). No assertion was loosened. The `10.5.7` table drops (instead of the flag) are the better choice: they make the section's comment true rather than masking it.
- No tests cut: the one new sqllogic block pins the gate's branching and message order; nothing restates the implementation.

**Docs.** Read every file the change touches plus `docs/bundle.md`, `docs/materialized-views.md` (§ backing-module change, line ~334), `docs/architecture.md` (line ~106) and `packages/quereus-bundle/README.md`. All remain accurate: they describe the module move as ack-gated or speak of destructive changes generally. Nothing stale found.

**Tripwires / accepted tradeoffs.**
- Every retype is gated, including lossless widenings. This was a settled decision in the plan and documented in `sql-ddl.md`, but not at the code site; added an accepted-tradeoff `NOTE:` at `UndoRenderer.retypedColumn` in `schema-differ.ts`.

**Hygiene.** `dataLossRefusal` / `refusalPart` are small and single-purpose; comments say why (decided from the plan, not row counts; why the move's drop matches by declared name). `schema-differ.ts` is very large, but that predates this ticket, which added about 20 lines; not filed.

**Major findings.** None. No tickets filed.

**Validation.**
- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn workspace @quereus/quereus test`: 11187 passing, 23 pending, 0 failing.
- Not re-run: other workspaces and `yarn test:store`. This pass changed only one quereus spec file and one comment, and the implementer ran both green on the same source.
