description: The monorepo now builds with dependency-aware, incremental TypeScript project references (`tsc -b`) instead of a hand-ordered 16-step chain — review the wiring for correctness and completeness.
prereq:
files:
  - tsconfig.build.json (NEW — root solution config; `files: []` + references to all 13 class-A packages)
  - package.json (root `build` now `yarn clean && tsc -b tsconfig.build.json && yarn build:ui && yarn build:vscode && yarn build:web`; `clean` adds tsconfig.build.tsbuildinfo; new `//build` + `//pub` note keys)
  - packages/quereus-store/tsconfig.json (+composite +references)
  - packages/quereus-sync/tsconfig.json (+composite +references)
  - packages/sync-coordinator/tsconfig.json (+composite +references)
  - packages/quereus-sync-client/tsconfig.json (+references; composite already present)
  - packages/plugin-loader/tsconfig.json (+references; composite via base)
  - packages/quereus-plugin-{leveldb,indexeddb,react-native-leveldb,nativescript-sqlite}/tsconfig.json (+composite +references)
  - packages/sample-plugins/tsconfig.json (+references; composite via base)
  - packages/quoomb-cli/tsconfig.json (+references; composite via base)
  - packages/quereus/tsconfig.json + packages/quereus-isolation/tsconfig.json (UNCHANGED — already composite; isolation already had its reference)
difficulty: medium
----

## What changed & why

Root `build` was a 16-link `yarn build:engine && yarn build:loader && …` chain whose
order was a human's mental model of the dependency graph. It is now:

```
yarn clean && tsc -b tsconfig.build.json && yarn build:ui && yarn build:vscode && yarn build:web
```

`tsc -b` (TypeScript **build mode** / project references) reads each package
tsconfig's `references` array, topologically sorts the graph itself, and skips
packages whose inputs are unchanged. Adding/reordering a library package is now a
one-line `references` edit, not a chain edit.

### Two package classes (the design split)

**Class A — pure-`tsc` libraries → join the `tsc -b` graph** (13 packages, all
`"build": "tsc"`): quereus, plugin-loader, quereus-isolation, quereus-store,
quereus-sync, quereus-sync-client, sync-coordinator, quereus-plugin-{leveldb,
indexeddb,react-native-leveldb,nativescript-sqlite}, sample-plugins, quoomb-cli.
Each got `composite: true` (where missing) + a `references` array mapping its
workspace deps (`dependencies` + `peerDependencies`) `@quereus/<x>` → `../<pkg>`.

**Class B — bundled apps → stay explicit steps *after* the graph**: shared-ui
(`tsc && vite build --mode lib`), quoomb-web (`tsc && vite build`), quereus-vscode
(two-step esbuild). These emit via vite/esbuild, not plain `tsc`, so they cannot be
`tsc -b` leaves. Ordered shared-ui → vscode → web because web consumes shared-ui's
`dist`.

### Derived build order (from references, confirmed by `tsc -b --dry`)
```
quereus → { plugin-loader, isolation }
isolation → store → { sync, plugin-leveldb, plugin-indexeddb, plugin-rn, plugin-ns }
sync → { sync-client, sync-coordinator }   (sync-coordinator also → plugin-leveldb)
quereus → { sample-plugins, quoomb-cli(+plugin-loader) }
```
No reference cycles. (`quereus/src` only mentions `@quereus/*` in JSDoc, so it is a
true leaf; `store→plugin-leveldb` appears only in a JSDoc `@example`, not a real
import — verified, so no store↔plugin-leveldb cycle.)

## Validation performed (all green)

- **Full clean build** `yarn build` → exit 0. All `dist/` present (spot-checked
  quereus, store, sync, sync-client, sync-coordinator, plugin-leveldb, plugin-loader,
  quoomb-cli `dist/index.js`+`dist/bin/quoomb.js`, sample-plugins, shared-ui,
  quoomb-web `dist/index.html`). Output layout unchanged (`dist/src/**` for most;
  `dist/**` for quoomb-cli/sample-plugins — matches each package.json `main`).
- **Incrementality** — `touch packages/quereus-store/src/index.ts` + `tsc -b --dry
  --verbose`: store's dependents (sync, plugin-leveldb, sync-coordinator, indexeddb,
  rn, ns) report *"up to date **with .d.ts files from its dependencies**"* (TS checked
  them against store's output) while upstream/unrelated packages (quereus, isolation,
  plugin-loader, sync-client, sample-plugins, quoomb-cli) report *"newest input older
  than output"*. This proves the graph edges are live and dependency-aware.
- **`yarn test`** → exit 0: quereus 6896 pass / 13 pending, store 910, sync 474,
  sync-client 52, sync-coordinator 117, quoomb-cli 5, quoomb-web 74, plugin-loader 3,
  plus isolation/plugin/sample suites. (stderr in log is intentional error-path test
  logging, not failures.)
