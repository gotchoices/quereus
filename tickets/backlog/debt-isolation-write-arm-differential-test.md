description: The transaction isolation layer has several separate code paths for writing a row, and three of them have now been found to skip a uniqueness check the others perform; a single test that replays many in-transaction write sequences against both an isolated table and a plain table and compares the results would catch the whole class instead of one path at a time.
architecture: docs/design-isolation-layer.md#cross-layer-constraint-detection
files:
  - packages/quereus-isolation/src/isolated-table.ts       # IsolatedTable.update — insert / update / delete arms
  - packages/quereus-isolation/test/isolation-layer.spec.ts
prereq: isolation-overlay-same-pk-update-skips-unique-check
tradeoffs: A generated differential test costs CI time and needs care to keep failures reproducible (seeded, shrunk to a minimal script); the per-arm pins already landed may be judged enough if no further arm turns out to be missing a check.
----

# Differential test: isolated table vs plain table for in-transaction write sequences

`IsolatedTable.update` branches on (operation) × (target row already in the overlay? live or tombstone?) × (primary key changed?) × (conflict action), and each branch must run the merged-view PK and UNIQUE checks before writing the overlay, because the commit flush writes "trusted" (the underlying skips its own re-check). Three branches have been found missing the merged UNIQUE check, each fixed with a point pin:

- insert reviving a tombstoned primary key (pins at `isolation-layer.spec.ts` ~L590–660)
- insert OR REPLACE over a primary key already live in the overlay (`memory-vtab-pk-replace-skips-unique-check`, pins ~L663–708)
- same-primary-key update of a row already live in the overlay (`isolation-overlay-same-pk-update-skips-unique-check`)

The sqllogic suite under `yarn test:store` only catches a branch when some hand-written script happens to reach it inside a transaction.

## Expected behaviour

A test (seeded, deterministic) that, for small tables with a primary key and one or more UNIQUE columns (plain, partial, with assorted `on conflict` defaults on PK and UNIQUE), generates short sequences of committed seed rows followed by a `begin; ...; commit` of mixed INSERT / INSERT OR REPLACE / INSERT OR IGNORE / UPDATE (PK-changing and not) / DELETE, runs each sequence against a plain memory table and against `using isolated` over memory (and ideally over store), and asserts per statement the same success/constraint-error outcome and after commit the same table contents. On failure it prints the minimal failing script.

Rejected alternative: keep adding per-branch pins — that is what has happened three times; each new branch or refactor needs someone to notice.
