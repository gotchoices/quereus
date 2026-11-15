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
----

# Review: `standalone-index-ddl` capability splits for five `.sqllogic` files

## What changed

- `11.3-index-nested-loop-join` — added `-- requires-capability: standalone-index-ddl` to the header.
- `03.6-type-system` — the `real_big` / `real_big_null` secondary-index scenarios moved verbatim to new `03.6.4-real-bigint-secondary-index` (header restates the regression note and declares the capability). `03.6` keeps the section heading, the `real_pk` scenario, and a two-line pointer.
- `15.1-semantic-ordering` — the `ckp` partial-unique-index scenario moved to the end of `15.1.2-semantic-ordering-index`; its comment was rewritten to explain the mixed-type `check (d = s)` equivalence-class problem on its own. `15.1.2`'s header now counts three scenarios and its Subject line covers the new one. Pointer left in `15.1`.
- `41.2.4-ddl-rollback-states` — sections A, E, F, H (all `create unique index`) moved verbatim, letters kept, to new `41.2.4.1-ddl-rollback-states-unique-index`. Header pointers both ways. Inspected: no remaining section references A/E/F/H tables or letters; every section creates and drops its own table.
- `50.4-declare-schema-apply-restore` § 12 — removed only the `index r_p_u` member; the `add column w default 3` stays as the in-the-gap proof, with a comment pointing at `50.4.1`. New `50.4.1-declare-schema-apply-restore-index` rebuilds § 12's setup self-contained, applies a declaration that redefines the view and adds `index r_p_u` in one plan, then asserts `diff schema main` is `[]`, the index shows in `schema()`, and the CHECK reads the new view (12 accepted, 13 refused).
- `docs/schema-declarative.md` does not cite `50.4` (grepped), so no doc edit.

## Validation

- `node packages/quereus/test-runner.mjs --grep "03.6|11.3-index|15.1|41.2.4|50.4|capability"` — 68 passing, all four new files listed as run.
- Assertion counts (`→` plus `-- error:` lines) old vs old+new: 03.6 126 = 117+9; 15.1+15.1.2 141 = 136+5; 41.2.4 45 = 35+10. `50.4.1` is new coverage (the old § 12 never asserted on the index itself).
- `yarn test` — all workspaces green, no failures.
- `yarn test:store` not run (slow; nothing store-specific changed).

## Tests added

No new test logic; the moved scenarios are the tests. `50.4.1` is a self-contained copy of the "index added while the view is gone" case, which had to be separated from `50.4` to keep it covered.

## For the reviewer

- `50.4.1` uses `sum(n) + 2` directly from the base state (old § 12 got there via a `+ 1` step first); the CHECK probes are 12/13 accordingly. Confirm that still exercises the drop-guard path you care about.
- The other three offender files are handled by `sqllogic-index-ddl-split-shape-and-declarative`; the corpus guard is `sqllogic-capability-usage-guard`.