- **Type-check gates** — `tsc -p tsconfig.test.json --noEmit` for quereus and store
  → exit 0. Confirms `composite` (inherited by the test configs, which `extends`
  the now-composite main configs) coexists with `--noEmit` on TS 5.9.
- **`yarn lint`** → exit 0 (quereus eslint + its test-config tsc gate; others no-op).

## Use cases for the reviewer to exercise

- **Re-run `yarn build` from clean** — confirm exit 0 and that `tsc -b` derives the
  order (no `build:engine`/`build:loader`/… chain runs; only the 3 bundled-app steps
  echo after the silent `tsc -b`).
- **Real incremental edit** (I only used `touch`, which changes mtime not content, so
  no re-emit happened — see gap below). Make a *real* content edit to a leaf source
  (e.g. add an exported const to `packages/quereus-store/src/index.ts`), run
  `yarn build`, and confirm store **and** its dependents re-emit while quereus /
  isolation / plugin-loader / sample-plugins / quoomb-cli do **not**. Then revert.
- **Standalone per-package scripts still work** — `yarn build:cli`, `yarn build:engine`,
  etc. are retained (not deleted); only the root `build` chain dropped them. Verify one
  still runs (assumes its deps' `dist` already built — same pre-existing contract).
- **`yarn clean` then `git status`** — confirm all `dist/` + `*.tsbuildinfo` +
  `tsconfig.build.tsbuildinfo` are removed and no source is touched.

## Known gaps / things to scrutinize (treat as a floor, not a finish line)

- **`references` include `isolation` for the 4 storage plugins via `peerDependencies`,
  but those plugin sources do not import `@quereus/isolation` directly** (they import
  quereus + store only; store already references isolation). The edges are harmless
  (isolation is always built before the plugins via store) and match the ticket's
  "map dependencies + peerDependencies" instruction, but a reviewer who prefers
  imports-only references may want to trim them. Not a correctness issue either way.
- **`packages/tools/planviz` (`@quereus/planviz`, `"build": "tsc"`, depends on
  `@quereus/quereus`) is NOT in the build.** `packages/tools` has no `package.json`,
  so the `workspaces: ["packages/*"]` glob never picks up `packages/tools/planviz` —
  it was already outside the old 16-step chain and remains outside `tsc -b`. If it is
  meant to be built, it needs adding to `workspaces` **and** `tsconfig.build.json`.
  Flagging, not fixing (out of scope; pre-existing).
- **Bundled apps keep their local `tsc &&` prefix** (decision, per ticket): quoomb-web
  `tsc` = type-check against freshly-built lib `.d.ts`; shared-ui `tsc` = emits its
  `.d.ts`+js before vite bundles; vscode uses esbuild + a separate `typecheck` script.
  Dropping them would lose type-checking/`.d.ts` emit since these packages are not in
  the solution. Confirm this is the intended trade-off. Also note shared-ui inherits
  `composite: true` from `tsconfig.base.json` (harmless for a standalone `tsc`); web
  overrides `composite: false` (correct — it's `noEmit`).
- **No root `tsconfig.build.tsbuildinfo` is actually emitted** — a solution config with
  `files: []` produces no build-info of its own; each project writes
  `dist/tsconfig.tsbuildinfo` (cleaned by the existing `packages/*/dist` glob). The
  `tsconfig.build.tsbuildinfo` entry I added to `clean` is defensive and currently
  matches nothing — kept in case a future TS version emits one. Verify you agree with
  keeping the dead-but-harmless glob.
- **`composite` + `--noEmit` coexistence is TS-version behavior.** It works on the
  pinned TS 5.9.3; older/newer majors have flip-flopped on whether this errors
  (TS5069). NOTE this if TypeScript is ever upgraded — the test-config gates would be
  the first to break. (Tripwire recorded here only; no single code site owns it.)
- **`yarn test:store` (LevelDB-backed path) was NOT run** — only the default memory
  `yarn test`. The tsconfig changes don't alter emitted JS semantics, so store-path
  behavior is very unlikely affected, but it wasn't exercised.
- **`pub:*` publish chain is now decoupled from build order.** Build order is derived;
  publish order is still hand-maintained. Added a `//pub` NOTE in root package.json so
  a future editor keeps the publish list in dependency order by hand. (Tripwire, in
  code at the site.)

## Review findings

- Tripwire: `composite`+`--noEmit` in the `tsconfig.test.json` gates is TS-version-
  dependent — parked as a `## Known gaps` bullet here (no single code site to tag).
- Tripwire: `pub:*` order can now diverge from the derived build order — parked as a
  `//pub` comment in root `package.json` at the site.
- Note: `packages/tools/planviz` is outside the workspace glob and thus outside the
  build graph (pre-existing) — flagged above, not changed.
