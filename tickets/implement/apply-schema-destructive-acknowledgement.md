description: Applying a declared schema silently drops any table or column the declaration no longer mentions, and silently converts a column whose type changed. Make it refuse those changes before running anything unless the user passes the existing allow_destructive option, as it already does for moving a table to another storage module.
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/schema/schema-differ.ts              # MigrationStep, StepUndo, UndoRenderer.droppedTable / droppedColumn / retypedColumn (≈ lines 85–100, 3981, 4098–4111)
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema (the moduleMigrations gate ≈ line 378), moduleMigrationRefusal (≈ line 582), fast-path comment (≈ line 353)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # the one new test block
  - docs/schema-declarative.md                                # § Declarative Schema (lines 16, 18), § Applied-state snapshot (line 35), § Failure and restoration (line 153)
  - docs/sql-ddl.md                                           # § Semantics and Features → Safety bullets, Migration Application bullets
  - docs/schema-undo-plan.md                                  # the three-irreversible-steps paragraph (line 34)
difficulty: medium
----
# Gate every data-destroying `apply schema` step on `allow_destructive`

## Background

`apply schema` compares the declared schema against the live catalog and runs a migration plan (`generateMigrationPlan` in `schema-differ.ts`). Since the undo plan landed, the apply path builds that plan with the pre-apply catalog, so every step carries either `undo` (statements that reverse it) or `irreversible` (a reason why nothing can). Three arms of `UndoRenderer` produce `irreversible` because the step discards stored data:

- `droppedTable` — `DROP TABLE IF EXISTS t` of a table that exists (rows lost). This includes the drop half of a module move.
- `droppedColumn` — `ALTER TABLE t DROP COLUMN c` (values lost).
- `retypedColumn` — `ALTER TABLE t ALTER COLUMN c SET DATA TYPE T` (values converted; a conversion can lose information).

Each arm already returns `NOTHING_TO_UNDO` instead when the pre-apply catalog does not hold the target, so a no-op `IF EXISTS` drop is not classified as data loss.

Other arms also return `irreversible`, through `cannotUndo`, when the catalog lacks what a restore needs (a hand-built catalog with no body AST, an index whose DDL does not parse). Those destroy nothing. **The gate must not key on `irreversible` being present**; it needs its own field.

Today `allow_destructive` gates exactly one case: `diff.moduleMigrations` (a table moving to another module, realized as drop + recreate). `docs/schema-declarative.md` says "Destructive changes require explicit acknowledgement. The module move is the one case currently enforced" and `docs/sql-ddl.md` says "a general `allow_destructive` gate over all destructive schema changes remains future work". This ticket is that work: the specification already states the rule, and the code does not enforce it yet.

## Decisions (settled; do not reopen)

- **Gate all three steps as one class, behind the one existing option.** These are exactly the steps that make the apply's all-or-nothing guarantee conditional (docs § Failure and restoration). Gating all of them makes that residual something the user chose. Separate options per kind would add surface and nobody has asked for it. Tradeoff accepted: a widening retype that loses nothing (say `integer` → `real`) also needs the flag, because the plan cannot tell lossless conversions from lossy ones. If that ever matters, refine `retypedColumn`; the gate follows the classification automatically.
- **Decide from the plan's structure, never from row counts.** A drop of an empty table is still refused. If the gate depended on data, a start-up apply that passes against an empty development database would fail in production. It also would need a scan before the plan runs.
- **Existing embedders whose start-up apply drops something will now fail with a clear message.** AGENTS.md says "Backwards compat: don't worry yet", and the feature is Beta. The migration is to add `options (allow_destructive = true)` to the apply, or to add a rename hint where the drop was really an unhinted rename. The error message says both.
- **`diff schema` is unchanged.** It stays a read-only, ungated preview with one `ddl` column. Marking destructive rows in the preview is parked in `backlog/feat-diff-schema-marks-data-loss-steps`.
- **The module-move gate is folded into the new gate.** One refusal lists everything at risk. The module-move wording keeps its two descriptions: a plain table "dropped and recreated empty — their rows are lost", and a maintained table "dropped and re-materialized as a new incarnation". No test matches the old message text literally (checked with `grep -rln "to another module is destructive"`), so the wording can change freely.
- **No production caller is affected.** The probe described below and a grep showed that, outside the engine, nothing runs `apply schema` against a physical schema. Sync, store and isolation reach it only through lens deployments, which return before any diff. The bundle importer (`packages/quereus-bundle/src/import-schema.ts`) classifies destructive statements itself first, using a strict superset of this ticket's three steps (any drop, constraint drops, renames under `deny`). It passes `allow_destructive = true` only when the caller set `allowDestructive`. So the engine gate can never refuse a bundle import that the bundle's own check let through. No bundle change.

