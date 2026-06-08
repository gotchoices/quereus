---
description: Optimizer rule that drops trailing ORDER BY keys functionally determined by leading keys
files:
  - packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts (new)
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts (new)
  - packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts
  - packages/quereus/test/logic/04-order-by.sqllogic (new)
  - docs/optimizer.md
---

## What was built

A Structural-pass rule `ruleOrderByFdPruning` that drops trailing
`ORDER BY` keys functionally determined by the leading bare-column keys
under the source's FDs + equivalence classes.

- Walks `node.sortKeys` front-to-back maintaining
  `determined = closure({leading bare-column source-attribute INDICES}, fds, ECs)`.
- A trailing key is droppable iff it is a bare `ColumnReferenceNode`
  and its source-attribute index is already in `determined`.
- Non-bare-column keys are opaque: they neither contribute to nor consume
  `determined`, and are never droppable.
- Reasoning space is source-attribute-INDEX (positions in
  `source.getAttributes()`) — NOT attribute IDs — mirroring how
  `SortNode.computePhysical` does its `leadIdx` lookup.

The rule is registered in the Structural pass at priority 26, with disable
id `'orderby-fd-pruning'`. Structural runs before PostOptimization, so
single-key reductions feed `monotonic-limit-pushdown` (PostOptimization
priority 8) without explicit ordering plumbing.

The previously-private `expandEcsToFds` helper from
`rule-groupby-fd-simplification.ts` was promoted to `fd-utils.ts` and the
GROUP BY rule was updated to import from there (no behavior change).

## Key files

- `packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts`
- `packages/quereus/src/planner/util/fd-utils.ts` (`expandEcsToFds` lifted)
- `packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts`
  (now imports `expandEcsToFds`)
- `packages/quereus/src/planner/optimizer.ts` (registration at priority 26)
- `packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts` (12 cases)
- `packages/quereus/test/logic/04-order-by.sqllogic` (PK- and EC-driven
  behavioral coverage)
