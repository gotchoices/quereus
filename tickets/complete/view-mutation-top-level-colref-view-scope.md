description: View-column scope guard for top-level `where` / `set` (targets AND values) / `returning` references in view-mediated DML. A top-level reference that is not a column of the view raises a structured `unknown-view-column` diagnostic instead of silently re-binding against the underlying base table (the encapsulation leak). Enforced uniformly across single-source and multi-source (join) paths.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed

Closed the encapsulation leak where a base column the view *projects away* (or a
renamed column's base spelling) leaked through a top-level `where` / `set` /
`returning` reference of view-mediated DML by silently re-binding against the base
table. Such a reference now raises the structured `unknown-view-column` diagnostic.

The original implementation covered top-level `where`, `set` **targets**, and
`returning`. The review pass found that the `set` **value** (RHS) position was
still unguarded — a genuine silent leak (`update sv set shown = secret` read the
hidden base column into a visible one). The value position is now guarded too, on
both spines.

### Mechanism (as implemented)

- New `MutationDiagnosticReason` member `'unknown-view-column'`
  (`mutation-diagnostic.ts`).
- `single-source.ts`:
  - `forEachTopLevelColumn(expr, visit)` — a top-level-only column walker mirroring
    `transformExpr`'s structure **minus** the subquery/`exists`/`in`-subquery descent
    (nested references are the separate nested-rebind ticket's domain).
  - `assertTopLevelViewColumns(expr, viewColumnNames, displayColumns, view)` —
    exported, shared guard. A reference must name a view column, optionally qualified
    by the view's own name; anything else → `unknown-view-column`.
  - `raiseUnknownViewColumn(spelling, view, displayColumns)` — exported helper.
  - `findViewColumn` raises `unknown-view-column` (guards `set` targets **and**
    `insert` target-column lists).
  - Wired into `rewriteViewUpdate` (where + **each assigned value**),
    `rewriteViewDelete` (where), `rewriteViewReturning` (each non-`*` returning expr).
- `multi-source.ts` (parity): `guardTopLevelScope` builds the set from
  `analysis.outColumns` and applies the same guard in `decomposeUpdate`
  (where + **each assigned value**), `decomposeDelete` (where), and
  `buildReturningProjection` (update RETURNING). The SET-target diagnostic was split:
  a genuinely-unknown column → `unknown-view-column`; a known-but-computed column →
  existing `no-inverse`.

### Correctness properties (verified)

- Keyed off the view's output column set, not base names. For `select label as note`,
  `note` is accepted and base `label` rejected on where / set-target / set-value /
  returning.
- View-qualified miss (`sv.secret`) rejects.
- `no-inverse` not shadowed: a write to a *computed* view column still yields
  `no-inverse` (the column IS a view column; the guard fires only for non-members).
- Top-level only: references nested in a subquery operand are NOT validated here
  (confirmed by the existing (a)–(o) subquery-descent cases still passing).
- SET values referencing real view columns (incl. inside a function, e.g.
  `set shown = upper(shown)`) pass the guard and evaluate normally — no false
  positive.

## Tests

`93.4-view-mutation.sqllogic` "Top-level view-column scope" section, including the
review-added cases:
- the three leak cases (RETURNING / WHERE / SET-target on projected-away `secret`);
- **SET-value leak** (`set shown = secret`, `set shown = upper(secret)`) → error;
- **positive SET-value** (`set shown = upper(shown)` → `LO`) succeeds;
- **INSERT target-column leak** (`insert into sv (id, secret) …`) → error;
- view-qualified `sv.secret` rejects;
- renamed view column — `note` accepted, base `label` rejected on where / set-target /
  **set-value** / returning;
- computed view column — `returning <computed>` reads; `set <computed>` → `no-inverse`;
- multi-source parity — unknown top-level column rejected on where / delete-where /
  set-target / **set-value** / update-returning.

Validation: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/logic.spec.ts" "packages/quereus/test/property.spec.ts"` →
278 passing. `yarn build` clean, `yarn lint` clean.

## Review findings

**Scope of review:** read the full implement diff (356ae15b) before the handoff
summary; verified the top-level walker against the actual AST `Expression` union and
`transformExpr`; empirically probed leak surfaces via a scratch harness against the
built engine; checked all mutation entry points (`rewriteViewUpdate` /
`rewriteViewDelete` / `rewriteViewReturning` / `rewriteViewInsert`,
`decomposeUpdate` / `decomposeDelete` / `buildReturningProjection`); ran build, lint,
logic + property suites.

**Aspect angles checked:** correctness (leak surfaces), encapsulation/SPP, DRY (the
shared `assertTopLevelViewColumns`), type safety, error handling / diagnostic shape,
single↔multi-source parity, docs accuracy.

- **MAJOR (fixed inline) — SET-value (RHS) leak.** The implementer guarded `set`
  *targets* but not assigned *values*. `update sv set shown = secret where id = 1`
  silently read the projected-away base column `secret` and wrote it into the visible
  `shown` — a true encapsulation breach (reading a hidden column), squarely within
  the ticket's stated `set` scope. The renamed-column variant (`set note = label`)
  leaked the same way under the hidden base spelling. **Fixed** by guarding each
  `asg.value`'s top-level references in both `rewriteViewUpdate` (single-source) and
  `decomposeUpdate` (multi-source), reusing the existing `guardTopLevelScope`. Added
  positive + negative tests and updated `docs/view-updateability.md`. Kept inline
  (not a new ticket) because it is in-scope and the fix is a two-line reuse of
  existing infra.
  - Note: the multi-source SET-value case did *not* silently leak before the fix (the
    per-side base UPDATE targets a single table, so a cross-table hidden column failed
    to resolve with a generic "column not found"). The guard there is a
    diagnostic-shape unification + defense for the single-table-side case.

- **Walker fidelity — OK.** `forEachTopLevelColumn` exactly mirrors `transformExpr`'s
  recursion for every `Expression` variant that carries a scalar operand (column,
  binary, unary, cast, collate, function, between, case, in-values), and intentionally
  skips `subquery` / `exists` / `in`-subquery (the documented top-level boundary).
  `windowFunction` / `functionSource` fall to the default no-descent case — consistent
  with `transformExpr` (which also does not descend there), so no asymmetry between
  guard and rewrite. Pre-existing limitation, not introduced here.

- **Case sensitivity — OK but implicit.** Single-source lowercases the view-column set
  explicitly; multi-source passes `outColumns[].name` un-lowercased, relying on the
  invariant that `outColumns[].name` is already lowercase (the same invariant the
  existing `c.name === asg.column.toLowerCase()` assignment match depends on). Correct,
  but the asymmetry is worth a glance if `outColumns` construction ever changes.

- **Schema-qualifier leniency (minor, accepted).** The guard checks only `col.table`
  against the view name, ignoring `col.schema`. A schema-mismatched but
  table-name-matching reference (`other.sv.col`) would pass the guard; it would not
  resolve to a wrong-schema base anyway, so this is not a leak. Left as-is.

- **Multi-source `DELETE … RETURNING` (minor, accepted — flagged by implementer).** Its
  builder re-query selects `from <view>`, so an unknown returning column already fails
  with a generic "column not found" rather than the structured `unknown-view-column`.
  Confirmed (no leak — the re-query never exposes base-only columns). Uniform
  diagnostics there would require a guard in the builder; left out to keep the change
  scoped. Non-blocking diagnostic-shape inconsistency only.

- **Docs — updated.** `docs/view-updateability.md` § Selection blockquote and the
  `set`-value example now reflect that the guard covers `set` targets *and* values;
  the `'unknown-view-column'` diagnostic remains in the § Diagnostics union.

**Empty categories:** No new fix/plan/backlog tickets were filed — the one major
finding was in-scope and small enough to fix inline; the remaining observations are
accepted non-leak trade-offs documented above. No security concern remains (the
read-side leak is closed on both spines). No performance or resource-cleanup issues:
the guard is an O(expr-size) AST walk at build time, before any base op.
