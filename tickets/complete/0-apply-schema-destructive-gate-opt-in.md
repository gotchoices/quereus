description: The full `apply schema` data-loss gate is now opt-in through a database option, `destructive_apply_policy`. Its default, `'permissive'`, restores the behaviour from before the gate, where only moving a table to another module needs `allow_destructive = true`. `'strict'` turns the full gate back on.
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/core/database.ts                     # registerOption('destructive_apply_policy'), right after ddl_transaction_policy
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema gate call, isDestructiveApplyStrict + refuseUnacknowledgedDataLoss
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # default-policy block + strict-policy block (search `destr_default`, `destr_gate`)
  - docs/schema-declarative.md, docs/sql-ddl.md, docs/schema-undo-plan.md, docs/usage.md, docs/todo.md
----
# Make the full `allow_destructive` gate opt-in

## What landed

The commit is `ticket(implement): apply-schema-destructive-gate-opt-in`.

- New string option `destructive_apply_policy` in `database.ts`, registered the same way as `ddl_transaction_policy`. It defaults to `'permissive'`, and its `onChange` rejects any value other than `'permissive'` or `'strict'`. It can be set with `db.setOption` or with `pragma`.
- `emitApplySchema` reads the policy at run time, inside the apply's `run()` closure, which is the same place `ddl_transaction_policy` is read. So a pragma set between prepare and run governs the run.
- `refuseUnacknowledgedDataLoss` takes a `strict` flag:
  - Under `'permissive'` it passes an empty `destroys` list, so only `diff.moduleMigrations` can trigger a refusal. The message comes from the same `dataLossRefusal` builder, and the rename-hint sentence drops out.
  - Under `'strict'` behaviour is the same as before this ticket.
  - `MigrationStep.destroys` is still populated under either policy.
- Tests:
  - New sqllogic block `destr_default`: under the default policy, a column drop needs no acknowledgement.
  - The `destr_gate` block now runs under `pragma destructive_apply_policy = 'strict'` and resets the policy at its end.
  - `declarative-equivalence.spec.ts` (the `mem2` test) already checks that a module move is refused on a default `new Database()`.
- Docs updated: `docs/schema-declarative.md` (the `moduleMigrations` bullet, the destructive-changes paragraph, the "Why skipping is sound" note under Applied-state snapshot, and § Failure and restoration), `docs/sql-ddl.md` (Migration Application and Safety), `docs/schema-undo-plan.md`, `docs/usage.md` (options table) and `docs/todo.md`.

## Review findings

**Checked**
- Read the implement diff, then the surrounding gate code: `dataLossRefusal`, `refuseModuleMoveLeavingDanglingRows`, and the applied-state fast path.

**Correctness**
- Passing an empty `destroys` list under `'permissive'` gives the same message as filtering `destroys` down to the moved tables, because `dataLossRefusal` already leaves out a moved table's own drop.
- Under `'permissive'`, a plan that both moves a table and drops a column lists only the move. That is correct, because the column drop needs no acknowledgement under that policy.
- Explicit `allow_destructive = false` behaves the same as leaving it out (`!applyStmt.options?.allowDestructive`).
- The applied-state snapshot does not need to record the policy: a skipped apply has an empty plan, so nothing would be gated.
- No defects found.

**Interactions**
- `quereus-bundle` (`import-schema.ts`) classifies destructive statements itself and refuses them unless `allowDestructive` is set. Its README and `docs/bundle.md` make no claim about the engine gate. No change needed.
- No other package (CLI, web, sync, store) refers to `allow_destructive`.
- No spec assumed the gate was on by default. Every spec that deliberately drops data already passes `allow_destructive = true`.

**Docs**
- Read every doc the change touched, and checked them against the code. They are accurate.
- Looked for other option or pragma lists that should name the new option. `docs/usage.md` has the only options table, and `packages/quereus/README.md` has none.
- `docs/invariants.md` has no entry describing the gate, so it needed no change.

**Minor, fixed in this pass**
- The fast-path comment in `emitApplySchema` explained why skipping is safe by naming only `allow_destructive`. It now names `destructive_apply_policy` too, matching `docs/schema-declarative.md`.

**Tests**
- The new tests meet the bar: one pins the default behaviour, and the retargeted block pins the strict behaviour. Nothing to cut.
- No invalid-value test, consistent with `ddl_transaction_policy`.

**Code quality**
- `isDestructiveApplyStrict` is a small single-purpose helper.
- The inline comment in `refuseUnacknowledgedDataLoss` gives the reason the `destroys` list is passed empty. It does not narrate the code.

**Tripwires**
- None.

**Major findings and tickets filed**
- None.

**Validation**
- `yarn workspace @quereus/quereus lint`: clean.
- `yarn workspace @quereus/quereus test`: 11185 passing, 23 pending.
- `yarn test:store --grep 50-declarative-schema` (the LevelDB store path the implementer did not run): passing.
