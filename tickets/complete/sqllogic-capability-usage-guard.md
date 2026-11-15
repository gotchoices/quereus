description: Shared SQL test files must announce when they use a database feature that not every storage backend offers. A test now reads every file's SQL with the engine's own parser and fails when a file's announcements don't match what it uses.
prereq: sqllogic-index-ddl-split-incidental-sections, sqllogic-index-ddl-split-shape-and-declarative
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/sqllogic-blocks.ts # pure block reader + the harness's `;` statement split
  - packages/quereus/test/logic-capability-usage.ts # CAPABILITY_USAGE detectors + findCapabilityUses (imports the parser)
  - packages/quereus/test/logic.spec.ts # per-file loop consumes readSqllogicBlocks; `;` splits call splitBlockStatements
  - packages/quereus/test/logic-capabilities.spec.ts # corpus equality test + findCapabilityUses tests
  - packages/quereus/test/logic-capabilities.ts # capability description + reader comment
  - packages/quereus/test/README.md # § `-- requires-capability:` directive: table row, Enforcement, "Adding a member"
----

# Complete: every `.sqllogic` file declares exactly the capabilities its SQL uses

## What landed

- `test/sqllogic-blocks.ts` — `readSqllogicBlocks(content)` returns the blocks the logic harness executes (`sql`, `startLine`, `end` = `result | error | run | eof` with its marker line, raw `params`), and `splitBlockStatements(sql)` is the harness's naive split at every `;`. The rules are the old inline loop's, unchanged.
- `logic.spec.ts` — the per-file loop is `for (const block of readSqllogicBlocks(content))` plus a `switch` on `end.kind`; the three inline `sql.split(';')…` lines call `splitBlockStatements`.
- `test/logic-capability-usage.ts` — `CAPABILITY_USAGE: Record<SqllogicCapability, UsageDetector>` (a token without a detector does not compile). `standalone-index-ddl` = `createIndex`, `drop` of an index, or a non-logical `declareSchema` with a `declaredIndex` member. `findCapabilityUses(content)` maps each used capability to the start line of the first block that uses it. Blocks whose whole text fails to parse fall back to counting each `;` piece that parses alone.
- Corpus test "declares exactly the capabilities each file uses" replaces the hand-maintained `subjectFiles` list, the `10.1.2-ddl-in-transaction` pin and the "unannotated files declare nothing" test. All three follow from the equality check.

See commit `ticket(implement): sqllogic-capability-usage-guard` for the diff.

## Review findings

**Checked:**
- Harness refactor against the removed inline loop, rule by rule: blank lines, case-insensitive `-- error:` / `-- params:` / `-- run` markers (same substring offsets 9 / 10), the `→` check after the `--` check, the `--` strip on SQL lines, markers with no pending SQL being no-ops that keep pending params, params cleared only when a block closes, the `eof` line = `lines.length`, `assertConnectionLifecycle` after every executed block, and params passed only to `→` blocks. Same behaviour, except the params gap below. A BOM on line 1 is handled the same way as before: `trim()` strips U+FEFF and the trimmed block text drops it.
- Detector against `src/parser/ast.ts`. The only index-shaped statement types are `createIndex`, `alterIndex`, `drop.objectType === 'index'` and `declaredIndex`. Leaving out `alterIndex` matches the token's README meaning, as the handoff explains.
- The parse-failure fallback claim, with a scratch script (deleted): 61 blocks fail to parse whole, all `-- error:` blocks, and no `;` piece of any of them is index DDL. The over-count cannot change today's corpus result.
- The parse catch rethrows anything that is not a `QuereusError`. That is right: a non-`QuereusError` from the parser is a parser bug.
- The tests: the corpus equality test is the guard itself. The three `findCapabilityUses` tests each cover one real branch (`isLogical`, `objectType`, per-piece fallback). None restate the implementation or test a mock, so none were cut and none were added.
- Docs: `test/README.md` directive section read in full, plus a grep across `packages/` and `docs/` for references to the removed tests or the old loop.

**Found and fixed in this pass (minor):**
- The `blockStatements` comment said a parse-failing block "may still run the pieces before the bad one". That is true only when the bad piece is the final one. An `-- error:` block's setup pieces go to `exec` as one batch, so a bad setup piece means nothing runs. The comment and README now say the fallback also over-counts there, and that over-counting can only make a file declare more.
- `test/README.md` still said "the runner `continue`s past every unrecognized `--` line". It now names the block reader.
- `SQLLOGIC_CAPABILITIES['standalone-index-ddl']` now carries the same `apply schema` / `declare schema` wording as the README table row, so the two definitions do not drift.
- The violation message said "first at line N", but N is the start line of the block, not of the statement. It now reads "first in the block at line N".

**Tripwires recorded:**
- A `-- params:` line that is overwritten or orphaned is no longer JSON-validated (the old loop validated every params line). No corpus file has either shape. Parked as a `NOTE:` at the params assignment in `sqllogic-blocks.ts`.
- The detector sees top-level statements only. The implementer's `NOTE:` at `usesStandaloneIndexDdl` already covers this; nothing to add.

**Considered and left:**
- `alter index` not counted. Whether a backend without standalone index DDL also lacks `alter index` on an implicit index is a question about what the token covers (`test/README.md`), not a detector defect. Nothing anchors a change in this release, so no ticket.
- Modelling each block kind's exact batching (instead of the conservative per-piece fallback) would remove the over-count, but it would copy the harness's execution logic into a second place for no corpus-visible gain.

**No major findings**: nothing met the filing bar, so no tickets were filed.

## Validation

- `yarn workspace @quereus/quereus lint`: exit 0.
- `yarn workspace @quereus/quereus test`: 11156 passing, 26 pending, 0 failing.
- Store mode was not re-run in review. The implementer ran it (381 passing + 7 `MEMORY_ONLY_FILES` pending = 388 files), and this pass changed no harness behaviour, only comments, a description string and a test message.
