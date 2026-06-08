description: ValuesNode now advertises the singleton `∅ → all_cols` FD when `rows.length ≤ 1` via a `computePhysical` override (mirrors `LimitOffsetNode`). The unified `keysOf`/`isUnique`/`hasSingletonFd` surface picks this up automatically, so DISTINCT elimination, whole-Sort elimination, and join singleton-FD propagation all fire over single-row VALUES that survives const-folding. Reviewed and completed.
files: packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## What landed (summary)

- `ValuesNode.computePhysical` emits `singletonFd(colCount)` when `rows.length <= 1`
  and returns `estimatedRows: rows.length` in both the singleton and multi-row branches.
  `singletonFd(0)` is undefined, so a 0-row VALUES emits no FD (just `estimatedRows: 0`).
- Multi-row VALUES remains a bag — no FDs — by design.
- `TableLiteralNode` is intentionally untouched; the constant-folder rewrites all-literal
  VALUES to `TableLiteralNode` before the physical pass runs, so the user-visible wins on
  `SELECT * FROM (VALUES (1, 2)) ORDER BY a` do not trigger today. The implementer's
  handoff flagged this as a deliberate scope boundary and a possible follow-up; this
  review does not file one — the ticket description scoped it out.
- Five new tests cover: positive singleton emission, multi-row negative control,
  Sort elimination + multi-row negative control, DISTINCT elimination + multi-row
  negative control, behavioral soundness guard. Tests use parameterized VALUES
  (`VALUES (?, ?)`) so they survive const-folding into the physical pass.
- `docs/optimizer.md` per-operator FD propagation table now has a `ValuesNode` row
  (added inline during review — see "Minor finding" below).

## Review findings

Read the implement diff (`49d444ce`) first, then the source, `singletonFd`/`hasSingletonFd`
in `fd-utils.ts`, the `LimitOffsetNode` pattern it mirrors, and the consumers
(`rule-orderby-fd-pruning`, `rule-distinct-elimination`). Full quereus suite ran clean
(3647 passing, 9 pending, 0 failing); lint clean.

### Verified sound (checked, no change needed)

- **Singleton soundness on the structural row count.** `rows.length` is the static
  cell-array length; it does not depend on row-cell values being deterministic. A
  single-row VALUES with `random()` cells still produces exactly one row per
  invocation, so the singleton ∅→all FD holds regardless of cell determinism.
- **Zero-row VALUES is safe.** `singletonFd(0)` → undefined, so the singleton path
  short-circuits to `{ estimatedRows: 0 }`. `hasSingletonFd` requires at least one
  matching dependent, so no consumer is fooled into "≤1-row" claims for a 0-row /
  0-col relation. The `estimatedRows: 0` is a harmless tightening — no consumer in
  the codebase treats it specially (`plan-validator` only rejects `< 0`).
- **Attribute-count match.** `getAttributes().length` is built from
  `firstRow.map(...)` on `rows.length >= 1` and `[]` on `rows.length === 0`, so the
  singleton FD's `dependents` list always matches the output relation's column count.
- **No consumer excludes `Values` from FD consultation.** Grepped
  `PlanNodeType.Values` / `'Values'` / `ValuesNode` across the planner — the only
  hits are construction sites in `building/select.ts`, `building/insert.ts`, and
  `insert-node.ts`. `rule-orderby-fd-pruning` and `rule-distinct-elimination` both
  go through the unified `keysOf` / `isUnique` surface, which consumes
  `physical.fds` regardless of source node type. End-to-end wiring is exercised by
  the new Sort-elimination and DISTINCT-elimination tests.
- **`physical.estimatedRows` was previously undefined on `ValuesNode`** (no
  `computePhysical` override). The new override populates it with `rows.length`,
  matching the long-standing logical `get estimatedRows()` getter. Two consumers
  read it (`rule-fanout-batched-outer.ts:92`, `validation/plan-validator.ts:153`);
  both are robust to the value — the validator only flags `< 0`, and the fan-out
  rule falls back to `node.estimatedRows` anyway. Net effect: a small consistency
  improvement, no behavioral regression.
- **No regressions in `estimatedRows`/cost flow.** Multi-row branch returns
  `{ estimatedRows: this.rows.length }` — same value the getter has always
  produced.
- **Const-folding interaction.** Confirmed via `analysis/const-evaluator.ts:148-186`:
  a relational constant evaluator replaces all-literal `ValuesNode`s with
  `TableLiteralNode` during the const pass. So the new code only fires for VALUES
  whose cells cannot be pre-evaluated (parameter refs, non-deterministic functions,
  correlated subqueries). The new tests deliberately use `?` parameters to keep the
  `ValuesNode` alive into the physical pass — the prose comment in the test file
  makes this explicit.
- **Test helpers are appropriate.** The new `valuesPhysical` mirrors
  `joinPhysicalAny`'s shape; `op.toUpperCase().includes('VALUES')` is unambiguous
  (no other PlanNodeType contains 'VALUES' once uppercased — `TableLiteral` is the
  only other relational shape and shares no substring).
- **Behavioral guard handles the column-aliasing quirk.** `SELECT *` over
  `VALUES (?, ?) AS v(a, b)` emits column names `column_0, column_1` rather than
  `a, b` — a pre-existing oddity unrelated to this ticket. The behavioral test
  compares `Object.values(row)` to side-step it; the comment in the test calls
  this out so a future reader is not surprised.

### Minor (fixed inline during review)

- **Doc gap: optimizer.md FD propagation table was missing a `ValuesNode` row.**
  The implement-stage doc update was confined to the ticket file and didn't touch
  `docs/optimizer.md`'s per-operator table even though `LimitOffsetNode`'s
  identical singleton-FD propagation has its own row. Added a `ValuesNode` row
  beside it that documents (a) the `rows.length ≤ 1` ⇒ `singletonFd(colCount)`
  rule, (b) the multi-row bag fall-through, (c) `estimatedRows = rows.length`,
  and (d) the const-folding caveat that limits when this propagation actually
  fires in practice.

### Major (none)

No design or correctness findings warranting a new fix/plan ticket. The
`TableLiteralNode` parallel-propagation question is real but is the ticket's
explicit scope boundary — not a defect to file against this change. If the
project later decides to chase the all-literal `SELECT * FROM (VALUES (1, 2))`
case, the implementation surface is small (a `rowCount <= 1` ⇒ singleton FD
override on `TableLiteralNode`); `rowCount` already flows in at construction
(`const-evaluator.ts:176-182`).

### Categories not applicable / nothing to report

- **Performance:** the override is O(colCount) on a single call during physical
  pass; nothing to scrutinize.
- **Resource cleanup / error handling:** pure derivation, no resources, no
  failure modes.
- **Type safety:** override signature matches `PlanNode.computePhysical?`'s
  `Partial<PhysicalProperties>`; imports are explicit.
- **Concurrency / cross-platform:** none applicable.

## Validation

- `yarn workspace @quereus/quereus test` — 3647 passing, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — exit 0.
