description: Shared SQL test files must announce when they use a database feature that not every storage backend offers. A new test now reads every file's SQL with the engine's own parser and fails when a file's announcements don't match what it uses. Review the check and the harness refactor that feeds it.
prereq: sqllogic-index-ddl-split-incidental-sections, sqllogic-index-ddl-split-shape-and-declarative
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/sqllogic-blocks.ts # new: pure block reader + the harness's `;` statement split
  - packages/quereus/test/logic-capability-usage.ts # new: CAPABILITY_USAGE detectors + findCapabilityUses (imports the parser)
  - packages/quereus/test/logic.spec.ts # per-file loop now consumes readSqllogicBlocks; three inline `;` splits now call splitBlockStatements
  - packages/quereus/test/logic-capabilities.spec.ts # corpus equality test + findCapabilityUses tests; subjectFiles / 10.1.2 / unannotated tests removed
  - packages/quereus/test/logic-capabilities.ts # one comment updated (who ignores unknown `--` lines)
  - packages/quereus/test/README.md # § `-- requires-capability:` directive: table row, Enforcement paragraph, "Adding a member"
----

# Review: every `.sqllogic` file declares exactly the capabilities its SQL uses

## What was built

- **`test/sqllogic-blocks.ts`** — `readSqllogicBlocks(content)` returns the blocks the harness executes (`sql`, `startLine`, `end` = `result | error | run | eof` with its marker line, raw `params`). The rules were moved out of `logic.spec.ts`'s inline loop unchanged: blank lines skipped, `-- error:` / `-- params:` / `-- run` markers recognised case-insensitively, other `--` lines ignored, everything from the first `--` on an SQL line dropped, a marker with no pending SQL a no-op that keeps pending params, trailing SQL an `eof` block at line `lines.length`. Also exports `splitBlockStatements(sql)`, the harness's naive split at every `;`.
- **`logic.spec.ts`** — the per-file loop is now `for (const block of readSqllogicBlocks(content))` + a `switch` on `end.kind`. The execute and assert helpers are unchanged, apart from their three identical `sql.split(';')…` lines now calling `splitBlockStatements`. Error messages cite the same lines as before (the end-marker line, or the `-- params:` line for bad params JSON).
- **`test/logic-capability-usage.ts`** — `CAPABILITY_USAGE: Readonly<Record<SqllogicCapability, UsageDetector>>`, so adding a token without a detector is a compile error (`yarn lint` type-checks tests). The `standalone-index-ddl` detector counts `createIndex`, `drop` with `objectType === 'index'`, and `declareSchema` with `!isLogical` and a `declaredIndex` item. `findCapabilityUses(content)` maps each used capability to the start line of the first block that uses it. `logic-capabilities.ts` stays engine-free.
- **Corpus test** ("declares exactly the capabilities each file uses") — collects every violation across all 388 files and asserts the list is empty. Each entry reads `<file>: uses <token> (first at line N) but does not declare it` or `<file>: declares <token> but no statement uses it`.

## Deviation from the ticket: parse-failing blocks

The ticket said a block that fails to parse contributes nothing, because `Database.exec` parses the whole batch before running any of it. `exec` does work that way (`database.ts` `exec` → `_parseSql` → run). But the harness does not pass `→` or `-- error:` blocks to `exec` whole. It splits them at `;`. An `-- error:` block's setup pieces run as one `exec` and its final piece is prepared on its own, so a block with a syntax error in its last statement still runs the statements before it. All 61 corpus blocks that fail to parse are `-- error:` blocks, so the ticket's premise does not hold for any of them.

Following the ticket's own fallback instruction, `blockStatements` parses the whole block first. If that fails, it parses each `splitBlockStatements` piece separately and counts the pieces that parse. This over-counts a `-- run` block, which goes to one `exec` whole and so runs nothing. I measured the corpus: no parse-failing block contains a piece that is index DDL, so the over-count changes nothing today. The reasoning is in the comment on `blockStatements`. The parse catch accepts only `QuereusError` (lexer, syntax and unterminated-paren failures all throw that type) and rethrows anything else.

## Tests

- `logic-capabilities.spec.ts` › the real corpus › "declares exactly the capabilities each file uses" — the guard itself. It replaces the hand-written `subjectFiles` list, the `10.1.2-ddl-in-transaction` pin, and "returns an empty set for every file that does not mention the directive". The equality check implies all three: an unannotated file must have no uses, so its declared set must be empty.
- `findCapabilityUses` › "counts a physical declare schema with an index member, not a logical one" — the `isLogical` branch.
- `findCapabilityUses` › "counts drop index, not drop of another object" — the `objectType` branch. It also checks that a use inside an `-- error:` block counts and that the first-use line is reported.
- `findCapabilityUses` › "counts what parses on its own in a block whose whole text does not" — the per-piece fallback: a valid `create index` piece counts, and a piece that does not parse counts for nothing.
- The block reader has no tests of its own. The whole logic suite runs through it in both modes.

I checked that the guard fires, with a scratch script (not committed): `10.5-indexes.sqllogic` with its directive line removed gives declared `[]` and uses `standalone-index-ddl` at line 6.

## Validation

- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn test`: quereus 11156 passing, 26 pending, 0 failing. Every other workspace is green.
- `node test-runner.mjs --store --grep "SQL Logic Tests"` (LevelDB store): 381 passing, 7 pending. 381 + 7 = 388, every corpus file; the 7 pending are `MEMORY_ONLY_FILES`.
- Measured with the new reader: no corpus file has a BOM, every `-- params:` line attaches to a `→` block, and no file has orphaned or overwritten params.

## Known gaps / things to look at

- **Bad JSON in `-- params:` that is overwritten or orphaned.** The old loop parsed every `-- params:` line as soon as it reached it. The new harness parses the params attached to a block, for every block kind, so bad JSON still fails. It no longer parses a `-- params:` line that a second `-- params:` line overwrites before the block ends, or one that no block follows. No corpus file has either shape (measured). Decide whether the reader should report those.
- **README widened the token's table row** to say the token also covers the `create index` / `drop index` that `apply schema` issues for a non-logical `declare schema`'s index members. The prereq tickets already applied that rule to the corpus, but the README did not say it. `SQLLOGIC_CAPABILITIES`'s description string in `logic-capabilities.ts` still names only the three standalone statements. Nothing displays it (the error text lists only token keys), so I left it.
- **Top-level statements only** — `NOTE:` at `usesStandaloneIndexDdl`. If a statement kind that executes a nested index statement is ever added, the detector must look inside it.
- **`alter index`** (tags only, `AlterIndexStmt`) is not counted, which matches the token's README meaning. `50-metadata-tags` (undeclared) runs it against a missing index and against `uq_email`, the index created by a `constraint uq_email unique (email)`, so no standalone index DDL is involved. The other three files that use it declare the capability because they also run `create index`. A reviewer may judge that a backend without standalone index DDL also lacks `alter index` on an implicit index. If so, that is a vocabulary question for `test/README.md`, not a detector bug.
