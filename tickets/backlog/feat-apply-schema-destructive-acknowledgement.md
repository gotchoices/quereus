description: Applying a declared schema silently drops any table or column the declaration no longer mentions; it should ask the user to confirm first, the way it already does for one other data-losing change.
architecture: docs/schema.md#declarative-schema
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema — the existing allow_destructive gate, which today covers only one case
  - packages/quereus/src/schema/schema-differ.ts              # MigrationStep.irreversible — the classification this gate would read
  - docs/schema.md                                            # § Declarative Schema — "Destructive changes require explicit acknowledgement"
  - docs/sql-ddl.md                                           # § Declarative schema — the options/gating contract
tradeoffs: Removing a table or column from the declaration is the normal way to drop it, so gating that on an option makes the everyday convergence path fail until the user adds one — a maintainer could reasonably say the acknowledgement should stay reserved for the incarnation-minting case it was built for.
----
# Extend `allow_destructive` to cover the data-losing migration steps

## What is in place today

`apply schema` compares a declared schema against the live database and migrates the difference. When the declaration no longer mentions a table or a column, the migration drops it, and the rows go with it. No confirmation is asked for.

There is already an acknowledgement mechanism: `apply schema main options (allow_destructive = true)`. It guards exactly one case — changing the backing storage module of a maintained table, which is realised as a drop and recreate and so changes row identity for a replicated table. `docs/schema.md` describes that case as "the one case currently **enforced**", which reads as an acknowledgement that the others were meant to be covered and are not yet.

## What this would be

Refuse an apply whose migration plan contains a step that destroys data, unless the user opted in with `allow_destructive = true`. After `apply-schema-undo-plan` lands, the plan already classifies each step, and there are exactly three such steps: dropping a table, dropping a column, and changing a column's data type (the conversion can lose values). The refusal would happen before any DDL runs, name the objects at risk, and be lifted by the existing option.

## Why it is worth considering

Beyond the obvious "do not silently delete data": it is what would make `apply schema`'s all-or-nothing guarantee unconditional. `apply-schema-rollback-journal` restores the catalog when a migration fails partway, but it cannot restore rows a step already destroyed, so a plan containing one of these three steps keeps a stated residual — the apply is atomic only up to the first of them. Gating those steps behind an explicit acknowledgement turns the residual into something the user chose.

## What a design pass has to answer

- Whether an existing embedder's start-up apply would now fail, and what the migration story is for them. This is the whole of the objection.
- Whether the three steps should be gated as one class or separately — dropping a column a declaration never mentioned is a different kind of surprise from a deliberate retype.
- Whether `diff schema` should mark the destructive steps in its preview, and how.
- Whether a narrower default would serve better, e.g. gating drops but not retypes.
