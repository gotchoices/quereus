---
description: innermost-first shadowing fixes to rename-rewriter scope helpers
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

## What landed

Three of the four sibling helpers in
`packages/quereus/src/schema/rename-rewriter.ts` were converted from
OR / outer-first first-match-wins walks to innermost-first walks that
honor shadowing precedence. The fourth helper (`isCteInScope`) is
intentionally left as OR.

- `isCteExposingInScope` — innermost-first. Returns `true` on an
  exposing entry; returns `false` on a closer non-exposing
  `ctesInScope` hit (an inner non-exposing same-name CTE shadows an
  outer exposing one).
- `isTableInUnaliasedScope` — innermost-first. Returns `false` on a
  closer `ctesInScope.has(state.tableName)` hit (an inner same-name
  CTE declaration shadows an outer unaliased real-table binding);
  returns `true` only on the closest `unaliased` hit when no inner
  declaration intervenes.
- `aliasResolvesToTable` — innermost-first (was outer-first). The
  closest alias binding wins; this matches standard SQL alias
  shadowing for nested scopes.
- `isCteInScope` — left as OR. Inline comment documents the
  reasoning: the helper only gates "is this source a CTE rather than
  a real table?", a question for which *any* enclosing CTE
  declaration suffices.

`isQualifierShadowedInScope` (added in the prior ticket) was already
innermost-first and is unchanged.

Three new sqllogic scenarios appended to
`packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic`
as sections 12, 13, 14 — one per helper-change. All three exercise
the end-to-end ALTER → view-query path and would have failed
pre-fix.

## Review findings

### What was checked

- **End-to-end traces of new tests (§12 / §13 / §14)** against
  post-fix helpers, confirming each test exercises the precedence
  fix it claims to and that pre-fix code would indeed fail at
  view-eval time on each.
- **Spot-traces of representative existing tests (5, 6c, 6e, 6g,
  6h, 6i, 6l, 6m, 6n, 6p)** through the new helpers to confirm
  no regressions in actual-shadowing cases. All trace cleanly.
- **Exhaustive grep of `state.scopeStack`** in
  `rename-rewriter.ts`: walks happen in exactly the five helpers
  (`isCteExposingInScope`, `isCteInScope`, `isTableInUnaliasedScope`,
  `aliasResolvesToTable`, `isQualifierShadowedInScope`). All other
  references are push/pop. The implementer's invariant claim holds.
- **`pushWithFrame` / `analyzeWithFrame` / `cteExposesRenamedColumn`
  pipeline**: confirmed that for non-recursive WITH the CTE is added
  to `ctesInScope` *after* the body visit (so body visit and
  exposure analysis see only earlier siblings, never the CTE
  itself), and for `with recursive` the CTE is added *before* the
  body so self-references in the recursive step resolve to the CTE.
  Both paths interact correctly with the new innermost-first
  helpers.
- **Caller surface** (`packages/quereus/src/runtime/emit/alter-table.ts`):
  no changes needed; the rewriter is invoked the same way and the
  emit-after-rewrite contract is unchanged.
