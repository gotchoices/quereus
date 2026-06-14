description: The differ now carries the DECLARED rename list (`maintained.columns`) through every `set maintained` (re-)attach, so a rename-list change on an EXPLICIT maintained table applies via `apply schema` and converges in place (no drop+recreate) instead of erroring at the strict attach shape check. The differ stays thin (hands the verb the authored list); the verb does the positional relabel + backing rename + re-record.
files:
  - packages/quereus/src/schema/schema-differ.ts                     # setMaintained.columns (~177); applyMaintainedTransition carry (fresh-attach ~1963, re-attach ~1983); generateMigrationDDL render (~2486)
  - packages/quereus/test/declarative-equivalence.spec.ts            # rewritten headline test (~1407)
  - packages/quereus/test/maintained-table-differ-coverage.spec.ts   # "explicit rename-list carried through the re-attach" describe (~138) + new fresh-attach test
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # stale-comment fix (~787)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic       # apply-schema convergence section (~1247)
  - docs/materialized-views.md                                       # Declarative-schema integration bullet (~706)
difficulty: medium
----

# Differ carries the rename list through the re-attach — COMPLETE

## What landed

`TableAlterDiff.setMaintained` gained `columns?: ReadonlyArray<string>`. Both
`applyMaintainedTransition` branches (fresh attach + re-attach) now set
`columns: declaredMaintained.columns`, and `generateMigrationDDL` passes it into
the synthetic `setMaintained` action so `astToString` renders
`set maintained (cols) as …` (or the bare `set maintained as` when `undefined`).
The bodyHash already drifted on any rename-list change, so the differ already
emitted the op; the only gap was that the op did not carry the declared list, so
an EXPLICIT MV could only reshape to the body's natural names (going implicit) and
never converge. It converges in one `apply schema` now. The verb (prereq
`maintained-set-maintained-rename-list-verb`) does the positional relabel,
backing rename, and re-record; the differ never synthesizes or compares renames.

The source change shipped in commit `6ac556d3` (interrupted prior run, captured by
the runner); it is an ancestor of HEAD and the working tree is clean.

## Review findings

**Scope reviewed.** The differ diff at `6ac556d3` (vs parent), all five touched
files, the verb it leans on (`materialized-view-helpers.ts` attach/reshape +
arity guards), and the AST/stringify round-trip. Validated SPP/DRY (the carry is a
one-field addition shared by both branches — no duplication), type safety (the
`ReadonlyArray<string>` flows cleanly through the action; lint/tsc clean),
error handling (arity stays a sited error), and resource cleanup (n/a — plan-free
differ + stringify).

**Tests run (all green):**
- `declarative-equivalence` + `maintained-table-differ-coverage` +
  `maintained-table-attach-detach`: 184 → **185 passing** (after the added test).
- `logic.spec.ts` (incl. the new `50-declarative-schema.sqllogic` convergence
  section): **247 passing**.
- `yarn workspace @quereus/quereus run lint`: clean. `run build`: clean.

**Minor — fixed inline:**
1. *Stale comment.* `maintained-table-attach-detach.spec.ts` (the explicit-verb
   round-trip test) carried a comment from the prereq verb ticket claiming "the
   differ does not yet emit the list, so no apply-path test covers it" — this
   ticket made that false. Rewrote the comment to point at the differ-coverage
   spec's apply-path tests; the unit test itself (isolated stringify exercise)
   still has value and is unchanged.
2. *Coverage gap (implementer's flagged angle c).* The fresh-attach branch now
   also carries `columns`, but only the *re-attach* carry was covered end-to-end
   via `apply schema`; the plain-table → explicit-MV *fresh* attach was tested
   only by calling the verb directly. Added
   "a FRESH attach over a plain table carries the declared list (records explicit)"
   to the differ-coverage spec — declares an existing plain table as an explicit MV
   and asserts `setMaintained.columns`, no detach leg, `derivation.columns`
   recorded explicit, rows intact, and re-diff convergence. Passes.

**Checked — no change needed:**
- *Arity guard (angle a).* Confirmed there is no silent-widen path: the verb has
  TWO guards — rename-list-vs-body arity ("rename list declares N but body
  produces M") and table-vs-body shape ("body produces N but the table declares
  M") — plus the inexpressible-reshape reject for a swap/reorder. All three are
  exercised in `maintained-table-attach-detach.spec.ts`; the differ-coverage arity
  test confirms the table-vs-body guard fires through `apply schema` and the live
  record is left unchanged.
- *Source-rename + output-rename in one diff (angle b).* Verified by reasoning,
  not a new test: the carried `columns` is the DECLARED output list and is
  orthogonal to the body's input source-column names, which `maintainedBodyMatches`
  reconciles before the hash compare. The two surfaces are individually tested and
  do not interact through the carry; a combined test would be belt-and-suspenders,
  not coverage of an untested code path.
- *Docs.* `docs/materialized-views.md` (~706) is updated to the new reality
  (carries the declared list, both forms converge); grep over `docs/` and `src/`
  surfaced no other stale "does not yet carry / never converge" references.

**Major — already filed (orthogonal):**
- *Concurrent SET TAGS dropped on a reshaping re-attach.* The concurrent-tag test
  deliberately does not assert the tag VALUE because a *reshaping* re-attach
  rebuilds `live` from the module's post-ALTER (tag-less) schema, dropping the
  concurrent tags. This is pre-existing (the implicit reshape had it too) and is
  tracked by `tickets/fix/maintained-reshape-reattach-drops-concurrent-tags.md`
  (filed by the prior run; verified present and accurate). Once it lands, tighten
  the test to assert `tags['team.owner'] === 'new'` and drop the gap note.

**Documented deviation accepted:**
- The literal table-form name-list change (`maintained (a, b)` → `(a, c)`) is NOT
  covered as a carried-columns path because a declared-SHAPE table form whose
  authored NAME list changes also drifts the table's own declared column set, which
  the differ resolves as an independent column drop+add (the pre-existing
  detach→reshape→re-attach path, orthogonal to this ticket). The table-form
  coverage instead exercises a body-only re-attach through the declared-shape
  branch. The NOTE at the top of the differ-coverage describe spells this out.
  Scoping is correct — no follow-up filed.

## Acceptance (all met)

Explicit rename-list change applies via `apply schema` and converges; backing
column renamed and `derivation.columns` updated; table incarnation survives (not a
drop+recreate); unrelated rows survive; arity change stays a sited error; re-diff
idempotency holds after each apply; the headline limitation test asserts it now
APPLIES; the docs known-limitation note is removed.

## Deferred validation

`yarn test:store` (LevelDB store path) not run — agent-slow per ticket. The change
is in the plan-free differ + DDL stringify (store-agnostic); no store-specific
residual expected, but ALTER/maintained paths exercise store code, so CI should
confirm `test:store` green.
