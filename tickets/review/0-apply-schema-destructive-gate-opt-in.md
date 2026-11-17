description: Review the change that makes the full `apply schema` data-loss gate opt-in through a new database option, `destructive_apply_policy`, whose default restores the behaviour from before the gate (only moving a table to another module needs `allow_destructive = true`).
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/core/database.ts                     # registerOption('destructive_apply_policy'), right after ddl_transaction_policy
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema gate call (~line 384), isDestructiveApplyStrict + refuseUnacknowledgedDataLoss (~line 578)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # default-policy block + strict-policy block (search `destr_default`, `destr_gate`)
  - docs/schema-declarative.md, docs/sql-ddl.md, docs/schema-undo-plan.md, docs/usage.md, docs/todo.md
----
# Make the full `allow_destructive` gate opt-in — review handoff

## What changed

- **New option `destructive_apply_policy`** (`database.ts`), registered exactly like `ddl_transaction_policy`: string, default `'permissive'`, `onChange` rejects anything but `'permissive'` / `'strict'` with `Invalid destructive_apply_policy value: … Must be "permissive" or "strict"`. Settable by `db.setOption` and `pragma`.
- **Gate** (`schema-declarative.ts`): `emitApplySchema` still calls `refuseUnacknowledgedDataLoss` only when `allow_destructive` is not true, now passing `strict = isDestructiveApplyStrict(rctx.db)`. Under `'permissive'` the `destroys` list is passed empty, so only `diff.moduleMigrations` can trigger the refusal and the same `dataLossRefusal` builder writes the message (the rename-hint sentence drops out because no table/column drop is listed). Under `'strict'` behaviour is identical to before this ticket. `MigrationStep.destroys` is untouched; it is still populated regardless of policy.
- **When the option is read:** at run time, inside the apply's `run()` closure, the same place `ddl_transaction_policy` is read for its gate. So `pragma destructive_apply_policy = …` set between prepare and run governs the run.
- **Ordering vs. the dangling-rows check:** unchanged from the gate ticket: the plan is built, then the acknowledgement gate, then `refuseModuleMoveLeavingDanglingRows`. Before the gate ticket the module-move refusal ran before the plan was built; the observable result (refusal before any DDL) is the same.
- **Refusal wording under `'permissive'`** is the gate ticket's wording ("this migration destroys stored data: table(s) 't' (memory → mem2) would be moved to another module …"), not the pre-gate "moving a table to another module is destructive: …" text, since the ticket asked to reuse the one message builder.

## Tests

- `50-declarative-schema.sqllogic`, new block `destr_default`: with no pragma set, an `apply schema` that drops column `t.a` (with a row present) succeeds unacknowledged and `select *` shows only `id`. Pins the default.
- Same file, block `destr_gate`: now begins with `pragma destructive_apply_policy = 'strict'` and resets to `'permissive'` at its end. It still pins the strict refusal (table drop + column drop + retype listed in one error, nothing changed, then success with the flag).
- **Module move refused under the default:** not added in sqllogic. It needs a second registered module, and `declarative-equivalence.spec.ts` (the `mem2` test near line 2025, plus the backing-module test near line 1669) already runs it on a default `new Database()` and asserts the refusal. Those passed unchanged.
- No invalid-value test: `ddl_transaction_policy` has none to mirror.
- The `options (allow_destructive = true)` added to many applies by the gate ticket were left in place, as the ticket asked.

## Validation run

- `yarn workspace @quereus/quereus lint`: clean.
- `yarn build`: clean.
- `yarn test` (all workspaces): all green; quereus 11185 passing, quereus-sync 879, every other suite passing, no failures.
- `yarn docs:check`: OK. `docs/invariants.md` not touched (it has no entry describing the gate).
- Not run: `yarn test:store`. The new sqllogic block only drops a column, which the strict block already does through the store path with the flag, but nobody has run it against the LevelDB module.

## Docs updated

- `docs/schema-declarative.md`: `moduleMigrations` bullet, the "Destructive changes…" paragraph (policy, default, why the default exists, how to opt in), the Applied-state "Why skipping is sound" parenthetical, and § Failure and restoration (the all-or-nothing guarantee is unconditional only under `'strict'`; under `'permissive'` an unacknowledged apply can carry the irreversible-step residual, as before the gate).
- `docs/sql-ddl.md`: new Migration Application bullet; Safety bullet rewritten around the two policies, with `pragma destructive_apply_policy = 'strict'` in the example; the `rename_policy = 'deny'` note and the module-move paragraph qualified by policy.
- `docs/schema-undo-plan.md`: `destroys` is gated under `'strict'` and populated under either policy.
- `docs/usage.md`: new row in the Available Options table. (`ddl_transaction_policy` itself is not in that table; I did not add it, since it was out of scope.)
- `docs/todo.md`: the checked item and the "Safe by default" design-principle bullet (renamed "Acknowledged destruction") no longer claim every destructive step needs the flag.
- `packages/quereus-bundle`: no change. It classifies destructive statements itself, passes `allow_destructive = true` only when its caller allows destruction, and its README/`docs/bundle.md` don't claim the engine gate is always on.

## Things a reviewer might check

- Whether describing the move's own `DROP TABLE` only as the move (by passing an empty `destroys` list under `'permissive'`) is the right reading of "filter the collected entries down to the module-move ones". It gives the same message as filtering `destroys` down to the moved tables, because `dataLossRefusal` already hides those.
- Explicit `allow_destructive = false` acts the same as leaving it out under both policies. I checked this by reading the code (`!applyStmt.options?.allowDestructive`), not with a test.
