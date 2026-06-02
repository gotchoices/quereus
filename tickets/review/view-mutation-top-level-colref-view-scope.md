description: Review the view-column-scope guard for top-level `where` / `set` / `returning` references in view-mediated DML. A top-level reference that is not a column of the view now raises a structured `unknown-view-column` diagnostic instead of silently resolving against the underlying base table (the encapsulation leak). Enforced uniformly across single-source and multi-source (join) paths.
prereq:
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed

Closed the encapsulation leak where a base column the view *projects away* (or a
renamed column's base spelling) leaked through a top-level `where` / `set` /
`returning` reference of view-mediated DML by silently re-binding against the base
table. Such a reference now raises the structured `unknown-view-column` diagnostic.

### Mechanism

- New `MutationDiagnosticReason` member `'unknown-view-column'`
  (`mutation-diagnostic.ts`).
- `single-source.ts`:
  - `forEachTopLevelColumn(expr, visit)` — a top-level-only column walker that
    mirrors `transformExpr`'s structure **minus** the subquery/`exists`/`in`-subquery
    descent (nested references are the separate nested-rebind ticket's domain).
  - `assertTopLevelViewColumns(expr, viewColumnNames, displayColumns, view)` —
    exported, shared guard. A reference must name a view column, optionally
    qualified by the view's own name; anything else → `unknown-view-column`.
  - `raiseUnknownViewColumn(spelling, view, displayColumns)` — exported helper.
  - `findViewColumn` now raises `unknown-view-column` (was a generic `QuereusError`)
    — this guards `set` targets **and** `insert` target-column lists.
  - Wired into `rewriteViewUpdate` (where), `rewriteViewDelete` (where),
    `rewriteViewReturning` (each non-`*` returning expr).
- `multi-source.ts` (parity): `guardTopLevelScope` builds the set from
  `analysis.outColumns` and applies the same guard in `decomposeUpdate` (where),
  `decomposeDelete` (where), and `buildReturningProjection` (update RETURNING). The
  multi-source SET-target diagnostic was split: a genuinely-unknown column →
  `unknown-view-column`; a known-but-computed column → existing `no-inverse`.

### Key correctness properties (verify these)

- **Keyed off the view's output column set**, not base names. For
  `select label as note`, `note` is accepted and base `label` rejected.
- **View-qualified miss** (`sv.secret`) rejects.
- **`no-inverse` not shadowed**: a write to a *computed* view column still yields
  `no-inverse` (the column IS a view column; the guard only fires for non-members).
- **Top-level only**: references nested in a subquery operand are NOT validated
  here — confirmed by the existing (a)–(o) subquery-descent cases in 93.4 still
  passing.

## Use cases / tests

`93.4-view-mutation.sqllogic` new section "Top-level view-column scope":
- the three leak cases (RETURNING / WHERE / SET on projected-away `secret`) error;
- view-qualified `sv.secret` errors;
- positive: where/set/returning + delete-returning on real view columns succeed;
- renamed view column — `note` accepted, base `label` rejected on all three clauses;
- computed view column — `returning <computed>` reads, `set <computed>` → `read-only`
  (no-inverse), not unknown-view-column;
- multi-source parity — unknown top-level column rejected the same way on
  where / delete-where / set-target / update-returning.

Validation run: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" "packages/quereus/test/property.spec.ts"` → 278 passing. `yarn build` clean, `yarn lint` clean.

## Honest gaps / notes for the reviewer

- **No 93.2 case was migrated.** The ticket anticipated a "confirmed RETURNING
  leak" case parked in `93.2-view-mutation-pending.sqllogic`, but none existed —
  the leak was *latent* (silently succeeded, never asserted). The new 93.4
  assertions are net-new coverage; nothing was removed from 93.2.
- **Base-alias-qualified top-level refs are rejected.** A top-level reference
  qualified by anything other than the view name (e.g. a base alias `c.note`) is
  treated as out-of-scope and rejected. This is the intended semantics (the user
  references the view, not its internal aliases) and no existing test relies on the
  old behavior, but it is a behavioral choice worth a second look.
- **Insert target-column list** also now raises `unknown-view-column` (via
  `findViewColumn`) rather than a generic error — slightly broader than the literal
  "where/set/returning" wording, but consistent and desirable.
- **Multi-source DELETE … RETURNING** is *not* guarded by the new code, because its
  re-query (`view-mutation-builder.ts buildMultiSourceReturning`) selects directly
  `from <view>`, so an unknown returning column already fails to resolve naturally
  (generic "column not found", not `unknown-view-column`). If the reviewer wants
  uniform diagnostics there too, it would need a guard in the builder. Left as-is to
  keep the change scoped; flagged for the diagnostic-shape consistency call.
- The guard runs at rewrite time (build), before any base op — consistent with the
  other Phase-1 diagnostics.

## Docs

`docs/view-updateability.md`: added the "Top-level view-column scope (the
encapsulation guard)" blockquote under § Selection (enforced contract, examples,
single/multi-source parity, top-level-only boundary), and added
`'unknown-view-column'` to the § Diagnostics union.
