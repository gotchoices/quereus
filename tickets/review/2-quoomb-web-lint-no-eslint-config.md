description: Three web/CLI packages had a broken `lint` command that errored out immediately because no linter was ever configured; it was replaced with a harmless no-op that just prints a message, matching what the VS Code extension package already does.
prereq:
files:
  - packages/quoomb-web/package.json     # line 24: lint script → no-op
  - packages/quoomb-cli/package.json      # line 26: lint script → no-op
  - packages/shared-ui/package.json       # line 30: lint script → no-op
  - packages/quereus-vscode/package.json  # precedent (unchanged): no-op lint at line 74
  - AGENTS.md                             # § Build & Test reference (unchanged)
difficulty: low

# Review: retire broken vestigial lint scripts in quoomb-web / quoomb-cli / shared-ui

## What was done

Under ESLint v9 a missing flat config is a hard abort during config discovery, so the
three packages that declared a `lint` script but shipped no `eslint.config.*` would exit
non-zero before reading a single file. The plan stage decided **Option 2 — retire the
vestigial scripts** (rather than stand up real React/TS flat configs, which would surface a
flood of pre-existing violations needing deliberate human sign-off).

The implementation is a single one-line edit in each of three `package.json` files:

```json
"lint": "echo 'No lint configured'"
```

The sentinel string is **byte-identical** across all three packages (a future grep for
`No lint configured` finds all three). It deliberately omits the `for extension` suffix the
vscode precedent uses, per the ticket's explicit instruction to keep the three identical.

- `packages/quoomb-web/package.json` (was `eslint src/**/*.{ts,tsx}`)
- `packages/quoomb-cli/package.json`  (was `eslint src/**/*.ts`)
- `packages/shared-ui/package.json`   (was `eslint src/**/*.{ts,tsx}`)

Each edit changed only the one `lint` line; surrounding 2-space JSON formatting is intact
(no whole-file reflow).

**eslint devDeps were intentionally left in place.** The ticket marked devDep removal as
OPTIONAL and not required, recommending the minimal script-only change. `eslint` and
`@typescript-eslint/*` remain in each package's `devDependencies`; the lockfile is
untouched.

## Verification performed

- `yarn workspace @quereus/quoomb-web lint` → prints `No lint configured`, exit 0.
- `yarn workspace @quereus/quoomb-cli lint` → prints `No lint configured`, exit 0.
- `yarn workspace @quereus/shared-ui lint` → prints `No lint configured`, exit 0.
- Confirmed no `prelint`/`postlint` (or other `pre*`/`post*`) hooks reference these scripts
  in any of the three packages.
- AGENTS.md § Build & Test ("Only `packages/quereus` has a lint script") still reads
  correctly — no edit was needed; the no-op echoes are not real lint scripts.

## What a reviewer should check

- **Sentinel consistency.** Grep `No lint configured` across the repo and confirm exactly
  the three edited packages match with the identical string (vscode uses a different
  trailing phrase by design).
- **Scope discipline.** Confirm each diff is a single-line change with no incidental JSON
  reformatting and no devDependency / lockfile churn.
- **No gate regression.** Root `yarn lint` still runs only `@quereus/quereus run lint`;
  `yarn check` / `yarn test` never invoked these scripts. This edit cannot regress CI/agent
  gates, but a reviewer may want to re-confirm by inspecting the root `package.json` scripts.

## Known gaps / out of scope

- **No real linting was added.** Option 1 (flat config + dependency adoption + triaging the
  ~9,500 lines of never-linted violations) is explicitly deferred to a separate human
  sign-off ticket. This change only aligns reality with AGENTS.md.
- devDep cleanup was not performed (optional per ticket). If a reviewer wants the unused
  eslint devDeps gone, note the blast radius: they are hoisted at the repo root and
  `packages/quereus/eslint.config.mjs` pulls `typescript-eslint` + `@eslint/js` from the
  root — root-level deps must stay untouched. Recommend keeping as-is.
