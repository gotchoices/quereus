## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY
- No lengthy summaries
- Don't worry about backwards compatibility yet
- Use yarn
- Prefix unused arguments with `_`
- Enclose `case` blocks in braces if any consts/variables
- Prefix calls to unused promises (micro-tasks) with `void`
- ES Modules
- Don't be type lazy - avoid `any`
- Don't eat exceptions w/o at least logging; exceptions should be exceptional - not control flow
- Small, single-purpose functions/methods.  Decomposed sub-functions over grouped code sections
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- Think cross-platform (browser, node, RN, etc.)
- .editorconfig contains formatting (tabs for code)

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.

## Launch process tool (if under PowerShell)

The `launch-process` tool wraps commands in `powershell -Command ...`, which strips inner quotes and parses parentheses as subexpressions. This makes `git commit -m "task(review): ..."` impossible — no escaping strategy works.
Use a file or pipe based pattern as a work-around.  e.g. `git commit -F .git/COMMIT_EDITMSG`

## Project Structure

Yarn 4 monorepo. All packages under `packages/`.

```
quereus/                   # Main SQL engine — see its README for detailed src/ layout
├── src/                   #   core/ parser/ planner/ runtime/ emit/ schema/ types/ func/ vtab/ common/ util/
│   ├── planner/           #   building/ nodes/ rules/{access,aggregate,cache,distinct,join,predicate,retrieve,subquery}/
│   │                      #   framework/ cost/ analysis/ stats/ validation/ scopes/ cache/
│   └── runtime/emit/      #   Instruction emitters — mirrors planner/nodes/ 1:1
├── test/                  #   logic/*.sqllogic (primary), plan/, optimizer/, planner/, vtab/
└── docs/                  #   runtime.md, types.md, sql.md, optimizer.md, schema.md, ...
quoomb-cli/                # CLI tool
quoomb-web/                # Web UI
quereus-store/             # Persistent key-value store abstraction
quereus-isolation/         # Snapshot isolation layer
quereus-sync/              # Sync engine
quereus-sync-client/       # Sync client
sync-coordinator/          # Sync server/coordinator
plugin-loader/             # Plugin loading infrastructure
quereus-plugin-leveldb/    # LevelDB storage plugin
quereus-plugin-indexeddb/  # IndexedDB storage plugin
quereus-plugin-react-native-leveldb/
quereus-plugin-nativescript-sqlite/
quereus-vscode/            # VS Code extension
shared-ui/                 # Shared UI components
sample-plugins/            # Example plugins
```

Task workflow in `tickets/` folder (see `tickets/AGENTS.md`).

## Build & Test
- `yarn build` runs sequentially through all packages
- `yarn test` runs tests across all workspaces — **the default for agents**; fast, memory-backed vtab
- `yarn test:store` re-runs `packages/quereus` logic tests against the LevelDB store module (slower; exercises the store code path for ALTER, constraints, transactions, etc.)
- `yarn test:full` runs both — **only run when diagnosing a store-specific issue or preparing a release**
- Only `packages/quereus` has a lint script; `yarn lint` runs eslint **and** type-checks the test files (`tsc -p tsconfig.test.json --noEmit`), so it also catches signature drift in spec call sites (~adds a tsc pass, so it's slower than eslint alone)
- On Windows, lint globs must be single-quoted to avoid command line too long errors
- Tests use Mocha + ts-node/esm for quereus, Vitest for some other packages
- Default cwd is the repo root. If you've already `cd packages/quereus` in a prior Bash call, the Bash tool's cwd persists — don't re-prefix subsequent commands with `cd packages/quereus &&`. Either chain everything in one Bash call, or use absolute paths / `yarn workspace @quereus/quereus run <script>` from the root.
- Streaming long-running output: `2>&1 | tee /tmp/foo.log` is the recommended pattern, but under Windows + Git Bash the `| tee | tail` pipeline can drop stdout to the agent (silent buffering). If `tee` produces nothing, don't rebuild — chain a separate read instead: `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`. Under PowerShell, use `Tee-Object` rather than `tee`.

## Key Architecture Notes
- All tables are virtual tables (VTab-centric design)
- Async core: cursors are `AsyncIterable<Row>`
- Key-based addressing (no rowids)
- Type system: logical/physical type separation with temporal types
- Pipeline: SQL → parser → AST → planner/building → PlanNode tree → optimizer rules → emit → Instructions

## Docs
- **Start here for engine internals:** `docs/architecture.md` — pipeline, source layout, extension patterns, design decisions, constraints, testing strategy
- **Package overview / user-facing:** `packages/quereus/README.md` — quick start, platform/storage, docs index, current status
- Deeper topic docs in `docs/` folder (runtime.md, types.md, sql.md, optimizer.md, schema.md, usage.md, etc.)

----

For all but the most trivial asks, read and maintain the relevant docs along with the work.

## Code search (tess)

**First tool** for any "where / how / why" question about this codebase: the local code-aware index wired to `mcp__code-search__*`. Reach for `grep`/`Glob` only when you already know the exact filename or literal string. Pick the right sub-tool — they are not interchangeable.

**Decision rule:**

- Query is identifier-shaped (any single symbol, camelCase, snake_case, or a list of names like `fooBar bazQux`)? → `find_references`.
- Query is prose ("where do we evict pages", "what handles JWT refresh", you don't yet know the identifier)? → `search_code`.
- About to run more than one `grep` to reconstruct context? → run `search_code` first instead. That is the moment it pays off, even when you already know an identifier.

`search_code` embeds the query as natural language. Identifier-bag queries can still work when the identifiers co-locate in real code, but prose phrasing is more reliable. If `search_code` returns a weak-top warning, the relative-percentage ranking is unreliable — switch to `find_references` or rephrase as prose, do **not** trust the ordering on noisy results.

**Tools:**

- `search_code(query, k?, path_filter?)` — semantic search. Scores are relative within each result set, not absolute. `k` defaults to 5 (max 50) — raise it for broad sweeps, lower it when you know the top hit is enough. `path_filter` is a SQL LIKE pattern, e.g. `"packages/lamina/%"`.
- `find_references(symbol, max?, path_filter?)` — literal substring; `|` ORs alternatives (`Foo|Bar`). Returns every hit (capped by `max`, default 50, max 500). This is the indexed replacement for `grep` on identifiers.
- `read_chunk(path, start_line, end_line)` — expand a snippet from either tool without a separate `Read`.

**Fallbacks:**

- Use `grep`/`Glob` only for filename patterns, regex with anchors/lookarounds, or when you need *every* literal hit (the index is chunk-granular and may miss adjacent matches inside one chunk).
- Never fall back to `grep` when `find_references` would suffice — it's strictly slower and pulls more bytes.

**What's indexed:** project source files tracked by git, minus `node_modules/`, `dist/`, `build/`, `.git/`, `tickets/`, `team/`, `docs/`, and a few cache dirs. If a query about prose-heavy material (long-form architecture docs, design notes, READMEs in nested folders) returns nothing, the file may be outside the indexed set — fall back to `Read`/`Glob` for those paths. Projects can override the filter via `tickets/index-config.json` (see tess README § Customize what gets indexed).
