description: The monorepo build is a hand-maintained 16-step chain that rebuilds every package in a fixed order every time; the TypeScript project-reference machinery that would make it dependency-aware and incremental is half-configured and unused. Wire real project references so one `tsc -b` builds the library packages in the right order, incrementally.
prereq:
files:
  - package.json (root — the sequential 16-script build:* chain, lines 17 / 33-46)
  - tsconfig.base.json (has composite:true, extended by only 5 packages)
  - packages/*/tsconfig.json (composite inconsistent; only isolation/sync-client/vscode carry any `references`)
  - packages/quereus-isolation/tsconfig.json (the one already-correct example: composite + references:[{path:../quereus}])
difficulty: hard
----

## Goal

Replace the hand-ordered, fully-serial `tsc` portion of the root build with a
dependency-aware **`tsc -b` (build mode / project references)** invocation, so
adding or reordering a package no longer means editing a 16-step chain, and
unchanged packages are skipped incrementally.

Today `package.json` `build` is:

```
yarn clean && yarn build:engine && yarn build:loader && yarn build:isolation
  && yarn build:store && yarn build:plugin-indexeddb && ... && yarn build:web
```

Each `build:*` is `cd packages/<pkg> && yarn build`, run strictly in order. The
order is a human's mental model of the dependency graph. `tsc -b` already knows that
graph *if* the `references` are declared — but they mostly aren't.

## Current state (measured, do not re-derive)

- `tsconfig.base.json` sets `composite: true` but only **5** packages extend it
  (plugin-loader, quoomb-cli, quoomb-web, sample-plugins, shared-ui), and several
  package tsconfigs override `composite` locally (some to absent/false).
- Only **3** packages declare any `references`: `quereus-isolation`
  (`→ quereus`, and it is the correct template), `quereus-sync-client`, `quereus-vscode`.
- So `tsc -b` today would not build the graph — the edges are missing.

## Two classes of package (this is the crux)

**A. Pure-`tsc` library packages** — join the `tsc -b` graph:
quereus, plugin-loader, quereus-isolation, quereus-store, quereus-sync,
quereus-sync-client, sync-coordinator, quereus-plugin-leveldb,
quereus-plugin-indexeddb, quereus-plugin-react-native-leveldb,
quereus-plugin-nativescript-sqlite, sample-plugins, quoomb-cli.
(Confirm each is `"build": "tsc"` before including — quoomb-cli is `tsc`.)

**B. Bundled apps** — cannot be `tsc -b` leaves as-is; keep them as explicit build
steps that run **after** the `tsc -b` graph:
- quoomb-web: `tsc && vite build`
- shared-ui: `tsc && vite build --mode lib`
- quereus-vscode: custom two-step esbuild (`build:server && build:client`)

Design decision to encode: root `build` becomes
`yarn clean && tsc -b <root-solution-tsconfig> && <bundled-app build steps>`.
The bundled apps' own `tsc &&` prefix may become redundant once they're referenced
in the solution (their `.d.ts` deps are already built) — decide per app whether to
keep the local `tsc` for type-check or drop it; document the choice inline.

## Design

- Create a **root solution tsconfig** (e.g. `tsconfig.build.json` at repo root) with
  empty `files: []` and `references` listing every class-A package (and optionally the
  class-B tsc-buildable parts). `tsc -b tsconfig.build.json` then builds the whole DAG.
- For every class-A package tsconfig: ensure `composite: true` and add a `references`
  array pointing at each of its **workspace dependencies** (read the `dependencies` /
  `peerDependencies` in each `package.json` and map `@quereus/<x>` → `../<pkg>`).
  Use `quereus-isolation/tsconfig.json` as the working template.
- Verify **output layout**: composite projects require each referenced project's
  `outDir` to contain its emitted `.d.ts`, and `rootDir`/`include` must not overlap
  across projects. Fix any package whose emit layout composite rejects.
- Keep `test` excluded from the composite build (tests are type-checked separately via
  the existing `tsconfig.test.json` gates — do not fold them into the solution build).

## Edge cases & interactions

- **`composite` forces `declaration: true` and disallows some options** — a package
  that currently emits without declarations, or sets `noEmit`, will error under
  composite. Fix the tsconfig, don't disable composite.
- **Circular references**: `tsc -b` hard-errors on a reference cycle. If any two
  workspace packages reference each other (e.g. a plugin ↔ isolation ↔ store loop),
  surface it — a cycle is a real design smell, not something to paper over. Report it
  in the handoff rather than silently breaking the edge.
- **`allowJs`/`checkJs`** (isolation sets both) interacts with composite emit — verify
  the JS-inclusive packages still emit correct declaration output under `-b`.
- **Stale `.tsbuildinfo`**: `yarn clean` already globs `*.tsbuildinfo`; confirm it
  covers any new root `tsconfig.build.tsbuildinfo` so a dirty incremental cache can't
  mask a broken graph.
- **Windows path length / globs**: the lint step already fights cmd-line-too-long on
  Windows (AGENTS.md); `tsc -b` sidesteps per-package `cd` but confirm the single
  solution build runs clean on Windows.
- **Publish ordering**: the `pub:*` chain (root package.json) also hard-codes order.
  Out of scope to migrate, but note it still assumes the manual order — leave a
  `NOTE:` if the build order and publish order can now diverge.
- **`yarn build:<pkg>` call sites**: other scripts / docs may invoke individual
  `build:*` scripts. Keep the per-package `build` scripts working (don't delete them);
  only the **root `build`** switches to `tsc -b`. Grep for `build:` references before
  removing anything.

## Validation

- `yarn build` from a clean tree → exit 0, all `dist/` present, correct order derived
  by `tsc -b` (not the hand chain).
- Touch one leaf source file, re-run `yarn build` → only that package (and its
  dependents) rebuild — proves incrementality.
- `yarn test` and the type-check gates still pass (composite changes must not alter
  emitted JS semantics).
- Stream long build output (`yarn build 2>&1 | tee /tmp/build.log; tail -n 60 /tmp/build.log`)
  — do not silently redirect (idle-timeout risk).

## TODO

- Audit each class-A package.json to confirm `"build": "tsc"` and read its workspace deps.
- Add `composite: true` + correct `references` to every class-A package tsconfig
  (template: quereus-isolation).
- Fix any output-layout / declaration errors composite surfaces.
- Add root `tsconfig.build.json` (empty files, references = all class-A projects).
- Rewrite root `build` script: `yarn clean && tsc -b tsconfig.build.json && <bundled apps>`.
- Decide + document the `tsc &&` prefix fate for quoomb-web / shared-ui / vscode.
- Full clean build + incremental-touch build + `yarn test`; confirm green, streamed.
