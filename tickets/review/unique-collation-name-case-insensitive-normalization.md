description: Code-review handoff — collation-name case-insensitive normalization. `columnDefToSchema` normalizes a column's COLLATE name to canonical uppercase and validates the whitelist case-insensitively, so `collate nocase` is accepted and enforces identically to `collate NOCASE`; unknown collations are rejected with new "Unknown collation" wording. `SchemaManager.buildIndexSchema` normalizes the index-column collation too (no whitelist check). Shared `normalizeCollationName` helper in util/comparison.ts.
files: packages/quereus/src/util/comparison.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/test/logic/07.3-group-by-extras.sqllogic, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic, packages/quereus/test/logic/102.2-unique-collation.sqllogic, packages/quereus/test/logic/41-fk-extended-targets.sqllogic, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic
----

## What changed (source)

DDL-side collation-name validation was case-sensitive (`Array.includes` of the as-written
name against the canonical-uppercase `supportedCollations` whitelist), so a lowercase
`collate nocase` column was rejected with a misleading "not supported" error even though the
lookup/resolution layer is already case-insensitive everywhere.

- **util/comparison.ts** — new exported `normalizeCollationName(name): string`
  (`name.trim().toUpperCase()`).
- **schema/table.ts** (`columnDefToSchema`, `collate` case) — normalize once; validate
  `supportedCollations` membership against the **normalized** name; store the **normalized**
  value on `ColumnSchema.collation`; reworded rejection to `Unknown collation '<original>' for
  type '<TEXT>' on column '<col>' (expected one of: BINARY, NOCASE, RTRIM)`.
- **schema/manager.ts** (`buildIndexSchema`) — `normalizeCollationName(indexedCol.collation ||
  tableColSchema.collation || 'BINARY')`; no whitelist check (keeps custom-collation indexes).

UNIQUE enforcement reads `ColumnSchema.collation`, so this fixes inline
`text collate nocase unique` and table-level `unique (x)` automatically.

## Tests changed

The old lowercase-rejection was pinned by MULTIPLE test files (the suite runs --bail, so they
surface one at a time). Verified/hand-written: **102.1 §1** (accept + enforce + unknown-collation
`frobnicate` case), **102.2 §8** (lowercase enforcement parity), **07.3-group-by-extras**
(collate-nocase table now created + used). The remaining pins (e.g. **41-fk-extended-targets**,
**41.4-alter-add-column-constraints**) had their now-stale `-- error:` rejection directive
removed. A mechanical pass initially over-reached and stripped **06.4.2-collation-extras**'s
`-- error: Indices on expressions are not supported` (that error is about EXPRESSION INDICES,
NOT collation, and the source change cannot affect it) — that file was **reverted to HEAD**.

REVIEWER: scrutinize every changed test/logic diff (git diff). Confirm each removed `-- error:`
directive's block was rejected ONLY because of the lowercase collation (not a second, unrelated
limitation). 07.3's section was titled "GROUP BY with COLLATE NOCASE ... not supported"; whether
GROUP BY honors a column's NOCASE collation was NOT verified — add real coverage if it does.

## Use cases

- `create table t (id integer primary key, email text collate nocase unique)` — accepted;
  insert `'a@x'` then `'A@X'` -> `UNIQUE constraint failed: t (email)`.
- Mixed case `collate NoCaSe`/`RtRiM`/`binary` — accepted + normalized.
- `collate frobnicate` — "Unknown collation ... (expected one of: BINARY, NOCASE, RTRIM)".
- `create index ... collate nocase` + custom-collation indexes (PHONENUMBER/LENGTH) — work.

## Known gaps / scrutiny points

- **Test diffs are the highest-risk part** — review them (esp. the auto-removed directives).
- **Out of scope, still latent:** custom collation on a TEXT *column* (`x text collate
  unicode_ci`) still rejected by the whitelist (works via `CREATE INDEX`). Unchanged here.
- **GROUP BY + NOCASE** — not verified (07.3).
- **Line endings** — files preserve existing EOL; confirm content-only diff.
- **Store mode** — `yarn test:store` not run; schema change is shared, 102.2 covers store-mode.
- **Tool-output caveat** — the tess tool-output channel was severely dropping/delaying results;
  edits + transition were applied by scripts deciding on real exit codes.

## Validation results (captured by finalizer)

```
typecheck exit: 0


lint exit: 0


full quereus test exit: 0

```
