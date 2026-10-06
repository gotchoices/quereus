---
description: The SQL logic test files now ship inside the published npm package, and downstream projects can locate them, so a consumer always tests against the corpus that matches the engine version it installed.
files:
  - packages/quereus/package.json          # files array (+2 entries), exports map (+"./package.json")
  - packages/quereus/test/README.md        # "Consuming the corpus from the npm package" subsection
  - packages/quereus/README.md             # Testing section points at the shipped corpus
  - packages/quereus/test/exports.spec.ts  # guard: resolves @quereus/quereus/package.json and lists test/logic
---

# Publish the `.sqllogic` corpus in the package

Filed from the lamina board (`bug-sqllogic-corpus-read-from-sibling-checkout-not-the-pinned-engine`). Lamina runs the quereus `.sqllogic` corpus against its own storage backend but read it from a sibling git checkout, so corpus and engine could drift and CI (no sibling checkout) could not run the lane. Shipping the corpus in the tarball makes them lockstep.

## What shipped

- `package.json` `files` gains `"test/logic/*.sqllogic"` (glob, so `test/logic/change-scope.spec.ts` stays out) and `"test/README.md"` (its `-- requires-capability:` section is the cross-repo format contract).
- `package.json` `exports` gains `"./package.json": "./package.json"`. Without it every subpath fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, so a consumer cannot find the package directory at all.
- `test/README.md` documents the `createRequire(...).resolve('@quereus/quereus/package.json')` → `dirname` → `test/logic` recipe, and why a `./test/logic/*` pattern export was rejected (resolves single files, cannot be listed).
- `test/exports.spec.ts` guards the `./package.json` export (JSON can't carry a comment saying why it's load-bearing). Implementer verified it fails with the entry removed.

Not yet published; lamina picks it up after the next release (bumping its range is lamina's work). Tarball cost measured by the filer on 4.18.0: ≈ +810 KB gzipped (+22%); the 4.20.1 tarball packed during review is 4.55 MB.

## Review findings

**Checked**

- Implement diff (`dd5a01502`) read in full before the handoff.
- Publish path: `scripts/publish-package.js` publishes with `yarn npm publish`, so `yarn pack` semantics (what the implementer verified) are the ones that matter — no npm-packlist divergence to worry about.
- Installed-tarball resolution — the gap the implementer flagged. Ran `yarn pack`, extracted into a scratch `node_modules/@quereus/quereus` under `tickets/.logs/` (deleted afterwards), and resolved from a script outside the workspace: CJS `createRequire().resolve` and ESM `import.meta.resolve` of `@quereus/quereus/package.json` both succeed; `test/logic` holds exactly 374 `.sqllogic` files and nothing else; `test/README.md` present.
- `test/logic` has no subdirectories and no non-`.sqllogic` data files the corpus would need, so the single-level glob is complete.
- `!dist/test` / `!**/*.tsbuildinfo` negations unaffected by the new entries (both new paths are outside `dist`).
- Lint (`yarn workspace @quereus/quereus run lint`, eslint + test typecheck): exit 0. `yarn docs:check`: OK. `exports.spec.ts`: 23 passing. Full `yarn test` was run by the implementer (10766 passing, 0 failing); review changes are docs-only, so not re-run.

**Found and fixed (minor)**

- `test/README.md`: the "Locating the corpus" paragraph was wedged between "This section is the format spec" and "Grammar —", splitting the format spec that downstream harnesses parse against. Moved it to its own `### Consuming the corpus from the npm package` subsection at the end of the logic-test conventions, and linked to it from the "not published" parenthetical.
- `packages/quereus/README.md` (the README npm renders) never mentioned that the corpus ships. Added one sentence in Testing linking to the new subsection.

**Considered, no action**

- Test strength: the spec resolves through the workspace symlink, so it guards the `exports` entry but not the `files` entries — removing `"test/logic/*.sqllogic"` from `files` would not fail it. A tarball-listing test (`yarn pack --dry-run` from a spec) would spawn a subprocess on every test run for a two-line config guard; not worth it. No tripwire comment added because JSON can't carry one and the README subsection already states what ships.
- Harness-side exclusions (`MEMORY_ONLY_FILES` in `logic.spec.ts`) don't ship, so a downstream consumer can't see which files quereus itself skips under store mode. Already documented as quereus-private in the README's "What this is NOT" block; lamina maintains its own handling. No change.
- Tarball growth (+22%): accepted by the filer; no runtime cost to consumers that don't read the corpus.
- No tickets filed; no tripwires added.
