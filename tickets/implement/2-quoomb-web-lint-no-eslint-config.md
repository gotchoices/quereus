description: The `lint` command in three web/CLI packages is broken — it tries to run a linter that has no configuration and immediately errors out. Since these packages were never actually linted and nothing depends on the command, replace it with a harmless no-op (matching the existing convention in the VS Code extension package) instead of standing up real linting.
prereq:
files:
  - packages/quoomb-web/package.json     # "lint": "eslint src/**/*.{ts,tsx}" (line 24) → no-op
  - packages/quoomb-cli/package.json      # "lint": "eslint src/**/*.ts" (line 26) → no-op
  - packages/shared-ui/package.json       # "lint": "eslint src/**/*.{ts,tsx}" (line 30) → no-op
  - packages/quereus-vscode/package.json  # precedent: "lint": "echo 'No lint configured for extension'" (line 74)
  - AGENTS.md                             # § Build & Test: "Only packages/quereus has a lint script" (no change expected)
difficulty: low

# Retire the broken vestigial lint scripts in quoomb-web / quoomb-cli / shared-ui

## Background

Under ESLint v9 a missing flat config is a hard abort during config discovery —
`eslint` exits non-zero before reading a single source file. Three packages declare a
`lint` script but ship no `eslint.config.*` (and never have in git history):

- `packages/quoomb-web`  — `"lint": "eslint src/**/*.{ts,tsx}"`
- `packages/quoomb-cli`  — `"lint": "eslint src/**/*.ts"`
- `packages/shared-ui`   — `"lint": "eslint src/**/*.{ts,tsx}"`

These scripts gate nothing: root `yarn lint` runs only `@quereus/quereus run lint`,
and `yarn check`/`yarn test` never invoke them. AGENTS.md § Build & Test already
documents the maintained reality — "Only `packages/quereus` has a lint script."

The plan stage (overnight autonomous, 2026-06-18) **decided Option 2 — retire the
vestigial scripts** rather than stand up React/TS flat configs. Reasoning: adopting real
linting would surface a flood of pre-existing violations across ~9,500 never-linted lines
— a genuine project investment needing deliberate human sign-off, not an autonomous
overnight change. The conservative, reversible fix aligns reality with AGENTS.md. If real
linting is wanted later, that is a separate investment ticket, not this one.

## The change

Set the `lint` script in all three packages to one consistent no-op string, matching the
`quereus-vscode` precedent:

```json
"lint": "echo 'No lint configured'"
```

Apply it identically in `quoomb-web`, `quoomb-cli`, and `shared-ui`. Preserve each file's
existing indentation (quoomb-web uses 2-space; check the others and match).

Dropping the now-unused eslint devDependencies (`eslint`, `@typescript-eslint/*`) is
**OPTIONAL and not required**. Do it only if trivially safe — i.e. nothing else in the
package references them (no `eslint.config.*`, no script, no import) and the `yarn.lock`
delta stays contained. If there is any doubt, leave the devDeps in place; the minimal,
safest change is just the three script edits. Verifying script-only changes is cheaper and
the ticket's whole point is the conservative path.

## Verification

- `yarn workspace @quereus/quoomb-web lint` (and the cli/shared-ui equivalents) now exits 0
  and prints `No lint configured`.
- AGENTS.md § Build & Test ("Only `packages/quereus` has a lint script") stays accurate —
  no edit expected; confirm it still reads correctly.
- If (and only if) you removed devDeps: run `yarn install` and confirm the lockfile delta is
  limited to the dropped packages, and that `yarn workspace <pkg> build` still succeeds.

## Edge cases & interactions

- **Quoting / shell portability.** The echo string is run by `yarn`'s shell wrapper, not a
  raw terminal — single quotes inside the JSON string value are fine and match the
  `quereus-vscode` precedent. Keep it byte-identical across the three packages so a future
  grep for the sentinel finds all three.
- **Per-file indentation.** quoomb-web is 2-space; quereus-vscode is tab-indented. Don't let
  an editor reflow the whole file — change only the one line and keep the surrounding JSON
  formatting intact (a noisy whole-file reformat is a review reject).
- **Do NOT adopt Option 1.** No flat config, no new lint deps, no triaging violations here.
  That is explicitly out of scope and deferred to a separate sign-off.
- **devDep removal blast radius (only if you go there).** `eslint` and `@typescript-eslint/*`
  are hoisted at the repo root; removing them from one package's `devDependencies` must not
  break another workspace that resolves them transitively. quereus's own
  `eslint.config.mjs` pulls `typescript-eslint` + `@eslint/js` from the root — confirm those
  root-level deps are untouched. If verifying this is non-trivial, skip the removal.
- **No CI/agent gate touched.** Root `yarn lint`, `yarn check`, `yarn test` paths are
  unchanged; this edit cannot regress them. Sanity-check that none of the three `lint`
  scripts are referenced by a parent `pre*`/`post*` hook before assuming so.

## TODO

- [ ] Set `"lint": "echo 'No lint configured'"` in `packages/quoomb-web/package.json`.
- [ ] Set the same in `packages/quoomb-cli/package.json`.
- [ ] Set the same in `packages/shared-ui/package.json`.
- [ ] Run the three `yarn workspace <pkg> lint` commands; confirm each exits 0.
- [ ] Confirm AGENTS.md § Build & Test still accurately says only `packages/quereus` lints.
- [ ] (Optional, only if trivially safe) drop the unused eslint devDeps and re-run `yarn install`.
