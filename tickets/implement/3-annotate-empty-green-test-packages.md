description: Four packages report a green test run while containing zero test files (`vitest run --passWithNoTests`), which reads as "tested" on a dashboard but tests nothing. Decide per package whether it needs real tests or is genuinely trivial, and mark the ones kept empty so the green is honest.
prereq:
files:
  - packages/quoomb-cli/package.json (test: "vitest run --passWithNoTests")
  - packages/shared-ui/package.json (test: "vitest run --passWithNoTests")
  - packages/plugin-loader/package.json (test: "vitest run --passWithNoTests")
  - packages/quoomb-web/package.json (test: "vitest run --passWithNoTests")
difficulty: easy
----

## Goal

Make the "green with no tests" state **honest and deliberate**. Four packages run
`vitest run --passWithNoTests` with no spec files: `quoomb-cli`, `shared-ui`,
`plugin-loader`, `quoomb-web`. A skimmer sees a passing test job and assumes coverage.
Decide, per package, whether that emptiness is fine — then annotate it so the next
reader knows it was a choice, not an oversight.

## Per-package decision (make the call, document it)

- **quoomb-web / shared-ui** — UI/bundle glue. Reasonable to keep test-free at the unit
  level (exercised via the app, not unit specs). If kept empty, add a `NOTE:` at the
  `test` script or top of `package.json`'s scripts explaining why (e.g.
  `NOTE: no unit tests — UI verified via the web app, not spec files; passWithNoTests intentional`).
- **quoomb-cli** — thin CLI wrapper over the engine. Judge whether any non-trivial
  argument-parsing / command-dispatch logic exists that a small smoke test would guard.
  If genuinely trivial, `NOTE:` it like the UI packages. If it has real logic, a single
  smoke spec (invoke a command, assert output) is cheap insurance — add it.
- **plugin-loader** — this is **core infrastructure** (plugin discovery/loading), not
  glue. An empty green here is the least defensible. Look at `src/`: if it carries real
  untested logic (manifest parsing, capability resolution, load ordering), that is a
  genuine coverage gap, **not** something to paper over with a NOTE. Do **not** try to
  build that suite inside this ticket — file a `backlog/debt-plugin-loader-test-coverage.md`
  describing the untested surface, and leave a `NOTE:` pointing at that slug in the
  meantime.

## Edge cases & interactions

- The `NOTE:` tag must be greppable (AGENTS.md tripwire convention) — use the literal
  `NOTE:` prefix so `grep -r "NOTE:"` finds the whole set.
- Don't remove `--passWithNoTests` from a package you leave empty — without it the run
  fails, which defeats the "green is a choice" goal. Keep the flag; add the note.
- If you add a real spec (quoomb-cli smoke), that package no longer needs
  `--passWithNoTests` for that reason — but leave the flag unless the package is
  guaranteed to always have specs, to avoid a future empty-glob failure.
- This overlaps only cosmetically with `test-add-missing-scripts` (which added the
  script *entries*); here we judge whether the entries test anything. Don't re-litigate
  script presence.

## TODO

- Read each of the four package `src/` trees enough to judge trivial-vs-real logic.
- Annotate the kept-empty packages with a greppable `NOTE:` explaining the choice.
- Add a quoomb-cli smoke spec only if it has real dispatch logic worth guarding.
- If plugin-loader has real untested logic, file `backlog/debt-plugin-loader-test-coverage.md`
  and NOTE-link it; do not build that suite here.
- Run `yarn test`; confirm all packages still green (empty ones via passWithNoTests,
  any new spec passing).
