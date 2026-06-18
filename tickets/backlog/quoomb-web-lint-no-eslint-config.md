description: The `lint` script in quoomb-web (and quoomb-cli, shared-ui) invokes eslint but ships no flat config, so under ESLint v9 the command aborts during config discovery before evaluating any source. Decide whether to give these packages a real React/TS flat config or retire the vestigial scripts, then apply consistently.
files:
  - packages/quoomb-web/package.json    # "lint": "eslint src/**/*.{ts,tsx}" — no eslint.config.* beside it
  - packages/quoomb-cli/package.json     # "lint": "eslint src/**/*.ts" — same problem
  - packages/shared-ui/package.json      # "lint": "eslint src/**/*.{ts,tsx}" — same problem
  - packages/quereus/eslint.config.mjs   # the only working flat config; reference for project style
  - packages/quereus-vscode/package.json # precedent for a deliberate no-op lint ("echo 'No lint configured'")
  - AGENTS.md                            # Build & Test: "Only packages/quereus has a lint script"
difficulty: low

# quoomb-web (and quoomb-cli, shared-ui) lint aborts: no ESLint flat config

## Failing command

```
yarn workspace @quereus/quoomb-web lint
# → eslint src/**/*.{ts,tsx}
```

Run from repo root. Reproduces at HEAD (branch `view-updates-lens`, commit `e76754ca`).

## Error output

```
Oops! Something went wrong! :(

ESLint: 9.39.2

ESLint couldn't find an eslint.config.(js|mjs|cjs) file.

From ESLint v9.0.0, the default configuration file is now eslint.config.js.
...
```

Exit code 2. ESLint aborts during **config discovery** — it never evaluates a single
source file, so the failure is independent of any `.ts`/`.tsx` contents.

## Root cause

`packages/quoomb-web` declares `"lint": "eslint src/**/*.{ts,tsx}"` but ships no
`eslint.config.*` (nor any `.eslintrc*`), and there is no shared config at the repo
root. The only flat config in the repo is `packages/quereus/eslint.config.mjs`. Under
ESLint v9 a missing flat config is a hard abort, not a warning.

The same latent break exists in two sibling packages with identical script shape:
- `packages/quoomb-cli` — `"lint": "eslint src/**/*.ts"`, no config.
- `packages/shared-ui`  — `"lint": "eslint src/**/*.{ts,tsx}"`, no config.

`packages/quereus-vscode` sidesteps it with a deliberate no-op: `"lint": "echo 'No
lint configured for extension'"`.

## Impact / blast radius

Low and contained today:
- The script is **not** wired into anything that gates CI or agents. Root `yarn lint`
  runs only `@quereus/quereus run lint`; root `yarn test` runs each package's `test`
  script; `yarn check` = `lint && build && test:full && test:fork-strict`. None invoke
  the quoomb-web/quoomb-cli/shared-ui `lint`.
- AGENTS.md § Build & Test states "Only `packages/quereus` has a lint script," i.e. the
  documented expectation already treats these scripts as out of the maintained set.

So this is a latent/vestigial-script issue, not an active regression.

## Decision to make (why this wasn't fixed inline)

Two defensible fixes, and the choice is a project-policy call, not a confident default:

1. **Give the packages a real flat config.** quoomb-web is ~9,500 lines across 46
   never-linted `.ts`/`.tsx` files (React). Standing up a config would almost certainly
   surface a wave of pre-existing violations — replacing a config-discovery abort with a
   large lint-error list. That's a real linting-adoption effort (author a React-aware
   config, add deps, then triage/fix or tune-down findings), not a triage one-liner.
   Note: `quereus/eslint.config.mjs` pulls in `typescript-eslint` + `@eslint/js` (both
   hoisted at the repo root and resolvable from quoomb-web) and `eslint-plugin-import`
   with `import/extensions: always` — the extension rule is wrong for a Vite/React TSX
   project, so the config can't be copied verbatim.

2. **Retire the vestigial scripts.** Match the `quereus-vscode` precedent (no-op echo) or
   remove the `lint` scripts and their eslint devDependencies, aligning reality with the
   AGENTS.md statement that only `packages/quereus` lints.

## Ruled out during triage

- Not caused by recent work: quoomb-web has **never** had an `eslintrc`/flat config in
  git history; `git status` shows `package.json` clean. The lint script has been broken
  since the ESLint v9 bump.
- Not a source-file bug: the abort happens before any file is read, so no `.ts`/`.tsx`
  edit could introduce or resolve it.
- Not safely fixable inline within triage scope: option 1 risks a flood of new lint
  errors across 9,500 unlinted lines (command still fails, just differently); option 2
  is a multi-package policy change. Neither is a confident, tightly-scoped fix.

## TODO

- [ ] Decide: adopt real linting for quoomb-web/quoomb-cli/shared-ui, or retire the
      scripts (no-op or remove). Apply the choice consistently across all three.
- [ ] If adopting: author a React/TS-appropriate flat config (do **not** copy quereus's
      `import/extensions: always`), add required devDeps, run, and triage findings.
- [ ] If retiring: update the scripts (and drop now-unused eslint devDeps) and keep
      AGENTS.md § Build & Test accurate.
