description: A table's CHECK rule could wrongly accept a "false-like" result such as the number zero written as a big integer or the text "0"; every CHECK-enforcement site now uses the same truthiness rule as the rest of the engine.
files: packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/deferred-constraint-queue.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/core/derived-row-validator.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/40.2-check-extras.sqllogic, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic
----
## Summary

CHECK-constraint enforcement decided pass/fail with `result === false || result === 0`, catching only the JS boolean `false` and JS number `0`. Integer literals lex to `bigint` at runtime, so a CHECK evaluating to bigint `0n` (and the string `'0'`) slipped past and silently admitted a row that should fail. Fix: use the shared `isTruthy` helper (`packages/quereus/src/util/comparison.ts:438`) — the same rule `FilterNode`/`WHERE` use — with a `!== null` guard preserving the "NULL always passes" carve-out:

```ts
if (result !== null && !isTruthy(result)) { /* fail */ }
```

The implement stage fixed the **two** sites named in the ticket. Review found the **same defect** at two further CHECK-enforcement sites, reachable today (not dormant), producing wrong results — so they belong to this defect class, not a follow-up. All four are now fixed and covered:

| Site | Path | Test |
|------|------|------|
| immediate DML CHECK | `runtime/emit/constraint-check.ts:373` | `40.2` `t_truthy` |
| deferred (subquery) CHECK | `runtime/deferred-constraint-queue.ts:104` | `40.2` `t_defer` (new) |
| ALTER ADD COLUMN backfill CHECK | `runtime/emit/alter-table.ts:409` | `03.4` `ac_chk_truthy` (new) |
| maintained-table derived-row CHECK | `core/derived-row-validator.ts:179` | `51.8` §13 (new) |

## Review findings

**Correctness — fix applied in this pass (minor: identical one-line swap, fully understood).**
The implementer's handoff flagged `alter-table.ts:408` and `derived-row-validator.ts:179` as the same narrow-comparison defect, "left untouched, recommend a follow-up ticket." Both are reachable on live paths (ALTER backfill; steady-state maintained-table maintenance) and silently admit a bigint-`0n` / `'0'` CHECK result — a real correctness bug, not a conditional tripwire. Rather than defer a byte-identical `isTruthy` swap to a new ticket, applied it inline to both, plus test coverage. Verified `isTruthy` (`comparison.ts:438`) semantics match SQLite/engine truthiness: NULL/blob/non-numeric-string/empty-string are falsy, numeric-zero (number, bigint, `'0'`) falsy, everything else truthy.

**Defect-class sweep — whole `src/` grepped for `=== false || … === 0`.** Remaining hits are NOT this defect:
- `planner/mutation/decomposition.ts:1665` and `planner/rules/predicate/rule-empty-relation-folding.ts:71` — optimizer-time literal-falsy heuristics; both already include `0n` (and folding also handles `null`), and a miss only forgoes an optimization, never yields a wrong result. Left as-is.
- `planner/mutation/lens-enforcement.ts:643` — a **doc comment** that quoted the old `value === false || value === 0` pattern to explain why a definite-`false` null-safe-equality guard must reject. Updated the prose to reference the current `isTruthy` rule (behavior of the argument unchanged: definite-false still fails, NULL still passes). No logic change.

**Test coverage — happy path, edge, error, regression across all four sites.** The implementer's `40.2` `t_truthy` covered only the immediate path. Added:
- `40.2` `t_defer` — a subquery-bearing CHECK `check ((select v))`, which `containsSubquery` (`constraint-builder.ts:199`) auto-defers, forcing the row through `DeferredConstraintQueue.evaluateEntry`. Confirmed this genuinely routes the deferred path, not the immediate one. Covers bigint `0n` and string `'0'` reject, truthy pass.
- `03.4` `ac_chk_truthy` / `ac_chk_truthy_ok` — `alter table … add column c … default (new.base) check (c)`, base `0` → backfilled bigint `0n` → ALTER aborts, table unchanged; truthy control adds the column.
- `51.8` §13 — steady-state maintained-table `check (v)` on an `any` column, source insert of `0` (bigint `0n`) and `'0'` rejected with maintained-table attribution, truthy non-zero flows.

**Build / lint / tests.** `yarn build` clean; `yarn workspace @quereus/quereus lint` exit 0 (eslint + `tsc -p tsconfig.test.json`); `yarn test` 6472 passing, 9 pending (pre-existing unrelated skips), 0 failing. (`.sqllogic` files run as one Mocha test each, so a bad assertion fails the whole file — the green run confirms every new assertion passed.)

**Docs.** No `docs/` file states the old narrow-comparison rule; the CHECK truthiness contract lives only at the code sites (now consistent) and in the `isTruthy` JSDoc (accurate). Nothing to update beyond the `lens-enforcement.ts` comment already corrected.

**Not done — no tripwires, no new tickets.** The defect class is fully closed; nothing conditional was deferred. `yarn test:store` (LevelDB path) was not run — it is slower and out of this ticket's scope; the fix is store-agnostic (pure JS truthiness at the runtime layer, no store interaction), so risk is low. A maintainer doing release prep runs `test:full` as usual.