## Design

### Representation — `schema-differ.ts`

Add a structured description of what a step destroys, beside the human-readable reason:

```ts
/** What a migration step destroys: the stored data no statement can put back. */
export type DestroyedData =
	| { readonly kind: 'table'; readonly table: string }
	| { readonly kind: 'column' | 'retype'; readonly table: string; readonly column: string };
```

- `MigrationStep` gains `readonly destroys?: DestroyedData`, documented as: set together with `irreversible` by exactly the three data-destroying steps, present only when the plan was built with the pre-apply catalog, and read by the apply-time `allow_destructive` gate.
- `StepUndo`'s irreversible arm becomes `{ readonly irreversible: string; readonly destroys?: DestroyedData }`. `pushText` already spreads the result into the step, so the field reaches `MigrationStep` with no other change.
- `droppedTable` / `droppedColumn` / `retypedColumn` return `destroys` alongside their existing `irreversible` text. Table and column names are as the step spells them: the post-rename spelling, which is what the user's declaration says.
- Export `DestroyedData` from wherever `MigrationStep` is exported (`grep -n "MigrationStep" packages/quereus/src/index.ts`).

### The gate — `runtime/emit/schema-declarative.ts`

In `emitApplySchema`'s full-reconcile branch, reorder to:

1. `computeSchemaDiff` (unchanged).
2. `generateMigrationPlan(diff, schemaName, actualCatalog)`, moved up from below `refuseModuleMoveLeavingDanglingRows`. It is a pure function of its arguments.
3. **New:** `if (!applyStmt.options?.allowDestructive) refuseUnacknowledgedDataLoss(schemaName, migrationStatements, diff)`. This replaces the `diff.moduleMigrations.length > 0` check.
4. `refuseModuleMoveLeavingDanglingRows` (unchanged; it matters only once the move is acknowledged).
5. The rebuild refusal and the migration loop (unchanged).

The refusal throws `QuereusError(…, StatusCode.ERROR)` before `beginSchemaBatch`, so no DDL runs, no module hook fires and no schema event is batched. Nothing needs undoing or retracting.

`refuseUnacknowledgedDataLoss` collects `step.destroys` for every step that has it. If there are none it returns. Otherwise it throws a message built by a small pure function that replaces `moduleMigrationRefusal`:

```
apply schema '<schema>': this migration destroys stored data: <part>; <part>; …. Re-run with options (allow_destructive = true) to migrate.
```

The parts appear in this order, and each appears only when it has names. Names are quoted and comma-joined, as today:

- `table(s) 'a', 'b' would be dropped with their rows` — `kind: 'table'` entries whose name is not a module move.
- `column(s) 't.c' would be dropped with their values` — `kind: 'column'`.
- `column(s) 't.d' would change type, which can lose values` — `kind: 'retype'`.
- `table(s) 'x' (memory → mem2) would be moved to another module by dropping and recreating them empty — their rows are lost` — plain module moves (`diff.moduleMigrations`, `maintained: false`).
- `maintained table(s) 'mv' (memory → mem2) would be moved to another module by dropping and re-materializing them as a new incarnation` — maintained module moves.

When any table or column drop is listed, append one more sentence after the "Re-run" sentence: `A renamed table or column keeps its data only with a rename hint (the quereus.previous_name tag).`

