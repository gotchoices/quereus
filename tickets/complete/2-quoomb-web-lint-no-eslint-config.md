description: Three web/CLI packages had a broken `lint` command that errored out immediately because no linter was ever configured; it was replaced with a harmless no-op that just prints a message, matching what the VS Code extension package already does.
prereq:
files:
  - packages/quoomb-web/package.json     # line 24: lint script → no-op
  - packages/quoomb-cli/package.json      # line 26: lint script → no-op
  - packages/shared-ui/package.json       # line 30: lint script → no-op
  - packages/quereus-vscode/package.json  # precedent (unchanged): no-op lint at line 74
  - AGENTS.md                             # § Build & Test reference (unchanged)
difficulty: low

# Complete: retire broken vestigial lint scripts in quoomb-web / quoomb-cli / shared-ui

## What shipped

The `lint` script in three packages was changed from an `eslint …` invocation (which
hard-aborts under ESLint v9 because no `eslint.config.*` exists) to a byte-identical no-op:

```json
"lint": "echo 'No lint configured'"
```

- `packages/quoomb-web/package.json:24` (was `eslint src/**/*.{ts,tsx}`)
- `packages/quoomb-cli/package.json:26`  (was `eslint src/**/*.ts`)
- `packages/shared-ui/package.json:30`   (was `eslint src/**/*.{ts,tsx}`)

eslint devDeps and the lockfile were intentionally left untouched (devDep removal was
optional per the implement ticket). This was the conservative Option 2 chosen in plan;
real linting (Option 1) remains a separate human-sign-off ticket.

## Review findings

Adversarial pass over commit `c74e7bbb`. The implementation is a textbook minimal change;
every handoff claim was verified independently and held.

**Verified / checked:**

- **Sentinel consistency** — `grep "No lint configured"` matches exactly the three edited
  packages with the identical string; `quereus-vscode` keeps its distinct
  `…for extension` suffix by design. ✓
- **Scope discipline** — `git diff c74e7bbb~1 c74e7bbb` over the three files is exactly one
  changed line each (12 marker lines = 3×[`---`,`+++`,`-`,`+`]); no whole-file reflow, no
  `devDependencies` edits, no `yarn.lock` churn. ✓
- **No broken lint left behind** — repo-wide grep confirms only `packages/quereus` still
  invokes `eslint`, and it is the only package shipping an `eslint.config.mjs`. No other
  package has a config-less eslint lint script. The ticket's three-package scope was
  complete. ✓
- **No gate regression** — root `yarn lint` → `@quereus/quereus run lint` (unchanged);
  `yarn check` / `yarn test` never invoke these per-package lint scripts. No `pre*`/`post*`
  lint hooks reference them in any of the three packages. ✓
- **Lint + tests pass** — all three `yarn workspace … lint` print `No lint configured`,
  exit 0. Affected-package tests green: quoomb-web 65 passed (4 files); quoomb-cli and
  shared-ui have no test files and exit 0 via vitest. ✓

**Minor (noted, no action):**

- AGENTS.md § Build & Test says "Only `packages/quereus` has a lint script." After this
  change four packages technically *declare* a `lint` script, but the three new ones (plus
  the pre-existing `quereus-vscode`) are no-op echoes, not real linters — so the doc's
  intent ("only quereus actually lints") still holds. The wording predates this ticket
  (vscode's no-op already existed) and is not a regression. Left as-is; not worth a churn.

**Major:** None.

**Out of scope (carried forward, not a defect):**

- No real linting was added. Standing up React/TS flat configs would surface a large
  backlog of never-linted violations needing deliberate human sign-off — explicitly
  deferred to a separate investment ticket, not filed here (it is a known, intentional
  product decision rather than a discovered gap).
- eslint devDep cleanup not performed (optional). Blast radius noted in the implement
  handoff: eslint deps are hoisted at the repo root and `packages/quereus/eslint.config.mjs`
  resolves `typescript-eslint` + `@eslint/js` from root, so root-level deps must stay.
  Recommend leaving as-is.
