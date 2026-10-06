---
description: Review the change that ships the SQL logic test files inside the published npm package and lets downstream projects locate them, so a consumer always tests against the corpus that matches the engine version it installed.
files:
  - packages/quereus/package.json          # files array (+2 entries), exports map (+"./package.json")
  - packages/quereus/test/README.md        # corrected "not published" note; new "Locating the corpus from the npm package" paragraph
  - packages/quereus/test/exports.spec.ts  # new guard: resolves @quereus/quereus/package.json and lists test/logic
---

# Publish the `.sqllogic` corpus in the package — review handoff

Filed from the lamina board (`bug-sqllogic-corpus-read-from-sibling-checkout-not-the-pinned-engine`). Lamina runs the quereus `.sqllogic` corpus against its own storage backend but read it from a sibling git checkout, so corpus and engine versions could drift and CI (no sibling checkout) could not run the lane. Shipping the corpus in the tarball makes them lockstep.

## What changed

`packages/quereus/package.json`:

- `files` gains `"test/logic/*.sqllogic"` and `"test/README.md"`. Glob, not the bare directory, so `test/logic/change-scope.spec.ts` stays out. `test/README.md` ships because its `-- requires-capability:` section is the cross-repo format contract lamina's harness cites.
- `exports` gains `"./package.json": "./package.json"` as the first entry. Without it, every subpath (and even the bare specifier under CJS, since `.` has only `types`/`import` conditions) fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so a consumer cannot find the package directory at all.

`packages/quereus/test/README.md`: the old parenthetical said quereus "does not publish its test tree"; now says the harness and compiled tests are unpublished but the corpus and README ship. Added a short paragraph with the `createRequire(...).resolve('@quereus/quereus/package.json')` → `dirname` → `test/logic` recipe, and why a pattern export was rejected.

`packages/quereus/test/exports.spec.ts`: one new `describe('Package exports map')` test. The ticket said "no test change"; I added this anyway because the `./package.json` export is load-bearing but JSON can't carry a comment explaining it, so a future exports tidy-up could silently drop it. Verified the test **fails** with `ERR_PACKAGE_PATH_NOT_EXPORTED` when the entry is removed and passes with it.

## Validation done

- `yarn pack --dry-run` in `packages/quereus`: **374** `test/logic/*.sqllogic` entries (the ticket's 371 is stale — corpus grew), plus `test/README.md`; no `change-scope.spec.ts`; no `*.tsbuildinfo` (a `dist/tsconfig.tsbuildinfo` exists locally and was excluded).
- `!dist/test` negation: `dist/test` doesn't exist in a normal build, so I created a throwaway `dist/test/probe.js`, re-ran `yarn pack --dry-run` → 0 `dist/test/` entries, then deleted it.
- Resolution from repo root (workspace symlink `node_modules/@quereus/quereus`): CJS `createRequire().resolve` and ESM `import.meta.resolve` of `@quereus/quereus/package.json` both succeed; `readdirSync` of `test/logic` finds 374 `.sqllogic` files.
- `npx eslint test/exports.spec.ts`, `yarn typecheck:test`, `yarn docs:check`: clean.
- `yarn test` in `packages/quereus`: 10766 passing, 25 pending, 0 failing.

## Known gaps / for the reviewer

- Resolution was verified through the workspace symlink and self-reference, not from a real `node_modules` install of a packed tarball. The exports semantics are the same, but an installed-tarball check (e.g. `yarn pack` → install into a scratch dir → resolve) was not run.
- Not published. Lamina picks this up only after a release; bumping its range is lamina's work.
- Tarball cost (measured on 4.18.0 by the filer): ≈ +810 KB gzipped, +22%. Not re-measured here.
- Downstream drift note from the original ticket still applies: a new `-- requires-capability:` token in the corpus will hard-error lamina's allow-list at upgrade time. That is deliberate on lamina's side.
