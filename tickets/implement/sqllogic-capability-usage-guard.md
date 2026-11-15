description: Shared SQL test files are supposed to announce when they use a database feature that not every storage backend offers, but nothing checks that they do. Add a test that reads every file's SQL with the engine's own parser and fails when a file's announcements don't match what it actually uses.
prereq: sqllogic-index-ddl-split-incidental-sections, sqllogic-index-ddl-split-shape-and-declarative
architecture: packages/quereus/test/README.md
files:
  - packages/quereus/test/logic.spec.ts # the harness; its inline block-splitting loop (~lines 560–839) moves to the new module
  - packages/quereus/test/sqllogic-blocks.ts # new: pure block reader shared by harness and guard
  - packages/quereus/test/logic-capability-usage.ts # new: per-capability usage detectors (imports the engine parser)
  - packages/quereus/test/logic-capabilities.ts # vocabulary + directive parser; stays engine-free
  - packages/quereus/test/logic-capabilities.spec.ts # corpus tests; `subjectFiles` and the `10.1.2` pin are replaced
  - packages/quereus/test/README.md # § `-- requires-capability:` directive
  - packages/quereus/src/parser/parser.ts # `Parser.parseAll` — used, not changed
  - packages/quereus/src/parser/ast.ts # `CreateIndexStmt`, `DropStmt`, `DeclareSchemaStmt.isLogical`, `DeclaredIndex`
  - packages/quereus/src/core/database.ts # `exec` → `_parseSql` parses the whole block before running any of it
----

# Guard: every `.sqllogic` file declares exactly the capabilities its SQL uses

## Background

`packages/quereus/test/logic/*.sqllogic` is a shared corpus that other projects run against their own storage engines. A file that uses a feature some backend deliberately omits declares it with `-- requires-capability: <token>` in its header, and such a backend skips the file (format: `test/README.md` § `-- requires-capability:` directive; parser: `test/logic-capabilities.ts`). Today the declaration is voluntary: the parser validates a directive that is present, but nothing compares it with what the file's SQL does. Forgetting it passes locally (quereus's two backends support everything) and fails only in someone else's repo. The two prereq tickets clear the eight files that currently get it wrong; this ticket makes the class impossible to re-introduce.

The existing corpus test "declares standalone-index-ddl on every file whose subject is index DDL" checks a hand-written list of twelve file names — by construction it cannot catch a file nobody remembered to list. This ticket replaces it with a check derived from the files themselves.

## Design

### Detection uses the engine's real parser, per harness block

No text heuristics. The guard splits each file into the same SQL blocks the harness executes, parses each block with `new Parser().parseAll(sql)` (exported from `src/parser/parser.ts`), and inspects the top-level statements. For `standalone-index-ddl` a statement counts as a use when it is:

- `createIndex` (`create index` / `create unique index`),
- `drop` with `objectType === 'index'`,
- `declareSchema` with `!isLogical` and at least one item of type `declaredIndex` — `apply schema` lowers those to `create index` / `drop index`. A `declare logical schema` is excluded: its index members are refused at apply before anything is lowered (`51-lens-foundation.sqllogic` section 2 expects exactly that error).

A block that fails to parse contributes nothing: `Database.exec` parses the whole block (`_parseSql`) before running any statement, so a block with a deliberate syntax error never executes its index DDL either. Confirm that by reading `exec` and say so in a comment at the skip; if `exec` turns out to run statements before the whole batch is parsed, the skip is wrong and must instead fall back to parsing statement by statement.

A use inside a block that expects an error (`-- error:`) still counts — a backend without the feature would fail that block with a different error.

A `declare schema` with index members counts even if the file never applies it — conservative, and no corpus file does that.