A module move's `DROP TABLE` step also carries `destroys: { kind: 'table' }`. Match it to `diff.moduleMigrations` by name, case-insensitively, so it is described once, as a move. A module move whose table is also renamed drops under the old name. Match through `diff.renames` exactly as `refuseModuleMoveLeavingDanglingRows` does (`r.newName` → `r.oldName`), or describe it by the moved name whichever way the step spells it. Either way it must not appear twice.

Update the `emitApplySchema` comments that describe the gate (the fast-path comment's "`allow_destructive` only gates a non-empty `diff.moduleMigrations`" becomes "only gates a plan that destroys data, and an unchanged schema's plan is empty").

### Existing tests that now need the acknowledgement

A temporary probe (gate on the three `irreversible` texts, then reverted) run over `packages/quereus/test/**/*.spec.ts` failed 35 of about 11,150 tests. Every failure was an `apply schema` that intentionally drops or retypes. The fix in each is to add `options (allow_destructive = true)` to that apply. Do **not** weaken an assertion. Files that failed:

- specs: `apply-schema-alter-order.spec.ts` (6), `apply-schema-index-order.spec.ts` (1), `apply-schema-restore.spec.ts` (7), `apply-schema-unchanged-fast-path.spec.ts` (3), `schema-batch-hook.spec.ts` (1), `maintained-table-migration-capstone.spec.ts` (1), plus the suites titled "assertion body validation: declarative routes that used to brick writes", "DDL schema-event atomicity on the engine's own fallback path", "DDL schema-event atomicity on an emitter-backed module", "Declarative fresh-vs-upgrade constraint equivalence" (5) and "Maintained-table differ — review coverage" (2). Find them with `grep -rln "<suite title>" packages/quereus/test`.
- sqllogic: `10.5.7-implicit-unique-index-lifecycle`, `41.15-alter-column-default-type-check`, `50-declarative-schema`, `50.1-declare-schema-pk`, `50.2-declare-schema-renames`, `50.4-declare-schema-apply-restore`. A sqllogic file stops at its first failure, so each may hold more than one site. Rerun until clean.
- The probe did not cover `quereus-store`, `quereus-sync` and `quereus-isolation` tests, which import the built `dist`. Run `yarn build` and then `yarn test`. Candidates from a grep: `quereus-store/test/rehydrate-catalog.spec.ts`, `quereus-store/test/apply-undo-restores-unique.spec.ts`, `quereus-sync/test/sync/sync-drain-e2e.spec.ts`, `quereus-sync/test/sync/_peer-harness.ts`, `quereus-isolation/test/isolation-layer.spec.ts`.
- `yarn test:store` re-runs the logic files against LevelDB. Run it once at the end, because the sqllogic edits are the same files.

Some restore tests deliberately use a destructive step to reach the "partially migrated" path (for example `schema-batch-hook.spec.ts` "an irreversible step leaves the apply in place and reports it"). They keep testing that path, now with the flag. After this ticket that path is reachable only with the flag, which is the point.

Note: the quereus `yarn test` script passes `--bail`. To see every failure at once, run mocha directly: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/**/*.spec.ts" --reporter spec` from the repo root. With `--reporter dot` piped through `tee`, the probe run's output was cut off before the summary; `spec` printed it.

### Docs

- `docs/schema-declarative.md`:
  - Line 16 (`moduleMigrations` bullet): keep, but say it is gated with the other data-destroying steps.
  - Line 18: rewrite. `apply schema` refuses, before any DDL runs, a plan that drops a table, drops a column or changes a column's type (the steps the plan marks as destroying data, `MigrationStep.destroys`), and a module move, unless re-run with `options (allow_destructive = true)`. Decided by the plan, not by row counts. Mention rename hints as the alternative for an unintended drop. Keep the dangling-foreign-key sentence.
  - Line 35: update the parenthetical about `allow_destructive`.
  - Line 153 (§ Failure and restoration): the residual stays as stated. Add that a plan containing one of those steps runs only after the user acknowledged it, so an unacknowledged apply is unconditionally all-or-nothing.
- `docs/sql-ddl.md` § Semantics and Features:
  - Rewrite the `allow_destructive` Safety bullet from "enforced for one case today" to the general rule, with an example refusal message for a dropped column. Keep the module-move detail as a sub-case. Remove "Other drops are not yet gated — … remains future work".
  - Fix two stale seed statements found while planning: "Seed data application is destructive (clears table before inserting)" and "`with seed` clears existing data and inserts declared seed rows". Seeding is `INSERT … ON CONFLICT (pk) DO NOTHING` and clears nothing (see the seed comment in `emitApplySchema`).
- `docs/schema-undo-plan.md` line 34: one sentence saying those three steps also carry `destroys`, which the apply gates on `allow_destructive`.

## Edge cases & interactions

- **An `irreversible` step that is not data loss** (from `cannotUndo`) is not gated. Verified by inspection: only the three arms set `destroys`.
- **An `IF EXISTS` drop of an absent object** stays `NOTHING_TO_UNDO`, so no `destroys` and no refusal. By inspection.
- **Unhinted rename under `rename_policy = 'allow'`** becomes drop + create, so it is refused, with the rename-hint sentence. This is intended. **`rename_policy = 'deny'`** turns even a hinted rename into drop + create, so it is refused too. `50-declarative-schema.sqllogic` line ~2039 already combines `allow_destructive = true, rename_policy = 'deny'`; check that it still behaves as written.
- **Module move together with a rename of the same table**: described once, as a move (see Design).
- **Maintained table removed from the declaration**: its `DROP TABLE` goes through `droppedTable`, so it is gated, consistent with the maintained module move already being gated. Check that `UndoRenderer.tables` holds maintained tables (it is built from `actual.tables`). If it does not, that is a pre-existing undo-classification gap: report it, do not special-case the gate.
- **`set maintained as` / `drop maintained` (attach / detach)** are non-destructive alter steps with no `destroys`, so they are not gated. By inspection.
- **`allow_destructive = false` written explicitly** behaves as absent. The parser already yields a boolean.
- **Applied-state fast path**: an unchanged schema skips the diff, so no plan and no gate. Unaffected.
- **Logical (lens) schemas** return before the diff. Unaffected.
- **Inside an explicit transaction**: the refusal throws before any batch or DDL, so the transaction stays open and unchanged. By inspection.
- **`with seed`**: seeding runs after the loop and never runs on a refused apply. By inspection.
- **Error ordering**: generating the plan before `refuseModuleMoveLeavingDanglingRows` may change which error an unacknowledged move with dangling child rows reports. It now reports the acknowledgement refusal first, which is the more useful message. A test pinning the old order should be updated to send the flag.
- **Bundle import**: covered under Decisions. No change, and the bundle's tests must still pass.

## Test (the one new one)

Add a block to `packages/quereus/test/logic/50-declarative-schema.sqllogic` that pins the gate's branching. Use a fresh schema name so it does not interact with earlier blocks:

- Declare and apply a schema with table `keep(id integer primary key, a text, b text)` and table `gone(id integer primary key)`, and insert a row into each.
- Redeclare it without `gone`, without `keep.a`, and with `keep.b` as `integer`. `apply schema` → `-- error:` matching `this migration destroys stored data` and naming `'gone'`, `'keep.a'` and `'keep.b'`.
- Select from `gone` and `keep`: rows and columns intact (nothing ran).
- `apply schema … options (allow_destructive = true)` succeeds, and `gone` is then not found.

Do not add a separate test for the module-move wording. The existing module-move tests cover that path once they are updated.

## TODO

- Add `DestroyedData` and `MigrationStep.destroys`; widen `StepUndo`'s irreversible arm; set `destroys` in `droppedTable` / `droppedColumn` / `retypedColumn`; export the type.
- In `emitApplySchema`: move plan generation above the gate, replace the `moduleMigrations` gate with `refuseUnacknowledgedDataLoss`, and replace `moduleMigrationRefusal` with the general message builder. Update comments.
- Add the sqllogic test block.
- Add `options (allow_destructive = true)` to each existing test apply that intentionally destroys data (list above) until `yarn test` is green across all workspaces after `yarn build`.
- Run `yarn lint` (quereus type-checks test files) and `yarn test:store` once.
- Update `docs/schema-declarative.md`, `docs/sql-ddl.md` (including the two stale seed statements) and `docs/schema-undo-plan.md` as listed.
