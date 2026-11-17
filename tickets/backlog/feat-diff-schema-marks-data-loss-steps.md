description: The schema-diff preview lists the statements a migration would run but does not say which of them would destroy stored data, so a person or tool reviewing it has to work that out from the statement text.
prereq: apply-schema-destructive-acknowledgement
architecture: docs/schema-declarative.md#declarative-schema
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitDiffSchema — builds the plan without the pre-apply catalog today
  - packages/quereus/src/schema/schema-differ.ts              # generateMigrationDDL / generateMigrationPlan, MigrationStep.destroys
  - packages/quereus-bundle/src/import-schema.ts              # isDestructive — the bundle's own text-based classification
  - docs/sql-ddl.md                                           # § Diffing and Applying — the diff schema result shape
tradeoffs: Adding a column changes the result shape of `diff schema` for every consumer, and the bundle importer deliberately counts more statements as destructive (view, index and constraint drops) than the engine's data-loss set, so it could not simply switch to the engine's answer.
----
# `diff schema` says which steps destroy data

After `apply-schema-destructive-acknowledgement`, `apply schema` refuses a plan containing a data-destroying step (`DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN … SET DATA TYPE`, and a module move) unless `allow_destructive = true` is passed. It decides this from `MigrationStep.destroys`, which the planner sets only when it is handed the pre-apply catalog.

`diff schema` is the read-only preview of the same plan. Today it returns one `ddl` column per statement and builds the plan without the catalog, so it computes no `destroys`. A reviewer, or a start-up routine that wants to warn before it applies, has to recognise the destructive statements from their text.

## What this would be

`diff schema` reports, for each statement, whether `apply schema` would require the acknowledgement for it. For example a second result column `destroys` holding null, or a short description (`table 'gone'`, `column 'keep.a'`, `retype 'keep.b'`). That would mean building the preview plan with the catalog, as the apply path does. The undo rendering that comes with it is cheap (see the `NOTE:` on `UndoRenderer`).

## Questions for whoever picks it up

- A new column or a separate statement form (for example `diff schema main options (…)`). Every current reader of `diff schema` reads only `ddl`.
- Whether the bundle importer's `isDestructive` should consult the engine's answer for the data-loss subset and keep its own wider rules for the rest (view, index and constraint drops, renames under `deny`), or stay as it is.
