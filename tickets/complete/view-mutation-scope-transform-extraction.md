description: Phase A of the derived-backward-walk debt — the triplicated scope-aware column-substitution primitive (single-source.ts / multi-source.ts / lens-enforcement.ts) is now ONE shared module, `planner/mutation/scope-transform.ts`, exposing a `ScopeContext`-driven scope-aware descent. Pure refactor, zero behavior change. Review found the generalization faithful to the two retired hand-walks line-by-line; one minor type-safety fix applied inline (discriminated-union `ScopeContext` so the `'reject'` policy compiler-requires its handler, dropping a non-null assertion). Phase B remains decomposed into three prereq-chained implement tickets (see below).
files: packages/quereus/src/planner/mutation/scope-transform.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, docs/view-updateability.md

## What landed (Phase A — the DRY extraction)

The "rewrite column references X→Y in an expression / query, scope-aware (shadowing,
taint, deep subquery descent)" primitive that existed in three near-parallel copies is
now **one** module: `planner/mutation/scope-transform.ts`. It owns the structural
expression walker (`transformExpr` / `cloneExpr` / `cloneQueryExpr` /
`mapQueryExprUniform` / private `rebuildSelect` / `rebuildFrom`), the FROM-source
column-name resolution (`collectFromColumnNames` + helpers), and the scope-aware descent
(`transformScopedExpr` / `transformScopedQuery`) parameterized by a `ScopeContext` value
object. `single-source.ts` builds the two `ScopeContext`s (`makeViewScope` +
`makeBaseQualifyScope`) that replace the hand-written `transformQueryExpr` and
`qualifyCorrelatedBaseRefs(Query)`; `makeViewColumnDescend` / `makeBaseQualifier` survive
as thin wrappers with unchanged signatures. `multi-source.ts`, `decomposition.ts`, and
`lens-enforcement.ts` now import the structural walkers from `scope-transform.js`.

The implementation was carried in commit `7f0bffc7` (the implement commit for
`view-mutation-derived-backward-walk`, which also authored this ticket and the three
Phase B tickets); there is no separate `ticket(implement): scope-transform-extraction`
commit.

## Review findings

**Disposition: APPROVED. One minor type-safety fix applied inline; no major findings; no new tickets filed.**

### What was checked

- **Faithfulness of the generalization (the load-bearing invariant)** — diffed the new
  `transformScopedQuery` / `transformScopedExpr` against the two retired hand-walks
  (`transformQueryExpr`, `qualifyCorrelatedBaseRefs` / `qualifyCorrelatedBaseRefsQuery`)
  in the `7f0bffc7` diff, branch by branch:
  - **view scope (`unresolvableScope: 'taint'`)**: original `scopeTainted = tainted ||
    unresolvable`, `innerShadow = unresolvable ? shadowed : shadowed ∪ local`. The
    generalized descent reproduces this exactly — `local === null` → `innerShadow =
    shadowed`, `scopeTainted = true`; else → `innerShadow = shadowed ∪ local`,
    `scopeTainted = tainted`. ✓ identical for both `tainted` inputs.
  - **base-qualify scope (`unresolvableScope: 'reject'`)**: original rejected on `local
    === null`; generalized descent rejects via `rejectUnresolvableScope()`. The
    substitute still ignores `tainted` and gates on `baseCols.has(name) &&
    !shadowed.has(name)`. ✓
  - **`values` branch**: both view and base-qualify originals used the *incoming*
    `shadowed`/`tainted` for the substitute (not the inner) — preserved. ✓
  - **`onNested` (inherits inner) vs `onLeg` (keeps incoming) split**, entry at
    ∅-shadow/false-taint, and the `view.toLowerCase()` qualifier comparison — all
    preserved. ✓
  - **Every diagnostic message preserved verbatim** — the three
    `unsupported-subquery-correlation` strings (tainted view-col ref, unresolvable
    lineage subquery, embedded DML subquery, ×2 view/base variants) match the originals
    character-for-character in the `ScopeContext` reject callbacks. ✓
  - **No double-clone / aliasing change**: a substituted (and `baseQualify`-d)
    replacement is still re-cloned by `transformExpr`'s `column` case exactly as before;
    `NO_SHADOW` is a read-only module singleton never mutated (new sets are spread). ✓

