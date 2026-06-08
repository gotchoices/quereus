description: IMPLEMENT — A `COLLATE` on a *bound* of `BETWEEN` (e.g. `name between 'bob' collate NOCASE and 'bob'`) is ignored, returning wrong rows. Root cause is NOT folding (the bound collation survives folding fine) — it is `emitBetween`, which collapses both comparisons to a single collation chosen `expr → lower → upper`, so the tested column's *implicit* `BINARY` collation (always present, truthy) clobbers an *explicit* `COLLATE` on a bound. Fix: resolve the lower/upper comparison collations independently with right(bound)-operand precedence, mirroring `emitComparisonOp`. Also fix the index-seek classification arm and add regression tests.
prereq:
files:
  - packages/quereus/src/runtime/emit/between.ts                       # PRIMARY FIX — per-bound collation resolution
  - packages/quereus/src/runtime/emit/binary.ts                        # emitComparisonOp (the right-precedence model to mirror), lines 209-261
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # effectivePredicateCollation BETWEEN arm (lines 1205-1224) + stale comment
  - packages/quereus/src/planner/analysis/constraint-extractor.ts      # extractBetweenConstraints (438-484) — emits >= / <= seek constraints, both sharing the BetweenNode source
  - packages/quereus/src/planner/nodes/scalar.ts                       # BetweenNode (821), CollateNode.generateType (766), LiteralNode.explicitType (346)
  - packages/quereus/src/planner/analysis/const-pass.ts                # replaceBorderNodes (252-294) — already preserves collation via node.getType(); NO change needed
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic       # add regression assertions
----

# `COLLATE` on a BETWEEN bound is dropped — corrected root cause

## What was confirmed during the fix stage

Reproduced on a bare scan (`create table t (id integer primary key, name text)`; rows
`(1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob')`):

```sql
select id from t where name between 'bob' collate NOCASE and 'bob' order by id;  -- BUG: []  (want [2,4])
select id from t where name collate NOCASE between 'bob' and 'bob' order by id;  -- OK:  [2,4]
select id from t where name >= 'bob' collate NOCASE and name <= 'bob' order by id; -- OK: [2,4]
```

**The ticket's folding hypothesis is WRONG.** Constant folding preserves the bound collation
correctly. Instrumenting `emitBetween` showed the operand types at emit time are:

```
expr: "BINARY"   lower: "NOCASE"   upper: undefined
```

i.e. the folded lower bound *does* carry `collationName: 'NOCASE'` (via `LiteralNode.explicitType`,
populated by `replaceBorderNodes` from `CollateNode.getType()`). So `const-pass.ts` needs **no change**.

The actual bug is the resolution logic in `emitBetween` (`runtime/emit/between.ts`):

```ts
let collationName = 'BINARY';
if (exprType.collationName) {            // column 'name' → 'BINARY' is TRUTHY
    collationName = exprType.collationName;   // picks BINARY, never looks at the bounds
} else if (lowerType.collationName) { ... } else if (upperType.collationName) { ... }
```

Two faults:
1. It uses a **single** collation for *both* comparisons, but `BETWEEN` desugars to
   `expr >= lo AND expr <= hi` where each comparison resolves its collation **independently**.
2. It gives the tested **expr** first priority. A plain column's `collationName` is the *implicit
   default* `'BINARY'` — always present and truthy — so it shadows an *explicit* `COLLATE` on a
   bound. The correct model (already used by the desugared form via `emitComparisonOp`) is
   **right(bound)-operand precedence**: `bound.collationName ?? expr.collationName ?? 'BINARY'`,
   computed separately per bound.

Why the two working forms work:
- *expr-side* `name collate NOCASE between …`: `expr` is a `CollateNode` → `NOCASE`; both
  comparisons inherit it (bounds are bare → `undefined ?? NOCASE`).
- *desugared* `name >= 'bob' collate NOCASE and name <= 'bob'`: each `BinaryOpNode` is emitted by
  `emitComparisonOp`, which does `rightType.collationName ?? leftType.collationName ?? 'BINARY'`
  — lower → `NOCASE`, upper → `BINARY`. Exactly the per-bound behaviour `emitBetween` must mirror.

## The fix (primary): `emitBetween`

Resolve and pre-bind **two** collation functions, one per comparison, each with bound precedence:

```ts
const exprColl = exprType.collationName;
const lowerCollationName = lowerType.collationName ?? exprColl ?? 'BINARY';
const upperCollationName = upperType.collationName ?? exprColl ?? 'BINARY';
const lowerCollationFunc = ctx.resolveCollation(lowerCollationName);
const upperCollationFunc = ctx.resolveCollation(upperCollationName);
```

