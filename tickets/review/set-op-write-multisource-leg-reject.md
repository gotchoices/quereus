description: Reject a multi-source (JOIN / comma) leg of a set-op view write — in BOTH the static `view_info`/`column_info` surfaces and the dynamic write — with a clean structured diagnostic, replacing the un-diagnosed internal `k.k0_0 isn't a column` error and the static `is_*=YES` over-claim. Restores static/dynamic agreement (conservative all-`NO`). The join-leg write-through *unlock* stays deferred to `set-op-write-multisource-leg-compose`.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
difficulty: medium
----

## What this implemented

A writable set-op leg/branch body must be **single-source**. A multi-source leg (FROM is a
join or comma-join — exactly `isJoinBody(selectAst)`) is now **rejected** in BOTH recognizers
so the static surfaces and the dynamic write cannot drift. Previously both recognizers admitted
a join leg by a column-only projection check; the dynamic write then routed the leg's recursive
`propagate` to `propagateMultiSource`, whose own `__vmupd_keys` capture (`k<side>_<j>` columns)
collided with the outer set-op capture (view-output columns) → un-diagnosed internal
`QuereusError: k.k0_0 isn't a column`. The static surface meanwhile over-claimed `is_*=YES`.

### Changes (set-op.ts)
- Added `isJoinBody` to the `./multi-source.js` import.
- **Flag-less (shared by both surfaces):** `isWritableLeafLeg` now returns `false` when
  `isJoinBody(leaf)`. This drives `flaglessShape` → `isSetOpFlaglessWritableBody` to `false`, so
  the static surface reports all-`NO` AND the dynamic write drops out of the flag-less route.
- **Membership static:** `isOperandWritable` now requires `!isJoinBody(effective)` on the leaf
  return (recurses to leaves at every depth via `isSetOpBodyWritable`).
- **Membership dynamic:** `buildBranch` now rejects a **non-nested** branch whose post-unwrap
  `effectiveSelect` is `isJoinBody(...)` with a clean `unsupported-set-op` diagnostic naming
  `set-op-write-multisource-leg-compose`. Placed on the non-nested leaf path so nested join
  leaves (reached via `analyzeSetOpBranches` → `buildBranch`) are caught at every depth too.
- Module doc-comment updated (join legs explicitly rejected, no more "in principle, join").

### Change NOT in the ticket's plan — scrutinize this (multi-source.ts `isJoinBody`)
The ticket asserted the flag-less write would "fall out of the flag-less route into the
**single-source** spine, which already rejects cleanly." **That is wrong for the very repro
view (`JV`).** A compound (set-op) body's top-level `select` carries its left-most leg's
`from`, so for `JV` (`… from j1 join j2 … union all …`) `isJoinBody(JV)` returned **true** —
routing update/delete to the **multi-source** join path (`view-mutation-builder.ts:132`,
`propagate.ts:272`), NOT the single-source spine. That path's `findJoinNode` happily finds the
JoinNode inside the union's left leg and proceeds, silently ignoring the compound (e.g.
resolving `src` against the join scope, which has no such column) — a confusing/wrong error,
not a clean reject.

Fix: `isJoinBody` now returns `false` when `selectAst.compound` is present — a compound body is
a set-op body, never a join body. This **aligns with the intent already documented at
`propagate.ts:251-257`** ("any other flag-less compound … falls through to the single-source
spine … and rejects `unsupported-set-op` via `classifyViewBody`"), which assumed exactly this.
A genuine join view has no `compound`, so it is unaffected; this is the routing fix that makes
the ticket's stated mechanism actually hold.

**Blast radius audited** (all callers of `isJoinBody`): `propagate.ts:272` (routing — now
correct), `view-mutation-builder.ts:89/132/170` (insert routing / update-delete msAnalysis /
CTE self-capture gate — compound now skips the join paths and reaches `propagate`'s clean
reject; selfCapture is gated to non-ephemeral views anyway), `schema.ts:817/847/1258` (static
surfaces — a compound body now flows to the per-column walk and falls out all-`NO` via
`targetIds.size === 0`, same end result). My new set-op.ts uses pass only non-compound legs to
`isJoinBody` (or short-circuit on `!isNested`/`leaf.compound`), so they are unaffected.

## Acceptance — verified by the added tests
- `view_info('JV')` / `view_info('MV')` (join-leg bodies) report `NO/NO/NO`; `column_info`
  reports every column `is_updatable = NO`.
- `delete`/`update`/`insert` through a join-leg set-op view rejects with a structured
  `cannot write through view …` diagnostic (NOT `k.k0_0 isn't a column`). Base tables untouched.
  - `JV` (flag-less) rejects via the generic `classifyViewBody` (`… view body operator
    'SetOperation' is not updateable in phase 1`).
  - `MV` (membership) rejects via the specific `buildBranch` message (`… multi-source (join)
    leg …`). The asymmetry is benign — both are clean `cannot write through view` rejects.

## Test coverage added (treat as a FLOOR)
- `93.6-set-op-flagless-write.sqllogic` — `JV` (flag-less `union all`, left leg a JOIN): read
  works; static all-`NO`; insert/update/delete clean reject; bases untouched.
- `93.4-view-mutation.sqllogic` — `MV` (`union exists left as inL, exists right as inR`, left
  branch a JOIN): data read works; static all-`NO`; insert/update/delete clean reject; bases
  untouched. (column_info asserts `cid`/`is_updatable`/base only — flag-name case is not
  load-bearing and was deliberately not pinned.)

## Validation run
- `node … mocha … logic.spec.ts --grep "File: 93.6"` → 1 passing.
- `node … mocha … logic.spec.ts --grep "File: 93.4"` → 1 passing.
- `yarn workspace @quereus/quereus test` (full memory-mode suite) → **6273 passing, 9 pending,
  0 failing** (no regressions).
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) →
  exit 0, clean.

## Known gaps / things for the reviewer to probe
- **`isJoinBody` blast radius** — the highest-value review target. I traced every caller (above)
  but a second pair of eyes on the `schema.ts` static surfaces (does any compound-with-join-leg
  body slip to a non-conservative row?) and the `view-mutation-builder.ts:170` CTE self-capture
  gate would be worthwhile. Consider whether `isJoinBody` excluding compounds deserves its own
  focused plan test, independent of the set-op logic tests.
- **Subquery-source legs** (`from (select …)`) are NOT join bodies, so they remain out of scope
  and are NOT gated here — they currently do not reach the `k0_0` collision (the multi-source
  capture is keyed on join sides, not a derived-table source). If a future change makes them
  reach it, this gate won't catch them. Noted as a remaining non-single-source edge.
- **Comma-join legs** (`from a, b`) are covered by `isJoinBody` (`from.length > 1`) but no test
  exercises the comma form specifically — only explicit `JOIN`. A reviewer-added comma-join leg
  case (static all-`NO` + clean reject) would close that.
- **Nested join leaf depth** — the gate is claimed to fire at every nesting depth (nested
  subtree → `analyzeSetOpBranches` → `buildBranch`), but the added tests use depth-1 join legs
  only. A deeper case (`(A_join ∪ B) ∪ C` with a join inside a subtree operand) is unverified.
- No `tickets/.pre-existing-error.md` was written — the full suite was green at HEAD after the
  change with no unrelated failures.
