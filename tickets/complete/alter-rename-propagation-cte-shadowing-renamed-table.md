---
description: ALTER TABLE RENAME COLUMN no longer rewrites outer refs when a CTE shadows the renamed table by name
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## Summary

Closes the shadowing gap that fell out of the review of
`alter-rename-propagation-cte-in-view`. When a view body declares a
CTE whose name matches the renamed table, an outer `from <name>`
unambiguously refers to the CTE — yet the column renamer previously
treated the FROM as the renamed table and rewrote unqualified column
refs in the outer SELECT.

## Change

`packages/quereus/src/schema/rename-rewriter.ts`:

- `ScopeFrame` gains a `ctesInScope: Set<string>` alongside the
  existing `ctesExposingRenamed`. `ctesInScope` is the superset —
  every CTE declared in this WITH, regardless of whether it re-exposes
  the renamed column.
- `pushWithFrame` and `analyzeWithFrame` both populate
  `ctesInScope` in declaration order (so later CTEs in the same WITH
  see earlier siblings, the outer SELECT sees all of them, and a
  non-recursive CTE body does not see itself).
- New helper `isCteInScope` mirrors `isCteExposingInScope`.
- `collectFromBindings` `case 'table'` now branches on
  `isCteInScope` *before* the standard renamed-table binding.
  Sub-cases:
  - shadowed + exposing → bind as the renamed table (preserves 6 / 6a–6f).
  - shadowed + not exposing → skip the binding entirely; unqualified
    and qualified refs in this scope do not rewrite.
  - not shadowed → fall through to the original renamed-table logic.

Regression tests added to
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`:

- 6g (unaliased non-exposing shadow — original repro)
- 6h (aliased non-exposing shadow — qualified ref through the alias
  must not rewrite)
- 6i (sibling-CTE shadowing — second CTE shadows the renamed table,
  body sees the first sibling)

## Review findings

### Scope checked

- **Diff vs intent (`git show ac163d1`):** code matches the ticket
  spec exactly. `ScopeFrame` extension, `isCteInScope` mirror,
  `collectFromBindings` branch restructuring, and both `pushWithFrame`
  / `analyzeWithFrame` populating `ctesInScope` after their respective
  body visits.
- **SPP / DRY / modular:** `isCteInScope` is a literal mirror of
  `isCteExposingInScope` — minor duplication that's idiomatic for this
  file (the file uses similar mirrored helpers elsewhere). Acceptable.
- **Type safety / resource cleanup:** no new error paths, no resources
  to clean. Renamer mutates AST in place; no allocations beyond the
  new `Set`.
- **Scope nesting / ordering invariants:**
  - In `pushWithFrame`, the body visit precedes `ctesInScope.add`, so
    a non-recursive CTE body cannot see itself (correct SQL).
  - In `analyzeWithFrame`, `ctesInScope.add` is in the same per-CTE
    loop as the exposure check — sibling visibility is preserved.
  - The shadow check `ts.table.schema === undefined && isCteInScope(...)`
    correctly rejects schema-qualified refs (CTEs cannot carry a
    schema). With `defaultSchema = 'main'`, `from main.t_shadow` has
    schema `'main'` (not undefined) and bypasses the shadow branch,
    falling to the renamed-table binding — correct, since the
    user explicitly disambiguated to the real table.
  - The aliased-shadow case (`from t_shadow as a`) leaves both
    `unaliased` and `aliasMap` un-touched when not exposing, so neither
    unqualified nor `a.k`-qualified refs in the outer scope resolve to
    the renamed table. New test 6h confirms.
- **Sibling visibility:** sibling shadow (`with a as (...), t_shadow
  as (select k from a) select k from t_shadow`) works — new test 6i
  confirms. The exposure analyzer correctly sees that the second
  sibling's body, having had its `k` left as `k` (not rewritten to
  `kk`), does not match `state.newCol` and therefore does not expose,
  so the outer FROM doesn't bind.
- **UPDATE / DELETE with WITH:** both call `pushWithFrame` then push a
  target-table frame; a shadowing CTE inside the WITH does not
  interfere with target-table assignment rewriting (assignments are
  matched against `stmt.table.name`, not via scope). Pathological case
  (WITH-CTE shadowing the UPDATE target by name) is legal and
  harmless.
- **Lint:** `yarn workspace @quereus/quereus run lint` — exit 0,
  silent.
- **Build:** `yarn workspace @quereus/quereus run build` — exit 0.
- **Tests:** `yarn workspace @quereus/quereus run test` — 3157
  passing, ~42s, including the new 6h/6i sections. No regressions in
  41.3 sections 1–11.
- **Docs:** the renamer is internal-only; no `docs/` page references
  it directly. `docs/sql.md` and `docs/schema.md` mention RENAME but
  not at the level of CTE shadowing. No doc update needed.
- **Store mode:** `yarn test:store` not run per AGENTS.md guidance —
  no store-specific code touched; the renamer operates on the AST
  before the storage layer.

### Findings

- **Minor — handled inline:** the original ticket landed only one
  regression test (6g). Added 6h (aliased shadow) and 6i (sibling
  shadow) inline; both pass and exercise the
  `isCteInScope` + `isCteExposingInScope` interaction directly.
- **Major — filed as follow-up:** `fix/alter-rename-recursive-cte-self-ref-shadowing`.
  In `pushWithFrame`, each CTE body is visited *before* its name is
  added to `frame.ctesInScope`. That is correct for non-recursive
  CTEs but wrong for `with recursive` — a recursive CTE's body MUST
  see itself. When the renamed table happens to share the CTE's name
  and the CTE omits an explicit column list, the recursive step's
  self-reference is mis-bound as the real table and its column refs
  are rewritten incorrectly. Pre-existing (worse before this fix) and
  narrow (most recursive CTEs carry an explicit column list, which
  short-circuits exposure). Filed at low priority.
- **Out of scope (acknowledged by implementer):** the pre-existing
  subquery-without-CTE gap (`select k from (select k from t) s`)
  remains untouched.
- **Performance:** no concern. The new `ctesInScope` is a `Set<string>`
  with O(CTEs-in-scope) lookups, same shape as the existing
  `ctesExposingRenamed`. Both are linear-in-scope-depth and bounded by
  the AST size.
- **Resource cleanup:** none required. No additional cleanup paths
  needed.
- **Error handling:** no new error paths — the renamer continues to
  mutate the AST in place and return a `changed` flag.

## End