`run` then uses `lowerCollationFunc` for `compareSqlValuesFast(value, lowerBound, …)` and
`upperCollationFunc` for `compareSqlValuesFast(value, upperBound, …)`. Keep the existing
`null` short-circuit and the `plan.expression.not` negation — `NOT BETWEEN` becomes
`!(lower<=v<=upper)` = `v < lo (lowerColl) OR v > hi (upperColl)`, which is correct with per-bound
collations. Update the `note` to reflect both collations (e.g. only append a name when it differs
from `BINARY`; if they differ from each other, show both).

This single change fixes the reported wrong-rows result (it reproduces on a scan with no index).

## Secondary fix: index-seek collation classification

`effectivePredicateCollation` (`rule-select-access-path.ts:1205`) currently has a BETWEEN arm that
reads **only** `src.expr.getType().collationName`, with a comment asserting the bound collation is
"dropped during constant folding". **That comment is now false** — the bound collation is available
on `src.lower` / `src.upper`. Because `extractBetweenConstraints` emits two constraints (`op: '>='`
for the lower bound, `op: '<='` for the upper) that **share the same `BetweenNode` sourceExpression**,
use `constraint.op` to pick the correct bound, mirroring the runtime:

```ts
if (src instanceof BetweenNode) {
    const exprColl = src.expr.getType().collationName;
    const boundColl = (constraint.op === '<=' || constraint.op === '<')
        ? src.upper.getType().collationName
        : src.lower.getType().collationName;
    return normalizeCollationName(boundColl ?? exprColl ?? 'BINARY');
}
```

With this, the existing `classifyCollationCover` logic correctly declines the seek (or attaches the
`BetweenNode` as a residual) when a bound's effective collation does not match the index's column
collation — so a bound-collated `BETWEEN` over a *collated index* classifies the cover correctly too.
No change to `extractBetweenConstraints` itself is required: it may keep producing the `>=`/`<=`
constraints; the access-path rule decides usability via the (now-correct) per-bound collation, and any
residual it re-applies is the `BetweenNode`, which evaluates correctly once the primary fix lands.
**Remove/replace the stale comment** at lines 1213-1219.

## Notes / scope

- Right(bound)-operand precedence is deliberately chosen to match quereus's existing
  `emitComparisonOp` (and hence the desugared form), not necessarily SQLite's left-explicit-first
  rule. Quereus's right-precedence simplification is pre-existing and out of scope; just stay
  consistent with it so all three syntactic forms agree.
- `const-pass.ts` / `LiteralNode.explicitType` are **correct as-is** — do not touch.
- Verify `NOT BETWEEN` with a collated bound, and a collated bound where the *upper* (not lower)
  carries the `COLLATE`.

## TODO

- [ ] In `runtime/emit/between.ts`, replace the single `collationName` resolution with independent
      `lowerCollationName` / `upperCollationName` (each `bound ?? expr ?? 'BINARY'`), resolve two
      collation funcs, and use the matching func in each `compareSqlValuesFast` call. Update `note`.
- [ ] In `rule-select-access-path.ts`, rewrite the `BetweenNode` arm of `effectivePredicateCollation`
      to select the bound by `constraint.op` (`>=`/`>` → lower, `<=`/`<` → upper) and apply
      `bound ?? expr ?? 'BINARY'`. Delete the now-false "dropped during constant folding" comment.
- [ ] Add regression assertions to `test/logic/06.4.2-collation-extras.sqllogic` (new section), on a
      `name text` (BINARY) table with rows `(1,'Alice'),(2,'BOB'),(3,'charlie'),(4,'Bob')`:
      - `… where name between 'bob' collate NOCASE and 'bob' order by id` → `[{"id":2},{"id":4}]`
      - `… where name collate NOCASE between 'bob' and 'bob' order by id` → `[{"id":2},{"id":4}]` (stays correct)
      - `… where name >= 'bob' collate NOCASE and name <= 'bob' order by id` → `[{"id":2},{"id":4}]` (desugared parity)
      - upper-bound-collated variant, e.g. `… where name between 'BOB' and 'bob' collate NOCASE order by id`
        (compute expected by hand against the desugared form and assert parity)
      - a `NOT BETWEEN` collated-bound case
      - an index variant: add `create index … on t(name collate NOCASE)` (or a separate BINARY index)
        and assert the same collated-bound BETWEEN returns identical rows to the scan form (exercises
        the access-path cover classification / secondary fix).
- [ ] Run `yarn workspace @quereus/quereus test` (stream with `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`)
      and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows). Type-check with `tsc --noEmit`.
- [ ] (Optional) If `docs/sql.md` documents BETWEEN/collation behaviour, note that bound-level
      `COLLATE` governs that bound's comparison.