- `packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts`
  (updated multi-key bail case to use a non-bare trailing key so the
  pushdown rule's multi-key bail remains under test)
- `docs/optimizer.md` (rule catalog under "Sort" + cross-link from the
  LIMIT/OFFSET pushdown section)

## Testing notes

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 2852 passing, 2 pending,
  0 failing.
- `yarn workspace @quereus/quereus run test:store` — not run (agent
  default is memory-backed tests).

## Usage

The rule fires automatically on Structural pass. To disable:

```ts
db.optimizer.updateTuning({ ...db.optimizer.tuning,
  disabledRules: new Set([...db.optimizer.tuning.disabledRules ?? [],
                          'orderby-fd-pruning']) });
```

Canonical wins:

- `SELECT … FROM t ORDER BY pk, name [LIMIT n OFFSET k]` over
  `pk INTEGER PRIMARY KEY` → trailing `name` dropped; if `pk` ordering is
  natively served (e.g. via PK IndexScan or `OrdinalSeek`), the Sort is
  also elided, and `monotonic-limit-pushdown` converts the LIMIT/OFFSET
  into `ORDINALSLICE`.
- `SELECT a, b FROM t WHERE a = b ORDER BY a, b` → trailing `b` dropped
  via EC `{a, b}`.

## Review findings

### What was checked

- **Diff first**: read `git show 975e6961` for the implementation commit
  before considering the handoff summary.
- **Correctness**:
  - Reasoning space (source-attribute-INDEX vs attribute ID): verified
    against `SortNode.computePhysical` (`sort.ts:86-87`) — the rule
    matches.
  - `expandEcsToFds` lift: byte-for-byte identical to the previously
    private copy; GROUP BY rule's `import` updated.
  - `computeClosure` empty-determinants behavior: `every(...)` returns
    `true` on an empty array, so `∅ → col` FDs (the
    `ConstantBinding`-style FDs from `WHERE col = const`) ARE picked up by
    the rule via the same `computeClosure` call — confirms the handoff
    claim.
  - Closure recomputation per added leading key: idempotent and correct;
    `determined` grows monotonically.
  - Direction/nulls preservation: `survivors.push(key)` pushes the
    original `SortKey` reference, so `direction` and `nulls` survive
    untouched.
  - Idempotency: re-firing on a rewritten node either returns `null`
    (no more droppable keys) or shrinks further; never re-creates
    spurious nodes.
  - Defensive guards: `< 2` keys, missing `srcIdx` (column doesn't
    resolve into source), `survivors.length === 0` (impossible by
    construction).
- **Source caching**: `node.source.physical` is lazy and memoized; the
  rule reads it once per invocation, fine.
- **Registration ordering**: priority 26 sits after
  `subquery-decorrelation` (25); not load-bearing per the rule's own
  comments. PostOptimization passes (8 = `monotonic-limit-pushdown`)
  run later automatically. Confirmed via `optimizer.ts:88-240`.
- **Resource cleanup / error handling**: rule is pure, no resources;
  returns `null` on no-op.
- **Test coverage**: read both `rule-orderby-fd-pruning.spec.ts` and
  `04-order-by.sqllogic` end-to-end; the spec covers PK-driven (DESC
  variant to keep Sort in plan), PK-driven elision, EC-driven, no-FD
  baseline (with `disabledRules` comparison), expression trailing key,
  three-key partial drop, direction irrelevance, direction-mixed-leading,
  single-key guard, source-attribute-identity, interaction smoke
  (ordinal-slice pushdown), and behavioral correctness for both PK and
  EC drivers.
- **Cross-file consistency**: grep across `packages/quereus/test` for
  `ORDER BY [a-zA-Z_]+,` confirmed the only optimizer-plan-shape spec
  affected is `monotonic-limit-pushdown.spec.ts` (the implement-stage
  test churn it already calls out). `hash-aggregate.spec.ts` line 119
  uses `GROUP BY a, b ORDER BY a, b` over heap columns with no FD between
  `a` and `b`, so the rule no-ops; full test suite green confirms this.
- **Docs**: `docs/optimizer.md` updated with a Sort-family catalog entry
  and a cross-link from the LIMIT/OFFSET pushdown section.

### Findings — fixed in this pass

None. The implementation is sound and the tests cover the documented
scope.

### Findings — informational (no action)

- **Awkward type-rename import**: the rule does
  `import type { OptContext as _OptContext } from '../../framework/
  context.js';` and types the parameter as `_context: _OptContext`.
  Renaming the type is unnecessary; just `OptContext` with `_context`
  satisfies the unused-arg lint convention used elsewhere in the
  codebase (e.g. the GROUP BY rule). Cosmetic only; behavior is
  identical.
- **Conservative on COLLATE/Cast-wrapped trailing keys**: e.g.
  `ORDER BY pk, name COLLATE NOCASE` where `pk → name` would in
  principle still allow dropping the trailing key (per pk group there's
  exactly one `name` value, so collation on it cannot reorder). The
  current matcher only drops bare `ColumnReferenceNode` keys, so this
  shape is left intact. Safe under-approximation; flagging as a future
  opt opportunity, not a defect.
- **Single-key test weakly asserts no-op**: the `< 2` guard test only
  checks `sortKeys.length === 1` on the surviving Sort. Could be
  tightened to `disabledRules` comparison, but the assertion is
  adequate given the input is also a single-key sort.
- **Chained-FD drop not explicitly tested**: the three-key test covers
  `pk DESC, name, email` where `pk → name` AND `pk → email` directly.
  A test for transitively-chained FDs (e.g. `pk → a, a → b`,
  `ORDER BY pk, a, b`) is not present. The rule's incremental closure
  loop handles this by construction (each iteration re-closes), and the
  pattern is exercised in real test suites via foreign-key/EC chains —
  not a gap, but a more explicit test would be belt-and-suspenders.
- **Brittle test-shape**: positive tests rely on
  `db.getPlan(sql)` finding the surviving `SortNode`. Some shapes use
  `pk DESC` specifically to keep the Sort in the plan (ASC PK is served
  by the IndexScan and the Sort is elided downstream). If a future rule
  learns to serve `pk DESC` from an ASC index by reversing the scan,
  these tests will need to switch to `disabledRules` plan comparison
  (the handoff already calls this out).

### Findings — major / new tickets

None. No major correctness, performance, maintainability, or scalability
defects were found.
