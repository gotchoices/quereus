---
description: NULL-safe group-key equality landed in AssertionEvaluator's per-group residual. `(col IS NULL AND :gk_i IS NULL) OR col = :gk_i` is emitted per column when `paramPrefix === 'gk'`, so NULL groups are re-evaluated. Sqllogic covers INSERT, UPDATE NULL ↔ non-NULL membership transitions, cross-group isolation, and multi-column GROUP BY with mixed NULLs.
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/incremental-maintenance.md
---

## What changed

### `packages/quereus/src/core/database-assertions.ts`

`tryWrapTableReference` previously built each per-column equality
conjunct as `col = :gk_i`. SQL three-valued logic makes `col = NULL`
UNKNOWN, so the residual scan filtered out rows in the NULL group and
silently missed violations whenever a group-key column was NULL.

For `paramPrefix === 'gk'`, each conjunct is now

```
(col IS NULL AND :gk_i IS NULL) OR col = :gk_i
```

`paramPrefix === 'pk'` is unchanged — PK columns are NOT NULL by
definition, so the row path keeps the simpler `col = :pk_i` and avoids
any optimizer-rule regression in the much-more-common row case. (See
`tickets/fix/delta-null-row-key.md` — review found this scoping leaves
a latent bug when the row binding falls back to a nullable unique key,
filed as a separate fix.)

Implementation detail: two separate `ColumnReferenceNode` and
`ParameterReferenceNode` operand instances are created — one pair for
the `IS NULL` legs, one pair for the `=` leg. The existing `=` path
already builds fresh operands per conjunct; the `IS NULL` legs do the
same. No tree-sharing assumptions broken (verified against
`predicate-normalizer.ts`'s clone-on-change pattern).

### `packages/quereus/test/logic/95-assertions.sqllogic`

Four new test blocks appended after the existing `orders_nonneg` block:

1. **`onn_nonneg`** — single-column nullable group key, NULL group
   seeded with positive sum, then driven negative; must throw and roll
   back. Pre-fix this case silently committed.
2. **`oiso_nonneg`** — cross-group isolation. Both NULL group and
   non-NULL group present; each is driven into violation independently.
3. **`omv_nonneg`** — UPDATE moves a row across the NULL boundary in
   both directions (NULL → non-NULL and non-NULL → NULL), each driving
   the destination negative.
4. **`omc_nonneg`** — two nullable group-key columns. Violations into
   `(NULL, 1)` and `(1, NULL)` independently; finishes with a passing
   insert into `(NULL, NULL)` to confirm AND-of-conjuncts composes
   correctly across columns.

All four tests declare `INTEGER NULL` columns since Quereus columns are
NOT NULL by default.

### `docs/incremental-maintenance.md`

Added a sentence to "First consumer: AssertionEvaluator" documenting
that `'group'` residuals are NULL-safe (so NULL groups are re-evaluated
as distinct groups, matching SQL `GROUP BY` semantics), and that `'row'`
keeps the plain equality form because PK columns are NOT NULL.

## Review findings

### Validated

- **NULL-safe predicate semantics.** Traced all four NULL/non-NULL
  parameter-vs-column combinations through the runtime three-valued OR
  (`runtime/emit/binary.ts:340–360`). NULL group only matches when
  param is NULL; non-NULL group only matches its own value; cross-group
  rows are filtered out. Logic is correct.
- **AST shape.** Verified the `UnaryExpr`/`BinaryExpr` literals against
  `src/parser/ast.ts:55–67`. Field name is `expr` (not `operand`),
  `operator` is a free-form string, and `'IS NULL'` is dispatched by
  `runtime/emit/unary.ts:30` via uppercase normalization. Matches.
- **Plan-node child uniqueness.** The implementer creates fresh
  `ColumnReferenceNode` + `ParameterReferenceNode` instances for the
  `IS NULL` legs and the `=` leg. `BinaryOpNode`/`UnaryOpNode` children
  are disjoint subtrees per conjunct; `withChildren` clone pattern in
  `predicate-normalizer.ts` is preserved. No aliasing.
- **Test placement and shape.** Each block follows the same
  `CREATE TABLE → CREATE ASSERTION → -- run → BEGIN/COMMIT → -- error`
  pattern as the existing `orders_nonneg` block above it. Rollback
  verification is present in every violation case.
- **Multi-column composition.** `omc_nonneg`'s mixed-NULL groups
  (`(NULL, 1)`, `(1, NULL)`, `(NULL, NULL)`) prove the AND-of-conjuncts
  composes correctly across two nullable group-key columns.
- **Docs.** Read `docs/incremental-maintenance.md:111–130`; the
  AssertionEvaluator section reflects the new per-column form and calls
  out the row-vs-group asymmetry. No other docs reference the residual
  predicate form.
- **Lint.** `yarn workspace @quereus/quereus run lint` exits 0.
- **Tests.** `yarn test` shows `2940 passing, 2 pending` for the
  quereus package (matching the implement-stage handoff count). The
  four new `*_nonneg` blocks are included in that count. Two failures
  surface in `@quereus/sample-plugins` (`key_value_store virtual table
  supports delete/update`); these reproduce identically on HEAD~1
  with the implement-stage files reverted, so they are pre-existing
  and unrelated to this ticket — flagged for a separate fix.

### Stated explicitly as not checked

- **No optimizer-plan inspection** of the rewritten residual.
  Black-box correctness is verified end-to-end; the implementer noted
  an `explain_assertion`-shape test as belt-and-suspenders. Reviewer
  concurs that black-box is the binding contract and did not file a
  ticket.
- **No microbench.** The OR-of-IS-NULL adds two unary checks + an OR
  per group-key column on the residual. For per-group-tuple residual
  scans this is negligible. Implementer's deferral accepted.
- **`yarn test:store` (LevelDB path) not run.** The change is at the
  planner-rewrite layer and is storage-agnostic; a release should still
  re-run it.

### Major findings — new ticket filed

- **`'row'` path silently misses NULL rows when the row binding falls
  back to a nullable unique key.** The implementer's scoping rationale
  ("PK columns are NOT NULL") holds when `chooseRowKey`
  (`binding-extractor.ts:106`) picks the PK. But `chooseRowKey` falls
  back to the lex-min covered unique key when the PK isn't covered, and
  Quereus follows SQL standard for UNIQUE (multiple NULLs allowed —
  `store-table.ts:checkUniqueConstraints` skips when any covered column
  is NULL). So a row binding can land on a nullable unique key, and the
  same silent-skip bug exists on the `'row'` path. Filed as
  `tickets/fix/delta-null-row-key.md` (depends on this ticket).

### Minor findings

- **None fixed inline.** The implementer's known-gap list correctly
  enumerates the row-path latent bug, and the cleanest fix (use the
  NULL-safe form unconditionally vs. gate on `attributes[colIdx]
  .type.nullable`) requires its own design call and is non-trivial —
  reviewer chose to file a follow-up ticket rather than expand scope
  here.
- **AST `loc` field on synthesized nodes.** The new `BinaryExpr` and
  `UnaryExpr` literals don't set `loc`, matching the surrounding
  per-conjunct construction pattern. Pre-existing convention; no
  action.

## End
