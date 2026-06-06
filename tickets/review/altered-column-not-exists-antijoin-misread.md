description: Review the fix for ADD COLUMN registering a new column-level FK into the live schema BEFORE validating existing rows. The FK-IND optimizer (`ruleAntiJoinFkEmpty` + seeded INDs) trusted the unvalidated FK and folded the validator's own `NOT EXISTS` anti-join to `EmptyRelation`, hiding the orphan and admitting a violating row. Fix registers the new column WITHOUT the new FK for the validation pass, commits the full schema (with FK) only after validation passes, and reverts the validator SQL to `NOT EXISTS`.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic, packages/quereus/test/logic/41.8-alter-add-constraint-unique-fk.sqllogic, docs/runtime.md
----

## What changed (implemented, build + tests green)

**Root cause** (confirmed): `ALTER TABLE … ADD COLUMN … REFERENCES p(pid)` registered the
enhanced schema **including the new column-level FK** into the live `SchemaManager`
*before* running the existing-row FK validation. The validator's `NOT EXISTS` anti-join
then matched `ruleAntiJoinFkEmpty` (the FK is declared, NOT NULL — Quereus columns default
to NOT NULL — and the parent side is row-preserving), so the anti-join folded to
`EmptyRelationNode` under the inclusion dependency `child.fk ⊆ parent.pk`. The IND is
**false during validation** (that is exactly what the scan is checking), so the orphan was
never found and the violating row was admitted. The same rule kept firing on every later
anti-join while the FK stayed declared-but-violated → looked like "persistent corruption".

**The fix** (three source edits + tests + docs):

1. `runtime/emit/alter-table.ts` (`runAddColumn`): build an intermediate `validationSchema`
   that contains the new **column** but **not** the new **FK(s)** (it reuses
   `updatedTableSchema.foreignKeys` — the module's pre-existing FK set — in place of
   `mergedForeignKeys`). Register `validationSchema` before the validation block; run the
   CHECK scan and `validateForeignKeyOverExistingRows` against it; on success register the
   full `enhancedTableSchema` (with FK). The revert path (drop column + restore original
   catalog) is unchanged. When there are no new FKs, `validationSchema === enhancedTableSchema`,
   so non-FK ADD COLUMN behavior is byte-identical to before. Mirrors the ADD CONSTRAINT
   ordering (validate before swapping the FK into the live schema).

2. `schema/constraint-builder.ts` (`validateForeignKeyOverExistingRows`): reverted the
   parent-present SQL from the LEFT-anti-join workaround back to the `NOT EXISTS` correlated
   subquery (textually aligned with the ADD CONSTRAINT validator; both correct post-fix).
   Removed `firstParentCol`/`matchChain`-on-outer-join scaffolding and the workaround comment
   that referenced this ticket slug. Parent-absent branch unchanged.

3. `docs/runtime.md` (~§ ADD COLUMN): replaced the LEFT-JOIN rationale blockquote with a
   description of the `NOT EXISTS` validator and the register-column-then-commit-FK-after-
   validation ordering.

4. Tests: `41.4-alter-add-column-constraints.sqllogic` gains **section 2m** (engine-bug
   guard): an orphan literal-default FK must abort (validator's `NOT EXISTS` surfaces the
   orphan — pre-fix it folded to empty), the reverted table reads correctly, and after a
   *valid* add the standalone `select id from c where not exists (select 1 from p where
   p.pid = c.parent)` returns `[]` and `select *` shows the backfilled column. Updated a now-
   stale comment in `41.8-alter-add-constraint-unique-fk.sqllogic` (it described the removed
   LEFT-anti-join form).

## Validation performed

- `yarn workspace @quereus/quereus typecheck` → exit 0
- `yarn workspace @quereus/quereus lint` → exit 0
- `yarn workspace @quereus/quereus test` (memory) → **4853 passing**, 9 pending, exit 0
- `yarn test:store` (full LevelDB store suite) → **4848 passing**, 14 pending, exit 0
- Targeted 41.4 + 41.8 pass in **both** memory and store mode.

The reproduction from the original ticket (orphan `default 99 references p(pid)` over a
populated child) now throws `FOREIGN KEY constraint failed` — encoded as test 2m.

## Use cases / what to probe (treat tests as a floor)

- **The load-bearing invariant**: correctness hinges on `module.alterTable` (ADD COLUMN)
  returning `updatedTableSchema.foreignKeys` that does **not** already contain the new
  column-level FK — the emit path owns column-level FK extraction/merge, the module only
  materializes the column. If a module *did* include it, `validationSchema` would still carry
  the FK and the fold would reappear (and `mergedForeignKeys` would duplicate it). This holds
  **empirically for both memory and store** (test 2m's orphan aborts in both; 2c asserts
  `foreign_key_info` count = 1, not 2). Worth a reviewer's eye to confirm no third module/path
  re-derives the FK into the validation schema.
- **Why passing `enhancedTableSchema` (with FK) as the validator's `childSchema` arg is
  safe**: `validateForeignKeyOverExistingRows` reads `childSchema` only for table/column
  *names* and parent resolution — it never reads `childSchema.foreignKeys`. The planner
  resolves the child table for `db.prepare(sql)` from the **live** schema manager
  (= `validationSchema`, no FK), not from the arg object. Confirm that indirection still holds.
- **CHECK + FK on the same ADD COLUMN**: `validationSchema` keeps the new CHECKs
  (`mergedChecks`) but drops the new FK. CHECKs don't drive `ruleAntiJoinFkEmpty`, and the
  check scan builds SQL directly from the constraint list, so this is sound — but there is no
  dedicated test for the *combination* of a new column-level CHECK and a new column-level FK
  in one statement. Minor coverage gap.
- **Composite FK existing-row validation** still goes through the multi-column match chain in
  the `NOT EXISTS` subquery (41.8 §10). The revert kept that path; 41.8 covers satisfied +
  orphan composite cases.
- **Self-referential FK** (parent == child) over existing rows: covered by 41.4 §2f/2g; the
  `NOT EXISTS` form with `_c`/`_p` aliases keeps the correlation unambiguous.

## Out-of-scope (NOT fixed here — flagged per ticket; no backlog filed)

The IND/FK-folding model assumes *declared FKs are hard inclusion dependencies; FK enforcement
is on*. If a user runs `pragma foreign_keys = off`, inserts orphans under a declared FK (or a
create-time nullable→NOT NULL FK column), then queries, a `NOT EXISTS` over that FK **still
folds to empty and hides the orphans**. This is "garbage in" under the stated soundness model
and is explicitly out of scope. No backlog ticket filed — the ticket says to file one only if
the team wants the optimizer to distrust FKs while `pragma foreign_keys = off`. Reviewer may
decide to file it.

## Known noise (not actionable here)

- IDE-only TS diagnostic: unused `schema` parameter in `rebuildViaShadowTable`
  (`alter-table.ts` ~line 1127). **Pre-existing** — that function is untouched by this fix; it
  surfaced only because re-analysis ran after the edit. `tsc --noEmit` (typecheck) and `eslint`
  both pass (exit 0), so it is not a build/lint failure. Left as-is to avoid scope creep.
