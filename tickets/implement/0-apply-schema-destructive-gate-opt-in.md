description: The new `apply schema` gate that refuses every data-destroying step unless `allow_destructive = true` is passed would break embedders whose start-up apply evolves their schema by editing the declaration (Sereus's `apply schema CadreControl` runs on every node at start-up). Keep the gate, but make it opt-in through a new database option, `destructive_apply_policy`, defaulting to the pre-gate behaviour.
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/core/database.ts                     # registerOption block (~line 400–440); mirror `ddl_transaction_policy`
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema gate (~line 386), refuseUnacknowledgedDataLoss (~line 581)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # the gate's test block from `apply-schema-destructive-acknowledgement`
  - docs/schema-declarative.md, docs/sql-ddl.md, docs/schema-undo-plan.md, any pragma/options reference listing `ddl_transaction_policy`
  - packages/quereus-bundle/src/import-schema.ts              # check only: the importer classifies destructive statements itself
----
# Make the full `allow_destructive` gate opt-in

## Decision (maintainer, 2026-11-17; do not reopen)

`apply-schema-destructive-acknowledgement` (landed as `ticket(implement): apply-schema-destructive-acknowledgement`) made `apply schema` refuse any plan that drops a table, drops a column or changes a column's type unless run with `options (allow_destructive = true)`. Keep that code, but **flip the default**: by default an `apply schema` behaves as it did before that ticket, gating only the module move. The full gate is enabled per database.

## Design

- **New option `destructive_apply_policy`**, registered like `ddl_transaction_policy` (same validation style and error wording, settable by option and by `pragma`). Values:
  - `'permissive'` (**default**): only a module move (`diff.moduleMigrations`, plain or maintained) is refused without `allow_destructive = true` — exactly the behaviour before the gate landed. Table drops, column drops and retypes run without acknowledgement.
  - `'strict'`: the full gate as it stands today — every step with `MigrationStep.destroys`, plus module moves.
- **One refusal function.** Under `'permissive'`, filter the collected entries down to the module-move ones and reuse the same message builder; don't reintroduce `moduleMigrationRefusal` as a separate path. The rename-hint sentence appears only when a table/column drop is listed, so it naturally drops out under `'permissive'`.
- `allow_destructive = true` lifts the refusal under either policy. `MigrationStep.destroys` stays populated regardless of policy (it is plan data, not gate data).
- Read the option at apply time (emit or run time — wherever `ddl_transaction_policy` is read for its gate), so changing the pragma between prepare and run behaves the way that option already does. Note the choice in the review handoff.

## Tests

- The previous ticket added `options (allow_destructive = true)` to many existing applies. **Leave those in place** — they are harmless under the default and keep those tests valid if a suite runs strict.
- Retarget the gate's own test block (in `50-declarative-schema.sqllogic`) to set `pragma destructive_apply_policy = 'strict'` first, so it still pins the strict refusal.
- Add one small block pinning the default: with no pragma, an apply that drops a column succeeds and the column is gone; a module move is still refused without the flag. Add an invalid-value case only if `ddl_transaction_policy` has one to mirror.
- No other new tests.

## Docs (must be updated in the same change)

- `docs/schema-declarative.md` § Declarative Schema (the "Destructive changes require explicit acknowledgement" paragraph and the `moduleMigrations` bullet), § Applied-state snapshot parenthetical, § Failure and restoration: describe the policy, its default, and that the all-or-nothing guarantee is unconditional only under `'strict'` (under `'permissive'` the residual from the irreversible steps stands, as before the gate).
- `docs/sql-ddl.md` § Semantics and Features (Safety / Migration Application bullets): same; include the pragma and an example.
- `docs/schema-undo-plan.md`: the `destroys` sentence says the gate applies under `destructive_apply_policy = 'strict'`.
- Wherever options/pragmas are listed (grep `ddl_transaction_policy` across `docs/` and `packages/quereus/README.md`), add `destructive_apply_policy`.
- `docs/invariants.md` is 13 words under its 12,000-word cap: do not add words there; if an existing entry describes the gate, adjust it within its current length.
- `yarn docs:check` must pass.

## Edge cases & interactions

- Default database, unacknowledged module move: still refused (unchanged since before the gate). By test.
- `'strict'` + `allow_destructive = true`: runs. Covered by the existing applies that carry the flag.
- Explicit `allow_destructive = false` behaves as absent under both policies. By inspection.
- Bundle import (`quereus-bundle`): classifies destructive statements itself; confirm its tests still pass and that its docs don't claim the engine gate is always on.
- Sync/store/isolation reach `apply schema` only through lens deployments, which return before the diff. Unaffected; confirm by the full test run.

## TODO

- [ ] Register `destructive_apply_policy` in `database.ts`
- [ ] Gate on it in `emitApplySchema` / `refuseUnacknowledgedDataLoss`
- [ ] Retarget the strict test block; add the default-behaviour block
- [ ] Update every doc listed above; `yarn docs:check`
- [ ] `yarn lint`, `yarn build`, `yarn test`
