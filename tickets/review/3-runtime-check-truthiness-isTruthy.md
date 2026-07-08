description: A table's CHECK rule could wrongly accept a "false-like" result such as the number zero written as a big integer or the text "0"; both CHECK-enforcement sites now use the same truthiness rule as the rest of the engine.
files: packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/deferred-constraint-queue.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/40.2-check-extras.sqllogic
difficulty: easy
----
## What changed

Both CHECK-constraint enforcement sites tested failure with `result === false || result === 0`, which only catches the JS boolean `false` and the JS number `0`. Integer literals in Quereus lex to `bigint` at runtime (confirmed via the existing `typeof(x)` test in the same file), so a CHECK like `check (v)` on an integer column storing `0` evaluated to bigint `0n` — which slipped past the old test and silently passed a constraint that should have failed. Same gap for the string `'0'`.

Fixed both sites to use the shared `isTruthy` helper from `packages/quereus/src/util/comparison.ts:438` (same truthiness rule `FilterNode`/`WHERE` already use), keeping the existing "NULL always passes" carve-out:

```ts
if (result !== null && !isTruthy(result)) { /* fail */ }
```

- `packages/quereus/src/runtime/emit/constraint-check.ts:373` (immediate CHECK evaluation path)
- `packages/quereus/src/runtime/deferred-constraint-queue.ts:104` (note: ticket said `runtime/emit/deferred-constraint-queue.ts`, but the actual file lives at `runtime/deferred-constraint-queue.ts`, one level up — no `emit/` subfolder copy exists)

## Test coverage

Added a section to `packages/quereus/test/logic/40.2-check-extras.sqllogic` (table `t_truthy`, `check (v)` on an `any` column):
- integer literal `5` and boolean `true` insert cleanly (truthy control)
- integer literal `0` (bigint `0n` at runtime) → `CHECK` error
- string `'0'` → `CHECK` error (numeric-conversion falsy, matches `isTruthy`'s string handling)
- boolean `false` → `CHECK` error (regression control, already worked pre-fix)

`yarn build` and `yarn test` both clean: 6472 passing, 9 pending (pre-existing skips, unrelated), 0 failing.

This test only exercises the immediate (non-deferred) path through `constraint-check.ts`. It does not add a dedicated case that forces the row through `deferred-constraint-queue.ts`'s `evaluateEntry` (e.g. a CHECK containing a subquery, which auto-defers) — that path shares the exact same one-line fix and helper, so risk is low, but a reviewer wanting belt-and-suspenders coverage could add a `check (v)`-shaped case inside a deferred/subquery constraint too.

## Known gap: same narrow-comparison pattern exists at other sites, left untouched

Ticket scope named exactly two sites ("both must change"). While reading the surrounding code I found the identical `result === false || result === 0` pattern at two more CHECK-evaluation sites that were **not** in scope for this ticket and were left as-is:

- `packages/quereus/src/runtime/emit/alter-table.ts:408` — re-validates CHECK constraints during an `ALTER TABLE ... ADD COLUMN` backfill.
- `packages/quereus/src/core/derived-row-validator.ts:179` — validates CHECK/FK-child constraints on derived rows (e.g. generated/materialized relations).

Both are reachable today (not behind a dormant flag), so this isn't a conditional tripwire — it's the same defect, just outside this ticket's stated file list. Recommend a follow-up ticket applying the identical `isTruthy` swap to these two sites (and adding equivalent logic-test coverage: an `ALTER TABLE ... ADD COLUMN ... CHECK` backfill case, and a derived-row/generated-column CHECK case).

Two more `false`/`0`/`0n` comparisons exist purely in optimizer-time constant-folding heuristics (`packages/quereus/src/planner/rules/predicate/rule-empty-relation-folding.ts:71` and `packages/quereus/src/planner/mutation/decomposition.ts:1665`) — those are documented as intentionally conservative subsets of literal-falsy detection (missing a case only forgoes an optimization, never produces a wrong result), so they are not part of this defect class and don't need changing.