Measured before writing this ticket (a scratch script using the built parser and the harness's block rules over all corpus files): this detector flagged exactly the eight files the prereqs fix, produced no false positive (the logical-schema member in `51-lens-foundation` is excluded by `isLogical`), and found no file that declares the capability without using it. 61 corpus blocks fail to parse; all are intentional parse-error tests.

### Shared block reader — `test/sqllogic-blocks.ts`

The guard is only as faithful as its block splitting, and the rules live today inline in `logic.spec.ts`'s per-file loop. Extract them into a pure module (no engine imports) that both use, so they cannot drift:

```ts
export type SqllogicBlockEnd =
	| { kind: 'result'; json: string; line: number }   // `→ …`
	| { kind: 'error'; substring: string; line: number } // `-- error: …`
	| { kind: 'run'; line: number }                      // `-- run`
	| { kind: 'eof'; line: number };                     // trailing SQL, run as setup

export interface SqllogicBlock {
	sql: string;            // trimmed, exactly what the harness passes to exec/eval today
	startLine: number;      // 1-based line of the block's first SQL line
	end: SqllogicBlockEnd;
	params: { json: string; line: number } | null; // raw `-- params:` payload; the harness parses it
}

export function readSqllogicBlocks(content: string): SqllogicBlock[];
```

Preserve the current behaviour exactly — it is what the corpus is written against:

- lines split on `/\r?\n/`; blank lines skipped;
- a `--` line is a marker if it starts (case-insensitively) with `-- error:`, `-- params:`, or equals `-- run`; every other `--` line is ignored (the directive, prose);
- `→` lines end a result block; `-- error:` and `-- run` end their kinds; a marker with no pending SQL is a no-op and does not clear pending params;
- params attach to the next block that ends and are cleared when it does;
- on an SQL line, everything from the first `--` on is dropped (even inside a string literal — existing behaviour, keep it), and the line is kept only if something non-blank remains;
- trailing SQL at end of file becomes an `eof` block.

The harness loop then becomes "for each block: switch on `end.kind`", with its execute/assert helpers unchanged. Error messages keep citing the same line numbers they do now (the end-marker line; the params line for a bad `-- params:` JSON).

### Usage detectors — `test/logic-capability-usage.ts`

Keep `logic-capabilities.ts` engine-free (its header promises a pure, portable module that downstream harnesses mirror). The detectors live in a new module that imports the parser and AST types:

```ts
type UsageDetector = (statement: AST.Statement) => boolean;

/** One detector per capability token. `Record` makes the compiler refuse a token without one. */
export const CAPABILITY_USAGE: Readonly<Record<SqllogicCapability, UsageDetector>>;

/** Each capability the file's SQL uses, with the start line of the first block that uses it. */
export function findCapabilityUses(content: string): ReadonlyMap<SqllogicCapability, number>;
```

The `Record<SqllogicCapability, …>` type is what keeps the guard honest as the vocabulary grows: adding a token to `SQLLOGIC_CAPABILITIES` without a detector is a compile error (caught by `yarn lint`, which type-checks test files). This replaces the original idea of putting a regex next to each token in `SQLLOGIC_CAPABILITIES`; same guarantee, without dragging an engine import into the portable module.

### The corpus test

In `logic-capabilities.spec.ts` § "the real corpus", one test: for every `.sqllogic` file, the declared set (`parseRequiredCapabilities`) must equal the used set (`findCapabilityUses`). Collect every violation across the corpus and assert the list is empty, so one run reports all offenders. Each entry names the file and either "uses `<token>` (first at line N) but does not declare it" or "declares `<token>` but no statement uses it" (an unused declaration needlessly skips the file downstream).

Remove the `subjectFiles` test and the `10.1.2-ddl-in-transaction` pin test — both are strictly weaker than the equality check. The "returns an empty set for every file that does not mention the directive" test may also go (the equality check covers it); implementer's call.

Add one focused test of the detector's branching, on inline content (not corpus files): a physical `declare schema` with an `index` member counts; the same under `declare logical schema` does not; `drop index` counts; a block that fails to parse contributes nothing. No tests for the block reader beyond the full logic suite running through it.

### Docs

`test/README.md` § `-- requires-capability:` directive:

- Add a short paragraph: quereus's own suite fails any file whose declarations differ from its use, where "use" is defined per token (for `standalone-index-ddl`: the three statement forms above, including index members of a non-logical `declare schema`; any block that parses, including `-- error:` blocks). Downstream harnesses need not reimplement this — they only read the directive.
- In "Adding a member", add "one detector in `CAPABILITY_USAGE` (`test/logic-capability-usage.ts`)".

## Edge cases & interactions

- **Logical schema index members** — excluded via `isLogical`. Covered by the focused test, and by `51-lens-foundation` in the corpus test.
- **Parse-failing blocks** — skipped, justified by `exec` parsing before running. Verified by reading `Database.exec` (comment at the site) and by the focused test.
- **Statements nested in other statements** — only top-level statements are inspected. `explain create index …` (if the parser accepts it) does not execute the DDL, so not counting it is right; no corpus file does this. Leave a `NOTE:` at the detector: if a statement kind that *executes* a nested index statement is ever added, the detector must look inside it.
- **`MEMORY_ONLY_FILES`** — still checked; downstream runs them.
- **BOM / CRLF** — `parseRequiredCapabilities` strips a BOM; make sure the block reader's first line also does not carry one into the first SQL block (the harness today does not strip it — check whether any corpus file has a BOM and keep the harness behaviour identical either way; a BOM before a `--` comment line is harmless only if `trim()` removes it, which it does for `﻿`).
- **Harness refactor regressions** — the whole logic suite runs through the new reader, so any behaviour change shows up as corpus failures. Verified by `yarn test`; also run `yarn test:store` once if the reader changed anything about params or end-of-file handling, since store mode uses the same loop.
- **Line numbers in errors** — the harness's failure messages must keep pointing at the same lines (end-marker line). Inspection.
- **Downstream** — no format change; the README spec for the directive itself is untouched apart from the added paragraph.

## TODO

- Extract `readSqllogicBlocks` into `test/sqllogic-blocks.ts`, preserving every rule listed above; rewrite the `logic.spec.ts` per-file loop to consume it
- Add `test/logic-capability-usage.ts` with `CAPABILITY_USAGE` (typed `Record<SqllogicCapability, …>`) and `findCapabilityUses`; comment the parse-failure skip with the `exec` justification and the nested-statement `NOTE:`
- In `logic-capabilities.spec.ts`, replace the `subjectFiles` and `10.1.2` tests with the declared-equals-used corpus test; add the one focused detector test
- Update `test/README.md` § `-- requires-capability:` directive (enforcement paragraph; "Adding a member")
- `yarn workspace @quereus/quereus lint`, then `yarn test`; `yarn test:store` once if the reader refactor touched params/eof handling
