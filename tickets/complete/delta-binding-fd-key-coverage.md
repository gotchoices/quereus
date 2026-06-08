description: Migrated delta-binding candidate-key sourcing onto the unified `keysOf` surface (FD-derived keys, the `∅ → all_cols` ≤1-row empty key, and the all-columns set key in addition to declared keys). Completeness-only change; reviewed for soundness regressions. COMPLETE.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/row-specific-fd.spec.ts, packages/quereus/test/optimizer/binding-extractor.spec.ts, packages/quereus/test/incremental/delta-executor.spec.ts, docs/incremental-maintenance.md
----

## What landed

Delta-binding candidate keys now come from the unified `keysOf` surface
(`planner/util/fd-utils.ts`) rather than declared `RelationType.keys` alone. A
new `candidateKeys?: number[][]` field on `TableInfo` is populated in
`createTableInfoFromNode` via `keysOf(node)`, and the three delta-binding
consumers (`extractCoveredKeysForTable`, the `extractConstraints` inline
coverage block, and `classifyForAggregate`) read it with a
`?? uniqueKeys ?? []` fallback. Empty-`keyColumns` `'row'` bindings (the ≤1-row
empty key) are handled soundly downstream: the delta executor demotes them to
`globalRelations`, `change-scope` reports a `full` watch scope, and the
assertion residual leaves the `TableReferenceNode` unwrapped.

See the implement commit `c55fa8c1` for the full source diff.

## Review findings

Adversarial pass over the implement diff (`c55fa8c1`). The implementation is
**sound and correct**; the substantive findings were about test quality and doc
accuracy, all fixed inline in this pass. No new tickets filed.

### Checked — soundness (the ticket's stated risk surface)

- **`keysOf` all-columns key for no-PK tables.** Verified the central soundness
  premise: a no-PK base table is **not** a bag. Quereus synthesizes an implicit
  **all-columns PRIMARY KEY** at schema creation (`schema/table.ts:484-496`),
  which flows into `RelationType.keys` and makes `isSet: true`
  (`planner/type-utils.ts:63`) correct. The memory vtab enforces that key via
  its BTree, so duplicate rows are impossible. The all-columns candidate key is
  therefore **sound**.
- **Empty-key (`[]`) ≤1-row demotion → no missed violations.** Traced the full
  chain: empty-key `'row'` → `delta-executor.runOne` adds the relKey to
  `globalRelations` → assertion `apply` runs `executeViolationOnce` on the full
  violation SQL (`database-assertions.ts:366-368`). The relation is
  re-evaluated whole, not skipped. Sound — and cost-equivalent for a genuinely
  ≤1-row table.
- **Tighter FD-derived key choice.** `deriveKeysFromFds` only emits superkeys,
  so binding per FD-derived key tuple is unique ⇒ sound. Relies on CHECK/EC
  enforcement (which Quereus enforces).
- **`change-scope` and `database-assertions` empty-`keyColumns` branches** —
  both reviewed; `{ kind: 'full' }` / unwrapped-reference are the sound
  projections for a ≤1-row table.
- **Classification/coverage consistency.** `analyzeRowSpecific` (decides
  row/global) and `extractCoveredKeysForTable` (produces the key) now both read
  `candidateKeys` — no mismatch that could mis-emit a binding.
- **All `keyColumns`/`groupColumns` consumers** swept (`find_references`): the
  assertion capture/residual path, `change-scope` value extraction, and the
  delta executor all tolerate the empty key. No consumer treats it
  pathologically.

  **Soundness conclusion:** purely additive completeness; over-classifying as
  `'global'` was always correct, and the change only ever tightens. No
  regression.

### Found + fixed inline (minor)

- **3 of 5 new tests passed on the *pre-change* code, with factually wrong
  rationale comments.** Verified empirically by reverting only the `src/` files
  to `c55fa8c1~1` and running the new specs: `row-specific-fd` "FD-derived key"
  and "≤1-row" cases and the `binding-extractor` "FD-derived key" case all
  stayed green. Root cause: because every base table carries the implicit
  all-columns PK **and** every FD-derived key is a superkey (covered exactly
  when the all-columns key is), the equality-coverage path can **never flip a
  classification from `global`→`row`** as a result of this change. The genuine
  new behaviors are only (a) a *tighter chosen* `keyColumns` and (b) ≤1-row
  references normalizing to the empty key `[]`. The comments claimed
  "`relType.keys` is empty" / "old path classifies global" — both false.
  - **Fixed:** corrected the misleading comments in `row-specific-fd.spec.ts`
    (2 cases) and `binding-extractor.spec.ts` (the empty-key and FD-derived
    cases) to state reality.
  - **Strengthened:** the `binding-extractor` FD-derived test now asserts the
    chosen key is exactly `[0]` (the tighter sub-PK key) instead of
    `cols.length > 0`. This is a genuine regression guard — it **fails** on the
    pre-change code (which returns the all-columns key `[0, 1]`).
  - The 2 ≤1-row→empty-key tests that already fail on pre-change code
    (`binding-extractor` keyColumns `[]` and `delta-executor` global demotion)
    are the meaningful regression guards and were left as-is.
- **Doc overstatement.** `docs/incremental-maintenance.md` claimed a reference
  provable only through `physical.fds` "classifies `'row'` rather than
  `'global'`." Corrected to describe the real effect (tighter chosen key +
  ≤1-row empty-key normalization) and added the note that this sourcing does
  not flip the equality-path classification.

### Noted — not blocking (completeness only)

- **Aggregate ≤1-row group-flip is untested.** In `classifyForAggregate`, the
  empty candidate key is trivially covered (`key.length === 0 ⇒ true`), so a
  ≤1-row table beneath an aggregate whose GROUP BY does not otherwise cover the
  all-columns key could newly classify `'group'`. In practice a singleton-FD
  table has all columns determined by `∅`, so the all-columns key is also
  covered and no flip occurs — but the trivial-empty-key branch is a real,
  sound, and currently untested completeness path. Low value; left as a future
  observation rather than a ticket.
- **Hoisted-assertion key-FD shape (carried from implement handoff #1).** No
  `CREATE ASSERTION` self-join uniqueness shape was found that hoists a
  `{c} → others` *key* FD; assertion hoisting only emits `∅ → col` / `col1 ↔
  col2` shapes. The end-to-end FD-only coverage is exercised via no-PK CHECK
  tables, which is a real `physical.fds` path. Acceptable — the ticket
  explicitly permitted the synthetic route.

## Validation

- `yarn workspace @quereus/quereus lint` — clean.
- Optimizer + incremental + delta-watch focused run (`test/optimizer/**`,
  `test/incremental/**`, `test/runtime/delta-executor-watch.spec.ts`): **1117
  passing, 0 failing** on HEAD with the review edits.
- The three touched spec files run green individually (33 passing), including
  the strengthened `[0]` assertion.
- Empirical pre-change check (revert `src/` to `c55fa8c1~1`, keep new tests):
  confirmed exactly 2 of the 5 new tests fail on the old code, motivating the
  test-strengthening above. Source restored to HEAD afterward.
