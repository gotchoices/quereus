description: column_info('mv') reports a maintained table's columns through derivation-body lineage (per-column updateability), not as plain base columns — COMPLETE
files:
  - packages/quereus/src/func/builtins/schema.ts            # deriveColumnInfo maintained-table branch + shared deriveBodyColumnRows
  - packages/quereus/src/schema/derivation.ts               # isMaintainedTable guard / TableDerivation.selectAst
  - packages/quereus/test/logic/06.3.5-column-info.sqllogic # MV lineage + dynamic-agreement coverage
  - docs/materialized-views.md                              # write-boundary column_info cross-ref
  - docs/view-updateability.md                              # column_info maintained-table surface
----

# column_info on a maintained table: lineage fidelity — COMPLETE

`column_info('mv')` now derives a maintained table's per-column updateability
from the **derivation body** through the same `updateLineage` / `baseSiteOf`
classification a plain view gets, rather than reporting every registered column
as a writable base column. Implemented in commit `c04e512e` (swept in alongside
ticket `maintained-table-attach-detach-verbs`; the implement diff for this
ticket is the `schema.ts` / `06.3.5-column-info.sqllogic` / docs hunks of that
commit, not a dedicated commit).

## Review findings

**Implementation reviewed** — `deriveColumnInfo` (src/func/builtins/schema.ts):
the maintained-table branch is gated structurally on `isMaintainedTable(table)`
(a `table.derivation !== undefined` type guard in schema/derivation.ts — no name
patterns, as required) and routes through a newly-extracted shared
`deriveBodyColumnRows` helper. That helper is the *same* set-op / join / base
lineage walk the plain-view branch previously inlined — genuinely de-duplicated,
not copy-pasted: the old view branch now calls the same helper. Type safety is
clean (the guard narrows to `MaintainedTableSchema`, so `table.derivation.selectAst`
is well-typed; passes `selectAst: AST.QueryExpr` into the helper). The conservative
all-`NO` fallback on plan failure is correct and logged, never throwing the TVF.

**Consistency story** — `view_info` still excludes maintained tables (they list
as tables in `schema()`); the deliberate split is documented in both the source
header comments and docs/materialized-views.md / docs/view-updateability.md, and
verified by the `view_info('mt_mv') → count 0` assertion. No prior test asserted
the old not-found behavior, so no regression surface.

**Docs** — checked materialized-views.md (write-boundary § now cross-references
`column_info` with the passthrough/invertible/non-invertible breakdown) and
view-updateability.md (column_info section extended to maintained tables, the
stale "throws not-found for MVs" claim replaced). Both read accurately against
the new code.

**Tests** — the implementer's `06.3.5-column-info.sqllogic` block covers the
happy path (passthrough `id`, rename `label = name`, invertible expression
`vp = v+1` → YES tracing to base `v`, non-invertible `dbl = v*2` → NO/null),
object-identity columns, dynamic write-through agreement (renamed-column write,
inverse-value store `vp=9 ⇒ v=8`, and the non-invertible write *rejected* at
runtime), and the `view_info` exclusion. Lint clean, full suite 5910 passing.

  - **Coverage gap fixed inline (minor):** the implementer's MV used only
    `as`-aliased body columns, so the body attribute names already equalled the
    registered names — the maintained-table-specific *positional `columnNames`
    override* (registered names winning over body attr names) was never actually
    exercised distinctly. Added a case using the MV-rename sugar
    `create materialized view mt2_mv (pk, dv) as select id, v from mt2`, asserting
    `column_name` reports the registered names (`pk`, `dv`) while the lineage
    trace still resolves to the source base columns (`id`, `v`). Passes.

**Findings dispositioned as out-of-scope (no new ticket — noted for the record):**

  - **Insert semantics.** The ticket's prose mentions equality-pinned columns
    having "constrained insert semantics." `column_info`'s surface only carries
    `is_updatable` (update-through) — there is no insertability column. This is
    not a regression and modelling per-column insertability would be a new
    surface, not a fix to this one. No action.
  - **Conservative-fallback path untested.** Triggering it requires a derivation
    body that fails to plan (stale/dropped source) — not deterministically
    constructable in sqllogic without racing the staleness subscription. The
    path is defensive (mirrors the view branch's never-throw posture) and
    type-checked; left untested deliberately rather than with a brittle test.
  - **Exotic set-op-membership maintained body.** A materialized view built on a
    set-op-membership body would classify `innerFlags` off body attribute names
    while emitting registered output names; for any real MV the column counts and
    names align, so no misreport is reachable. Not worth a ticket.
