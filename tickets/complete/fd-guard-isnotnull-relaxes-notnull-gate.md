---
description: Relaxed the NOT-NULL gate in `extractPartialUniqueGuardedFds` so a nominally nullable UC column is admitted when the partial predicate has a matching `col IS NOT NULL` conjunct. Reviewed and shipped.
files:
  - packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  - packages/quereus/test/optimizer/conditional-fds.spec.ts
  - packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  - docs/optimizer.md
---

## What landed

`extractPartialUniqueGuardedFds` in
`packages/quereus/src/planner/analysis/partial-unique-extraction.ts`
admits a nullable UC column when the partial predicate has a matching
`col IS NOT NULL` conjunct. The producer:

1. Recognizes guard clauses first.
2. Builds `nonNullByPredicate: Set<number>` from `is-null negated:true`
   clauses.
3. Admits each UC column when `column.notNull === true` **or**
   `nonNullByPredicate.has(idx)`; otherwise skips the whole UC.

Soundness rests on Filter activation: the guarded FD only discharges
when the surrounding predicate entails every guard clause — the
`IS NOT NULL` clause is itself one of those clauses, so discharge
cannot relax the guard for rows where the UC column might be NULL.
Verified by inspecting `clauseEntailed` in `fd-utils.ts` — the
`is-null negated:true` case discharges only via `facts.isNotNullCols`
or `isColumnNonNullable(col)`, never via "column is nominally
nullable".

## Review findings

### Soundness

- **Checked:** `predicateImpliesGuard` / `clauseEntailed` for the
  `is-null negated:true` case (`packages/quereus/src/planner/util/
  fd-utils.ts:907-916`). Both discharge paths are sound (a real
  `IS NOT NULL` conjunct on the predicate, or the source column being
  declared NOT NULL — which trivially satisfies the guard).
- **Checked:** the new gate ordering — recognizer runs first, so
  bogus predicates with unrecognized conjuncts are still rejected
  *before* the gate looks at `nonNullByPredicate`. No behavioral
  change for the soundness rule.
- **Found:** nothing unsound.

### Test coverage

- **Checked:** the five new unit tests in `conditional-fds.spec.ts`
  cover the four pure shapes (singleton-nullable-with-IS-NOT-NULL,
  composite-all-IS-NOT-NULL, IS-NOT-NULL-on-different-column,
  composite-only-one-IS-NOT-NULL, IS-NULL-instead-of-IS-NOT-NULL).
  The reviewer-probe suggested in the implement handoff —
  composite UC mixing IS NOT NULL with eq-literal — was not covered.
- **Done (minor, fixed inline):** added two tests to
  `conditional-fds.spec.ts`:
  - `'admits composite UC mixing IS NOT NULL conjunct with
    table-declared NOT NULL column'` — `(email, region) WHERE email
    IS NOT NULL AND region = 'us'` with `region` NOT NULL on the
    table → admitted.
  - `'rejects composite UC mixing IS NOT NULL conjunct with
    eq-literal on a nullable column'` — same shape, `region`
    nullable on the table → rejected.
- **Checked:** sqllogic section 7h pins runtime correctness for the
  positive case; section 7g (pre-existing) pins the negative case
  where the predicate does not force the UC column non-NULL.

### Docs

- **Checked:** `docs/optimizer.md` § "Partial UNIQUE indexes…" — the
  description of the NOT-NULL gate at line 1276 was stale ("every UC
  column must be declared NOT NULL").
- **Done (minor, fixed inline):** rewrote that sentence to describe
  the relaxation: a UC column qualifies if it is declared NOT NULL OR
  the predicate has a matching `IS NOT NULL` conjunct, with the same
  soundness argument as the source comment.
- **Checked:** the related description of `relationTypeFromTableSchema`
  at line 1341 (about unconditional UC keys) is still accurate — that
  path is unchanged.

### Cross-aspect scan

- **DRY:** the `nonNullByPredicate` set is local and doesn't
  duplicate any existing helper; the gate predicate is simple enough
  that pulling it out into a function would obscure rather than
  clarify. No duplication concern.
- **Performance:** O(clauses) extra scan per UC — negligible
  alongside the existing per-conjunct recognition pass.
- **Type safety:** no `any`, no casts, kept the same `Set<number>`
  representation as the rest of the analysis.
- **Resource cleanup / error handling:** none required (pure
  function returning array).
- **Maintainability:** doc-comment block updated; the bullet about
  "IS-NOT-NULL discharge for nominally-nullable UC columns" was
  correctly removed from the out-of-scope list.
- **Caching:** `getPartialUniqueGuardedFds` caches per
  `TableSchema` via `WeakMap`; behaviour unchanged. Predicate is
  part of the schema, so cached value remains correct.

### Cosmetic / repo hygiene

- **Found:** the implement commit deleted an empty `lint.log` at
  the repo root (a pre-existing stray from prior work). Not
  re-introduced. The repo has several other tracked top-level
  `.log` files (`tsc.log`, `sql.log`, `build-iso.log`, …) that look
  like similar stale captures. **Not addressed here** — out of
  scope for an FD-analysis review; flagged for future cleanup if
  someone wants to take a pass at `.gitignore`.

### Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0,
  no diagnostics).
- `yarn workspace @quereus/quereus run test --grep
  "extractPartialUniqueGuardedFds|Partial UNIQUE|10.5.1"` — 29
  passing.
- `yarn workspace @quereus/quereus run test --grep
  "admits composite UC mixing|rejects composite UC mixing"` — 2
  passing (the new mixed-shape tests).
- `yarn workspace @quereus/quereus run test` — 3032 passing, 2
  pending. Same green baseline as the implement handoff reported.
- `yarn test:store` — skipped per ticket scope (orthogonal to FD
  analysis).

### Major findings filed as new tickets

- None.