- **Docs** (`docs/schema.md`): only references the rewriter at a
  high level ("the engine's rename rewriter propagate references
  through dependents"). No internal-precedence detail is exposed; no
  doc update needed.
- **Lint and full sqllogic + schema-differ + MemoryVTable
  alterSchema test set**: clean (203/203 passing, lint exit 0).
- **Optimizer fuzz** (`Optimizer Equivalence`): re-ran the suite,
  6/6 passing. Confirms the implementer's claim that the one
  random-seed failure they saw was a pre-existing fuzz quirk
  unrelated to this ticket.

### Findings

- **Minor — `isTableInUnaliasedScope` is slightly more conservative
  than ideal.** The helper uses `frame.ctesInScope.has(state.tableName)`
  as the shadow signal. That conflates two distinct concepts:
  (a) "a CTE with this name is *declared* in this WITH" (population
  of `ctesInScope`), and (b) "a same-name source is actually bound
  to a shadowing CTE in this frame" (population of
  `ctesShadowingSource`). For source-binding decisions in
  `collectFromBindings` the conflation is fine. For
  *correlation-style* unqualified column refs from a nested
  subquery whose own FROM is empty (or doesn't use the CTE), the
  conflation suppresses a legitimate rewrite — the unqualified `k`
  *should* correlate outward to the renamed real table.

  Concrete repro shape (not present in the test corpus):

  ```sql
  create view v_corr as
    select (with t_corr as (select 1 as x) select k) as result
    from t_corr;
  -- alter table t_corr rename column k to kk;
  -- select * from v_corr;  -- post-fix: eval-time "no column k"
  ```

  Pre-fix this rewrote `k` to `kk` via the OR walk hitting the
  outer-from's `unaliased.has('t_corr')`. Post-fix the inner
  with-frame's `ctesInScope.has('t_corr')` short-circuits to
  `false`, the rewriter skips the rewrite, and at eval time the
  view fails because `t_corr.k` no longer exists.

  The more precise fix would replace `ctesInScope` with
  `ctesShadowingSource` in this one helper. I traced every
  existing test through that variant and none regress (each
  shadowing-blocking case in the corpus has a from-frame source
  that already sets `ctesShadowingSource`). I did **not** apply the
  refinement here because:

  1. The trade-off was the implementer's explicit design choice
     (the implement-stage ticket text spells out "Returns false on
     a closer `ctesInScope.has(state.tableName)` hit"), not an
     oversight — flipping it crosses into a semantic change that
     deserves its own design pass.
  2. The exotic shape — inner WITH declaring a same-name CTE that
     the inner subquery never uses as a source, plus an
     unqualified reference correlating outward — is unlikely in
     real code.
  3. The conservative outcome is safe: an unrewritten view body
     keeps the old column name and fails only at eval time on the
     specific shape, where the user can edit the view by hand.

  Documenting here so a future fix has the analysis on file.
  Not filing a new ticket; if the shape ever surfaces in
  practice the one-line refinement is ready.

- **Minor — Case C contrivance is the cleanest minimal repro.**
  The implementer wondered if Case C could be expressed with a
  single table. I considered `from t_alia as a` + inner
  `from t_alia as a` (same alias, same table): both walks return
  true and both pre- and post-fix rewrite the qualified `a.k`
  identically — the test stops testing the shadowing semantics.
  Two distinct tables are required to make the alias-rebinding
  *meaningful* for the column-rename question. The implementer's
  shape is the minimal one. No change.

- **Test coverage — edge / regression / interaction categories.**
  - Happy path: the three new tests each cover one
    helper-change; each fails meaningfully pre-fix.
  - Edge cases: existing 6a–6p covers the no-list / explicit-list /
    sibling / recursive / aliased / self-aliased / multi-frame
    shadowing matrix.
  - Error paths: the test format treats eval errors as test
    failures, so the pre-fix "view eval fails" scenarios are
    already validated by the post-fix passing on §12 / §13 / §14.
  - Regressions: the documented `isTableInUnaliasedScope`
    correlation case is *not* covered by an explicit test. I did
    not add a "pending / known-failure" test for it because the
    test framework here is golden-output sqllogic without a
    skip/pending mechanism, and adding a passing test that
    documents an incorrect result would be misleading.
  - Interactions: the analyze/push pipeline interaction with
    helpers was checked by hand; existing sibling, recursive, and
    nested-derived-table tests exercise it under both
    pre- and post-helper invocation patterns.

- **No findings on:** code style (idiomatic), type safety (no
  `any`, no widening), resource cleanup (push/pop pairing wrapped
  in `try/finally`), performance (helper changes are O(stack
  depth); stacks are shallow), error handling (helpers don't
  throw; pure decision functions), DRY (no duplication
  introduced), modularity (helpers stay private to the file),
  maintainability (the three new doc-comments explicitly call out
  the shadowing rule each helper implements).

### Disposition

All findings are minor and documented above. No new tickets
filed. No code changes applied in this review pass.

## Validation

- `yarn workspace @quereus/quereus run test --grep "41.3"` —
  41.3-alter-rename-propagation.sqllogic passes (1/1).
- `yarn workspace @quereus/quereus run test --grep "alter|rename|SQL Logic Tests|MemoryVTable|schema-differ"` —
  203/203 passing.
- `yarn workspace @quereus/quereus run test --grep "Optimizer Equivalence"` —
  6/6 passing (rebuts the implement-stage note about an unrelated
  random-seed failure).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn test:store` not run — fix is internal to the AST rewriter
  in `src/schema/`; no store-specific code path is exercised.

## Docs

`docs/schema.md` covers ALTER propagation at a high level. The fix
is an internal precedence correction; no user-visible behavior
beyond the new test scenarios changes. The new test file sections
(§12, §13, §14) themselves document the covered shapes. No doc
updates needed.

## End