- **Dead-symbol / import hygiene** — grep across `src/` and `test/`: `transformQueryExpr`,
  `makeViewSubstitute`, `qualifyCorrelatedBaseRefs(Query)` return **nothing**; no module
  still imports the moved walkers from `single-source.js` (only `combineAnd` /
  `makeViewColumnDescend` / `assertTopLevelViewColumns` / `raiseUnknownViewColumn` /
  `MutableViewLike` remain sourced there, correctly). No external (non-mutation) importer
  of the now-unexported `transformExpr` exists, so nothing broke. ✓

- **Edge-case test coverage** — the ticket worried the scope-aware taint/shadow paths
  were "only indirectly" exercised. In fact `test/logic/93.4-view-mutation.sqllogic`
  **directly** covers them: view-col ref inside `exists`/`in` subquery (blocks a/b/s),
  shadowed same-named local source (`note in (select note from sq_sh_src)`, block c),
  `select *` source taint→reject (block f, line 770), TVF source taint→reject (line 774),
  deep base-qualify lineage with `(select * from cn_oth)` unresolvable→reject (lines
  914–917), and the self-reference / same-base-table corner (`so_v`, line 942). The
  multi-source descent and the round-trip laws are covered by the `93.x` family and
  `property.spec.ts` § View Round-Trip Laws. Coverage is genuinely strong — no new tests
  warranted for this pure refactor.

- **Docs** — `docs/view-updateability.md` § Selection and § Implementation Surface were
  updated by the implementer to name `scope-transform.ts` / `transformScopedQuery` /
  `makeViewColumnDescend` / `makeBaseQualifyScope` in place of the retired helpers; read
  through and confirmed they reflect the new module structure. The "Forward note" /
  "Surface authority" statements remain accurate (Phase A changed no consumption
  behavior). ✓

### Minor finding — fixed inline

- **`ScopeContext` coupled its `'reject'` policy to its handler only by convention**,
  forcing `scope.rejectUnresolvableScope!()` (a non-null assertion — the "type lazy"
  pattern AGENTS.md discourages). Converted the interface to a **discriminated union**
  on `unresolvableScope` (`ScopeContextBase & ({ unresolvableScope: 'taint';
  rejectUnresolvableScope?: undefined } | { unresolvableScope: 'reject';
  rejectUnresolvableScope(): never })`) so the `'reject'` policy compiler-requires its
  handler and the descent narrows it without the `!`. Type-only change; emitted JS
  identical. `single-source.ts` / `scope-transform.ts` (`packages/quereus`).

### Empty categories (explicit)

- **Major findings: none.** The generalization is byte-faithful and the surrounding
  consumers are pure relocations; nothing rises to a separate fix/plan/backlog ticket.
- **No regressions introduced.** The pure-refactor invariant holds under the unchanged
  suite.

### Validation (post-fix)

- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus test` — **4330 passing, 9 pending, 0 failing** (count
  rose from the ticket's stated 4273 via intervening tickets on this branch), including
  `property.spec.ts` § View Round-Trip Laws, the `93.x-view-mutation*.sqllogic` suites,
  and `lens-enforcement.spec`.

## Phase B handoff (deferred — three prereq-chained implement tickets, in `tickets/implement/`)

Phase A deliberately stands alone and de-risks Phase B by giving it one substitution
primitive to thread. Phase B — consume the threaded `UpdateSite` off the planned operator
tree directly, retire the plan→AST→re-plan round-trip, unlock inverse-profile column
writes, converge the decomposition fan-out — was too large/risky for one pass and is
decomposed into:

1. `view-mutation-multisource-threaded-updatesite` — consume the full `UpdateSite` (incl.
   `inverse` / `domain`) in `analyzeJoinView`; route + invert assignments to an
   `inverse`-profile column through a join body; add Family-B law coverage.
2. `view-mutation-retire-ast-roundtrip` (prereq: #1) — build the per-side base writes +
   identifying predicate from the already-planned body node, retiring the
   lower-to-AST-and-re-plan double-plan for multi-source update/delete.
3. `view-mutation-decomposition-plan-node-consumer` (prereq: #2) — converge the
   `decomposition.ts` fan-out onto the same plan-node consumer.

The `docs/view-updateability.md` § Implementation Surface "Forward note" / "Surface
authority" callout updates belong with #2 (when the substrate actually consumes the
plan-node walk), not Phase A.
