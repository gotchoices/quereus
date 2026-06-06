description: COMPLETE — `ALTER TABLE … ADD COLUMN c <type> REFERENCES parent(pk) [DEFAULT …]` now validates existing (backfilled) rows against the referenced parent for both default kinds, reverting the column add on a violation. The shared FK existing-row validator was switched from `not exists` to a `LEFT JOIN … IS NULL` left-anti-join to dodge an engine decorrelation bug (spawned fix ticket `altered-column-not-exists-antijoin-misread`).
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic, packages/quereus/test/logic/41.8-alter-add-constraint-unique-fk.sqllogic, docs/runtime.md, tickets/fix/altered-column-not-exists-antijoin-misread.md
----

## What landed

`ADD COLUMN` with a column-level FK now validates the existing (backfilled) rows
against the referenced parent — closing the orphan-admission gap — by calling the
shared `validateForeignKeyOverExistingRows` post-scan inside the same try/revert region
as the literal-default CHECK scan. Runs for both default kinds (literal + per-row
evaluator), MATCH SIMPLE, pragma-gated, parent-absent aware, self-referential safe.

The shared validator's parent-present branch was rewritten from `not exists` to
`LEFT JOIN … WHERE <first parent col> IS NULL` to route around an engine
decorrelation bug that misreads a child column added in the *same* ALTER statement
(would silently admit violations). The bug itself is captured and deferred to fix
ticket `altered-column-not-exists-antijoin-misread`.

## Review findings

### Scope reviewed
Implement diff `236d3180` read first with fresh eyes (emitter `runAddColumn` revert
region, the shared `validateForeignKeyOverExistingRows` LEFT-JOIN rewrite, the three
call sites — ADD COLUMN, memory `manager.addForeignKeyConstraint`, store
`store-module` ADD CONSTRAINT — the `41.4` test section, and `docs/runtime.md`),
*then* the handoff summary. Validated against SPP/DRY/modularity, error/revert paths,
type safety, and test floor (happy/edge/error/regression/interaction).

### Verdict: sound. One minor coverage gap fixed inline; one MAJOR engine bug
correctly deferred to a spawned ticket.

**Correctness of the LEFT-anti-join rewrite — confirmed.** Walked single-column and
composite, parent-present / parent-absent / pragma-off. For an orphan child row the
LEFT JOIN pads every parent column to NULL, so `<first parent col> IS NULL` flags it;
for a matched row `<first parent col>` equals the child's non-NULL value (guarded by
`notNullChain`), so it is never NULL. The result is correct **independent of whether
the referenced parent column is declared nullable** — the implementer's flagged
"relies on parent cols being non-NULL / worth a second look" reduces to LEFT-JOIN
padding semantics and is **not a bug**. The in-code justification is defensible; left
as-is (editing it would add noise without changing behavior).

**Minor (FIXED inline): composite FK over existing rows was untested.** Every
composite-FK test in the suite was CREATE-time (child-side builder), so the validator's
composite `<first parent col> IS NULL` orphan test — the path the implementer noted was
"argued only in comments" — had no coverage on either the ADD COLUMN or ADD CONSTRAINT
route (column-level FK is single-column, so ADD CONSTRAINT is the only way to reach it).
Added section 10 to `41.8-alter-add-constraint-unique-fk.sqllogic`: composite
`add constraint … foreign key (ref_a, ref_b) references p(a, b)` over existing rows —
10a satisfied (incl. a one-column-only partial match still rejected forward), 10b orphan
where the child matches the parent on the first column only (proves the first-parent-col
null test is not fooled by a partial match). Passes on **memory and store**.

**MAJOR (deferred — correct disposition): engine anti-join decorrelation bug.** A
`not exists` referencing a child column added in the same ALTER statement misreads the
column (reports no orphans) and persistently corrupts later anti-joins on that table —
a silent-correctness bug independent of FKs. Worked around here (LEFT JOIN); root-cause
fix is out of scope for this feature ticket and is fully captured in
`tickets/fix/altered-column-not-exists-antijoin-misread.md` (repro, empirics, suspected
decorrelation/hash-anti-join cause, acceptance). Not re-filed.

**Checked, no action needed:**
- *Revert path* — single try/revert region covers a failing CHECK or FK; on throw it
  drops the column and restores the original catalog entry. No `notifyChange` is sent on
  revert, which is correct: the notify only fires post-validation, so a reverted ALTER is
  net-no-change and was never announced. Store revert verified by the `41.4` orphan cases
  (`table_info` count 0 / `select *` unchanged) passing in store mode.
- *Test assertions are meaningful, not vacuous* — harness matches `-- error:` as a
  case-insensitive substring AND fails if no error is thrown (logic.spec.ts:597,602), so
  the `-- error: foreign key` orphan-abort cases genuinely assert the validator throws.
- *Cross-schema column-level FK* — flagged "untested" in the handoff, but
  `ForeignKeyClause.table` carries no schema qualifier (parser/ast.ts), so a column-level
  `REFERENCES` cannot name another schema; the gap is **not expressible**, no test owed.
- *No-op / unreachable branches* — `resolvedForeignKeys` with empty columns only arises
  if the module fails to return the just-added column (defensive, unreachable); reads
  during validation don't trigger forward FK enforcement (mutation-only).

**Not addressed (documented, low value / not introduced here):**
- Combined CHECK + FK both failing on one ADD COLUMN — structurally shares the revert and
  each is independently tested; a combined case is a floor-not-ceiling nicety.
- Cross-schema (non-`main` parent) ADD CONSTRAINT existing-row validation — exercises
  `qualifyRelation`'s prefix, which is **unchanged by this ticket** (orthogonal to the
  LEFT-JOIN swap); pre-existing gap, not a regression.
- Pre-existing `noUnusedParameters` TS-LSP hint on `rebuildViaShadowTable`'s unused
  `schema` param (predates this ticket at `145400dd`; eslint + build clean). Untouched.

### Validation run during review
- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- Full **memory** spec+logic suite (`test-runner.mjs`) → **4853 passing, 0 failing, 9 pending**
- **Store** mode (`QUEREUS_TEST_STORE=true`): `41.4`, `41.8` (incl. new composite case),
  `41-foreign-keys` → passing
- All 18 `File: 41*` logic files → passing (memory)
- Did NOT run the entire store logic suite or `yarn test:full` (slow); the shared
  validator change touches every ADD CONSTRAINT FK path, so a store full-run in CI remains
  advisable (carried over from the implement handoff).

## Follow-up tickets
- `tickets/fix/altered-column-not-exists-antijoin-misread.md` — fix the engine anti-join
  decorrelation bug at source; then deliberately re-decide the validator's query shape
  (revert to `not exists` or keep the now-load-bearing LEFT JOIN).
