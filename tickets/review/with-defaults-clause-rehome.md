----
description: Review the re-home of the view `insert defaults (…)` clause onto the core select as a trailing `with defaults (…)` clause (atomic source move + test/doc migration). Build + lint + the whole packages/quereus suite are green.
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/derivation.ts, packages/quereus/src/schema/rename-rewriter.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/ddl-generator.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/func/builtins/schema.ts, docs/sql.md, docs/schema.md, docs/view-updateability.md, docs/materialized-views.md, docs/architecture.md, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/emit-roundtrip-property.spec.ts, packages/quereus/test/logic/*.sqllogic
difficulty: hard
----

## What landed

The view/MV `insert defaults (col = expr, …)` DDL clause was moved onto the **core select AST** as a
trailing `with defaults (col = expr, …)` clause (`SelectStmt.defaults`). The old `insert defaults`
spelling and `parseInsertDefaultsClause` are **removed outright** (no back-compat). This is a *move*,
not a behavior change: write-time target resolution, position in the insert-defaulting chain, and MV
maintenance transparency all carry over. Defaults now ride inside the stored body AST, so `bodyHash` /
`viewDefinitionToCanonicalString` cover them via the body string with no separately-itemized part, and
the rename-propagation body walk descends `select.defaults` for free.

This was a **resumed** run. A prior agent completed the bulk of the move (Phases 1–3 + most of
Phase 4): `yarn build` + `yarn lint` green, **5450 passing, 1 failing**. This run diagnosed and fixed
the single remaining failure, re-validated, and corrected stale "no resolver needed" claims left in a
code comment and in `docs/schema.md`.

## The fix made this run (the one thing reviewers should scrutinize first)

**Symptom:** `schema-differ.spec.ts` — *"an in-diff rename whose NEW name collides with a
clause-subquery FROM table's column reconciles scope-aware (declared-side resolver)"* failed: a
`with defaults` expr `extra = cap + (select max(cap) from lim)` under a `t.qty→cap` rename had its
**inner** `max(cap)` (bound to `lim.cap`, an unrelated like-named column) **false-captured** by the
inverse rename walk, churning a spurious view recreate.

**Root cause:** once defaults live inside the body select, the differ rewrites them via the whole-body
`renameColumnInAst` walk. The inner-subquery disambiguation in `isTableInUnaliasedScope` only consults
an inner FROM's column sets **when `state.resolveColumnInSource` is set** — and `renameColumnInAst`
never accepted/threaded that resolver (unlike `renameColumnInCheckExpression`). The prior agent's
comments asserted "the subquery's pushed frame disambiguates — no declared resolver needed"; that was
wrong.

**Fix (kept forward ⇄ inverse in parity):**
- `renameColumnInAst` (rename-rewriter.ts) gained an **optional** `resolveColumnInSource` param, set on
  the walk state. Existing cross-table CHECK/index call sites pass nothing and are unchanged.
- **Inverse / differ path** (schema-differ.ts): threaded the existing declared-side `resolveDeclaredColumn`
  through `inverseRenamedViewParts` → `reconciledDeclaredViewDefinition` / `columnReconciledViewStmt` /
  `maintainedBodyMatches` / `applyMaintainedTransition` and into the body `renameColumnInAst` call.
- **Forward path**: passed the live `resolveColumnInSource` into the view-body walk
  (alter-table.ts:1610) and the MV-twin walk (materialized-view-helpers.ts; signature of
  `propagateColumnRenameToMaterializedViews` extended + its one caller updated).
- Corrected the stale "no resolver needed" claims in the `inverseRenamedViewParts` doc comment and in
  `docs/schema.md`.

## Validation performed

- `yarn build` → exit 0.
- `yarn lint` (packages/quereus; eslint + `tsc -p tsconfig.test.json`) → exit 0.
- `yarn test` → **`packages/quereus`: 6183 passing, 9 pending, 0 failing** (was 5450/1-failing pre-fix).
  The previously-failing schema-differ test and all 35 in that file pass.
- Confirmed **zero** `insert defaults`/`INSERT DEFAULTS` *SQL* remains repo-wide (all hits are the prose
  concept term "omitted-insert defaults", historical comment mentions, or the explicit "old spelling is
  gone" migration notes). `insertDefaults`/`parseInsertDefaultsClause`/`insertDefaultsClauseToString`
  identifiers are gone from `src`.

## Use cases / behaviors to verify (reviewer floor — treat the tests as a starting point)

- **Clause adjacency:** one `create view` carrying a result-column `with inverse` + body `with defaults`
  + DDL `with tags` — parses and round-trips `parse(stringify(ast)) ≡ ast` (the two trailing `with`
  clauses disambiguate on the post-`WITH` keyword: `defaults` consumed by the select spine, `tags`
  rewound and consumed by the DDL parser). Covered in emit-roundtrip-property; reviewer should stress
  ordering / nesting variants.
- **Compound body:** `… union … with defaults (…)` binds to the whole compound (parsed only in
  `!isCompoundSubquery` position); a mid-compound `with defaults` must surface a clean downstream error,
  not bind to a leg. Round-trip a compound-body view byte-stable.
- **Rename through a defaults-expr subquery (the fixed bug):** verify BOTH directions leave an inner
  like-named ref alone — forward `ALTER TABLE … RENAME COLUMN` propagation AND the declarative differ
  reconcile — and that neither churns a recreate. Extend to: rename on a non-FROM table reachable only
  through the subquery; combined table+column rename; MV twin.
- **MV surfaces:** a defaults-only edit flips `bodyHash` → rebuild; `materialized_view_modified` fires on
  a rename-driven clause rewrite; canonical-DDL fixed point (create → persist → reopen → re-persist)
  byte-identical under the new spelling.
- **`view_info`/`column_info`:** insert-coverage now reads defaults off the body AST, preserving the
  never-throw skip for an entry naming a nonexistent column (06.3.4-view-info.sqllogic).
- **Inert-where-unconsumed:** VALUES body + `with defaults` parses, is inert (view non-updateable), no
  crash; bare top-level `select … with defaults (…)` parses, runs, clause ignored.
- **Duplicate-target** rejected at parse; **conflicting-assignment** at the supplied/default seam still
  fires (93.4 / 93.5 sqllogic).
- **Store-catalog spelling:** a catalog persisting the old `insert defaults` DDL will **not re-parse** —
  accepted under transient-schema / no-back-compat (documented in docs/schema.md).

## Known gaps & honesty notes (do NOT treat as oversights)

- **CTE / subquery-in-FROM write-target defaults coverage is intentionally NOT here.** Per the original
  ticket's handoff note, that new-capability coverage is split into the prereq-chained
  `with-defaults-cte-subquery-targets` ticket. This ticket proves only the *move* (existing DDL sites
  keep working under the new spelling).
- **`resolveColumnInSource` is threaded ONLY at the view-body call sites.** The cross-table CHECK
  (alter-table.ts:1654) and index-predicate (1685) `renameColumnInAst` calls deliberately keep **no**
  resolver — they are the documented "non-owning / cross-table" branch whose forward⇄inverse parity
  requires no seed/resolver. Reviewer: confirm that asymmetry is intended (it is — the differ's
  cross-table inverse loop mirrors it). The optional param makes this a no-op for those calls.
- **Pre-existing failure flagged (not mine):** `yarn test` now reaches `packages/quereus-store` (it
  previously bailed at the quereus schema-differ failure) and surfaces **6 failing store tests**
  (`mv-rehydrate-adopt.spec.ts`, `mv-store-backing.spec.ts`) asserting `derivation.stale === true` after
  an `ADD COLUMN`. The actual is now `false`: the already-committed `mv-restore-unaffected-structural-alters`
  ticket (commits `d39c7a9e`/`177c285d`) changed structural-alter staleness to *restore* the MV and
  updated the **memory** tests but **no `packages/quereus-store` test**. My diff is entirely in
  `packages/quereus`; `git status packages/quereus-store/` is empty. Full write-up in
  `tickets/.pre-existing-error.md` for the runner's triage pass. The expected resolution is a
  store-parity test update (or confirm/fix a genuine store-side restore divergence), not anything in
  this ticket.
- **Non-fatal LSP note:** alter-table.ts:1389 (`rebuildViaShadowTable` unused `schema` param) is a
  pre-existing IDE-only diagnostic — `yarn build` and `yarn lint` both pass, and it is outside this
  diff.
- `yarn test:store` (store re-run of quereus logic tests) was **not** run — out of scope and the store
  workspace already has the documented pre-existing failures.
