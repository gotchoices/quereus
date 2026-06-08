description: Workspace build-tool & ordering gaps that blocked a clean full `-At` monorepo build — declare esbuild/typescript build tools in vscode/sample-plugins, promote the build-time `@quereus/quereus` value-import edges into `dependencies`, and make `yarn clean` remove stray root-level `*.tsbuildinfo` so tsc re-emits. COMPLETE (reviewed).
prereq:
files: package.json (root clean script), packages/quereus-vscode/package.json, packages/sample-plugins/package.json, yarn.lock

# Complete: workspace build-tool & ordering gaps

## What shipped

Four package-manifest / script edits, no source-code changes. Goal: make a from-clean full
`yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace run build` succeed for **every**
workspace.

Root-cause class (from the fix ticket, confirmed): under Yarn 4 here, a child workspace's `build`
script only gets its **own** declared binaries on PATH — root-hoisted devDeps are not on a child's
script PATH — so a bare `esbuild`/`tsc` invocation fails with exit 127. Separately, a build-time
**value** import of a sibling `@quereus/*` package must live in `dependencies` (not dev/peer) for
`-At` to order it first.

1. **`packages/quereus-vscode/package.json`** — added `"esbuild": "^0.27.2"` to `devDependencies`
   (matches root; `build:server`/`build:client` invoke bare `esbuild`); moved
   `"@quereus/quereus": "workspace:^"` from `devDependencies` → `dependencies` (server has
   build-time value imports, e.g. `KEYWORDS` in `server/src/handlers.ts`). The published `.vsix` is
   unchanged because `package`/`pub:*` package with `--no-dependencies`.

2. **`packages/sample-plugins/package.json`** — added `"typescript": "^5.9.3"` to `devDependencies`
   (the `build` script runs bare `tsc`); added a `dependencies` block with
   `"@quereus/quereus": "workspace:^"` (plugin sources have value imports of `VirtualTable`,
   `registerPlugin`, …). sample-plugins is not in the root `pub` list, so this has no publish impact.

3. **Root `package.json` `clean`** — added `packages/*/*.tsbuildinfo` so the three packages that emit
   their buildinfo at package root (quoomb-cli, quoomb-web, shared-ui — `incremental`+`composite`
   from `tsconfig.base.json`) get cleaned. Previously the up-to-date buildinfo survived `clean` and
   tsc skipped emit → no `dist/`.

4. **(Review-stage inline fix) Root `package.json` `clean`** — also added
   `packages/quereus-vscode/*/*.tsbuildinfo` so vscode's `typecheck`-emitted `client/` and `server/`
   buildinfo are removed too, completing the ticket's "remove tsbuildinfo uniformly" intent (these
   are harmless to the esbuild-driven `build`, but were the one remaining inconsistency).

`yarn.lock`: 3 added edges only (resolve to already-present versions — no new downloads).

## Review findings

**Diff reviewed:** implement commit `2f3fae65` (read first, before the handoff), plus the prior
interrupted review run's log. The prior review run was killed by the runner's idle timer during the
sample-plugins test re-run while the API was retrying — **not** a real test hang (confirmed below).

- **Correctness of dependency promotions — checked, sound.** Both `@quereus/quereus` promotions are
  genuine runtime/build-time value imports, so `dependencies` is correct on the merits, not just for
  `-At` ordering. vscode publish safety confirmed: `package`/`pub:ovsx`/`pub:vsm` still pass
  `--no-dependencies`. sample-plugins is absent from the root `pub` script, so no npm-publish impact.
  The handoff's "load-bearing: don't tidy these back to devDependencies" caveat is accurate.

- **`yarn.lock` — checked, minimal & correct.** Exactly the 3 new edges; new ranges (`^0.27.2`,
  `^5.9.3`, `workspace:^`) match root/siblings, so they dedup against existing resolutions.

- **clean-script glob completeness — one minor gap found & fixed inline.** The depth-2 glob
  `packages/*/*.tsbuildinfo` does not reach vscode's `client/tsconfig.tsbuildinfo` /
  `server/tsconfig.tsbuildinfo` (emitted by the `typecheck` script, `tsc --noEmit` + composite, at
  depth 3). These don't affect the esbuild `build`, so they were not an acceptance blocker, but
  leaving them contradicted the ticket's uniform-removal intent. Added
  `packages/quereus-vscode/*/*.tsbuildinfo` to `clean`; re-verified clean+build still exit 0.

- **Remaining stale artifact — out of scope, noted.** `packages/quereus-vscode/server/out/...`
  contains an old `tsconfig.tsbuildinfo` inside a vestigial `server/out/` directory that no current
  script produces (vscode builds to `server/dist`). Not cleaned by any glob; pre-existing cruft
  unrelated to this ticket. Left as-is.

- **Nested non-workspace package — checked, correctly excluded.** `packages/tools/planviz`
  (`@quereus/planviz`, `build: tsc`) emits `dist/tsconfig.tsbuildinfo` but is **not** a workspace
  (`workspaces` is `packages/*`; planviz is nested under `packages/tools/`). It is therefore not part
  of the `-At` build and not in scope here; its dist is not cleaned by the root script. No action.

- **"No other workspace tool-declaration gaps" claim — re-verified.** Swept all workspace `build`
  scripts vs declared tools/`@quereus/*` edges (via the implement diff + the full `-At` build). Every
  workspace builds clean; no further bare-tool or misplaced-dependency-edge gaps remain.

- **Docs — checked, none affected.** No doc (`docs/`, READMEs, AGENTS.md) references the `clean`
  script, `tsbuildinfo`, or the `-At` build incantation, so nothing was out of date. (Searched `*.md`
  for `tsbuildinfo|foreach -At|yarn clean|workspaces foreach`; only ticket files matched.)

- **Lint — not applicable to this diff, by design (stated explicitly).** The only lint script is
  `@quereus/quereus`'s eslint over its own `src/`. This change touches zero quereus source — only
  root/vscode/sample-plugins `package.json` and `yarn.lock` — so lint cannot exercise the diff.
  Skipped deliberately to avoid surfacing unrelated pre-existing findings; no `.pre-existing-error.md`
  was warranted.

**Major findings filed as new tickets:** none. All findings were minor; the one actionable item was
fixed inline.

## Validation performed (all green, re-run independently this pass)

- `yarn workspace quereus-vscode run test` → **31 passing** (foreground).
- `yarn workspace @quereus/sample-plugins run test` → **34 passing, 111ms** (foreground) — confirms
  the prior run's interruption was runner/API, not a hang.
- `yarn clean` (with the review-stage edit) → exit 0; verified all `packages/*/*.tsbuildinfo` **and**
  vscode `client/`/`server/` root buildinfo removed.
- `yarn clean` + `yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace run build` →
  **exit 0** (~49s wall-clock), build output present for vscode (`server/dist/server.js`,
  `client/out/extension.js`), sample-plugins, quoomb-cli, quoomb-web, shared-ui. Run **twice** (before
  and after the clean-script edit) — both exit 0.

## Acceptance — met

`yarn clean` + `yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace run build` exits 0
and produces build output for every workspace, including vscode, sample-plugins, quoomb-cli,
quoomb-web, and shared-ui. ✓
