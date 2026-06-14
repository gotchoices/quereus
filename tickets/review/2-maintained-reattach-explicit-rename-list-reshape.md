description: Review the differ change that carries the DECLARED rename list (`maintained.columns`) through every `set maintained` re-attach, so a rename-list change on an EXPLICIT maintained table applies via `apply schema` and converges in place (no drop+recreate) instead of erroring at the strict attach shape check. The differ stays thin (hands the verb the authored list); the verb does the positional relabel + backing rename + re-record.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts                     # setMaintained.columns (~177); applyMaintainedTransition carry (~1963 attach, ~1983 re-attach); generateMigrationDDL render (~2486)
  - packages/quereus/test/declarative-equivalence.spec.ts            # rewritten headline test (~1407) + implicit sibling (~1474)
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts   # new "explicit rename-list carried through the re-attach" describe (~138)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic       # apply-schema convergence section (~1247)
  - docs/materialized-views.md                                       # Declarative-schema integration bullet (~706)
difficulty: medium
----

# Differ carries the rename list through the re-attach — review handoff

## What landed

The change is small and local to `schema-differ.ts`. The bodyHash already covers
the canonical definition (the explicit rename list + body SQL), so any rename-list
change ALREADY drifts the hash and `applyMaintainedTransition` ALREADY emitted a
`setMaintained`. The only gap was that the emitted op did not carry the declared
column list, so the re-attach verb could only follow the body's natural names
(going implicit) and never converged an EXPLICIT MV. Now:

- `TableAlterDiff.setMaintained` gained `columns?: ReadonlyArray<string>`
  (schema-differ.ts ~177).
- `applyMaintainedTransition` includes `columns: declaredMaintained.columns` on
  BOTH the fresh-attach branch (~1963) and the re-attach branch (~1983).
  `undefined` for an implicit/sugar-without-list MV ⇒ the verb stays implicit.
- `generateMigrationDDL` passes `columns: alter.setMaintained.columns` into the
  synthetic `setMaintained` action (~2486), so `astToString` renders
  `set maintained (a, c) as …` (relies on the prereq's stringify support) or the
  bare `set maintained as` when absent.

The detach-leg machinery (`dropMaintained` for a concurrent SHAPE change) is
untouched — an explicit rename-list change is an in-place verb reshape now, not a
detach→reattach.

**Important provenance note for the reviewer:** all of the above was already
committed in `6ac556d3` (the runner's "agent error … added resume note" commit,
which captured the interrupted prior run's working tree). The resume run did NOT
re-edit source — it verified the committed state compiles, lints, and passes, and
filed the missing fix ticket below. So review the committed diff at `6ac556d3`
against `a3316d43`'s parent, not the working tree (the tree is clean).

## How it behaves (use cases to validate)

- **Sugar explicit rename** `mv (a, b) → mv (a, c)`: one `apply schema` relabels
  the backing `b → c` in place, re-records `derivation.columns = (a, c)`, rows
  survive with values intact, maintenance stays live, re-diff converges.
- **Body-only on an explicit MV** (`(a, b)` list stable, body gains a WHERE):
  carries `(a, b)`, applies, converges (errored before this work).
- **Explicit → implicit** (`mv (a, b)` → `mv as …`): `columns` undefined ⇒ verb
  reshapes to the body names, records implicit, converges.
- **Implicit → explicit** (`mv as …` → `mv (a, b)`): carries `(a, b)`, relabels
  backing `(id, x) → (a, b)`, records explicit, converges.
- **Arity change** (`(a, b)` → `(a, b, d)` with widened body): differ carries the
  3-name list verbatim; the verb's strict count check rejects at apply with a
  sited error ("body produces 3 columns but the table declares 2") — never a
  silent widen. Live record unchanged.
- **Concurrent tag drift + rename list**: both ride one alter; the carried
  `columns` does not disturb `markMaintainedTagRoute` (the SET TAGS routes through
  ALTER MATERIALIZED VIEW). See KNOWN GAP below for the tag-VALUE caveat.
- **`require-hint` policy**: a re-attach is an ALTER, not a create+drop, so it does
  not trip the unhinted-rename guard.

## Tests & validation status

- `declarative-equivalence.spec.ts` + `maintained-table-differ-coverage.spec.ts`:
  **145 passing** (run directly).
- Full quereus memory suite (`yarn workspace @quereus/quereus run test`, includes
  the new `50-declarative-schema.sqllogic` convergence section): **6216 passing,
  9 pending, exit 0**.
- `yarn workspace @quereus/quereus run build`: clean.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`):
  clean.
- `yarn test:store` (LevelDB store path): **DEFERRED** per ticket — agent-runnable
  but slow; not run. No store-specific residual is expected (the change is in the
  plan-free differ + DDL stringify, store-agnostic), but ALTER/maintained paths do
  exercise store code, so a reviewer or CI should confirm `test:store` green.

## Gaps & deviations the reviewer should weigh

1. **Table-form rename case not covered as a carried-columns path (documented
   deviation).** The ticket asked for a `maintained (a, b) → (a, c)` table-form
   case. The literal column-less `create table mv maintained (a, b) as …` is not
   grammar-accepted (a `table` item requires a column block), and a declared-SHAPE
   table form whose authored NAME list changes ALSO drifts the table's own declared
   column set (`b → c`), which the differ resolves as an independent column
   drop+add — the pre-existing detach→reshape→re-attach path, orthogonal to this
   ticket's carried-columns surface. So the table-form coverage instead exercises a
   **body-only** re-attach (rename list stable) through the declared-shape branch
   (`maintained-table-differ-coverage.spec.ts` ~272). The NOTE at ~118–137 spells
   this out. Reviewer: confirm this scoping is acceptable, or push a follow-up if
   the table-form name-list change deserves explicit coverage on its own path.

2. **KNOWN GAP — concurrent SET TAGS dropped on a *reshaping* re-attach
   (orthogonal, now filed).** The concurrent-tag test (~222) asserts the rename
   lands and converges but **deliberately does NOT assert the tag VALUE**, because
   a reshaping re-attach rebuilds `live` from the module's post-ALTER (tag-less)
   schema, dropping the concurrent tags. This is pre-existing (the implicit reshape
   had it too) and the test referenced a tracking ticket that **did not exist** —
   the resume run filed it: `tickets/fix/maintained-reshape-reattach-drops-concurrent-tags.md`.
   Once that fix lands, tighten the test to assert `tags['team.owner'] === 'new'`
   and drop the gap note (~241–250).

3. **Adversarial angles worth a fresh look.** (a) The arity-error message is
   asserted via regex — confirm the verb's strict count check is the ONLY thing
   guarding a silent widen/narrow when the list and body counts move together.
   (b) In-diff source rename + MV rename-list change in the same diff:
   `maintainedBodyMatches` reconciles the source rename before the hash compare and
   the carried `columns` is the post-rename DECLARED list — there is no direct test
   combining a source-column rename WITH an MV output rename-list change in one diff;
   reason about / add one if you suspect double-churn. (c) The fresh-attach branch
   now also carries `columns`; confirm a plain-table → explicit-MV attach (not just
   re-attach) records the authored list correctly.

## Acceptance recap (all met)

Explicit rename-list change applies via `apply schema` and converges; backing
column renamed and `derivation.columns` updated; table incarnation survives (not a
drop+recreate); unrelated rows survive; arity change stays a sited error; re-diff
idempotency holds after each apply. The headline limitation test is rewritten to
assert it now APPLIES; the docs known-limitation note is removed.
