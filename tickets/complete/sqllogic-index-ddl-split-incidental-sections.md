description: Five shared SQL test files used stand-alone index statements without announcing it, so a storage backend lacking them would die partway through each file. The one file about indexes now announces it; the index-using sections of the other four moved into small sibling files that announce it, so the rest keeps running everywhere.
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic/11.3-index-nested-loop-join.sqllogic
  - packages/quereus/test/logic/03.6-type-system.sqllogic
  - packages/quereus/test/logic/03.6.4-real-bigint-secondary-index.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/logic/15.1.2-semantic-ordering-index.sqllogic
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic
  - packages/quereus/test/logic/41.2.4.1-ddl-rollback-states-unique-index.sqllogic
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic
  - packages/quereus/test/logic/50.4.1-declare-schema-apply-restore-index.sqllogic
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - docs/memory-table.md
----

# `standalone-index-ddl` capability splits for five `.sqllogic` files

## What landed

- `11.3-index-nested-loop-join` declares `-- requires-capability: standalone-index-ddl` (the whole file is about indexes).
- `03.6-type-system`: the `real_big` / `real_big_null` secondary-index scenarios moved verbatim to `03.6.4-real-bigint-secondary-index`; the `real_pk` primary-key arm stays in 03.6 with a pointer.
- `15.1-semantic-ordering`: the `ckp` partial-unique-index scenario moved to the end of `15.1.2-semantic-ordering-index`, whose header and Subject line now cover three scenarios.
- `41.2.4-ddl-rollback-states`: sections A, E, F, H (`create unique index`) moved verbatim, keeping their letters, to `41.2.4.1-ddl-rollback-states-unique-index`. Each header points at the other file.
- `50.4-declare-schema-apply-restore` § 12: the `index r_p_u` member was removed, and the `add column` proof stays. `50.4.1-declare-schema-apply-restore-index` rebuilds the setup on its own and asserts the index lands while the view is redefined in the same plan.

## Review findings

- **Diff read against the originals.** The moved blocks match their originals line for line (03.6, 41.2.4). In 15.1 → 15.1.2 only the lead comment of `ckp` was rewritten so it makes sense without the old surrounding section. The test logic is unchanged.
- **Remaining index DDL in the four parent files.** I grepped for `create [unique] index`, `drop index` and the declarative `index` member. Only pointer comments remain, so all four parents run on any backend.
- **Dangling cross-references inside 41.2.4.** I listed the remaining section headings (B–D, I–S). None of them refers to A/E/F/H tables or letters, and every section creates and drops its own table.
- **50.4.1 semantics.** The implementer asked whether going straight from `sum(n)` to `sum(n) + 2` still exercises the drop guard. It does: the view body changes, so the plan still drops and recreates it under the CHECK that reads it. The probes are right for sum 10 + 2 = 12 (12 accepted, 13 refused). As in the old § 12, nothing directly checks that the index is built "in the stretch where the view is gone". That depends on the plan's ordering, and a `.sqllogic` file cannot observe it, so the coverage is the same as before.
- **Docs and comments pointing at the split files (found, fixed).** Four places called 41.2.4 "the full matrix" or said the cross-backend cases are pinned there. Three of them could send a reader to the wrong file after the split, so they now also name 41.2.4.1:
  - `docs/memory-table.md` § DDL and transactions
  - `test/ddl-in-transaction-validation.spec.ts` header comment
  - `10.1.2-ddl-in-transaction` § 6, which is itself a unique-index case

  The pointers in `41.7.4` and `41.8` were left alone: they are about retype and constraint cases, which stayed in 41.2.4. `docs/optimizer-fd.md`'s pointer to 15.1's end-to-end block still holds, because the `ckt` case is still in 15.1. `docs/sqlite-test-crosscheck.md` names 03.6 only for coverage that stayed there.
- **Capability effect.** `MEMORY_BACKEND_CAPABILITIES` and `STORE_BACKEND_CAPABILITIES` both equal the full set, so neither bundled backend skips these files. The directive matters only to downstream backends. The parser in `test/logic-capabilities.ts` still validates it on every run, and the four new files ran cleanly.
- **Tests.** No tests were added or cut. The moved scenarios are the tests, and 50.4.1 is needed to keep the index-in-plan case covered.
- **Tripwires / tickets.** None. The other three files that have the same problem are tracked by `sqllogic-index-ddl-split-shape-and-declarative`. The corpus-wide guard that would catch the whole class is `sqllogic-capability-usage-guard`.
- **Validation.** Targeted run `node packages/quereus/test-runner.mjs --grep "03.6|11.3-index|15.1|41.2.4|50.4|10.1.2|capabilit|ddl-in-transaction"`: 71 passing. `yarn test`: every workspace green, 0 failing. `eslint` on the edited spec is clean. `yarn test:store` was not run; nothing store-specific changed, and the store backend declares the same capability set.
