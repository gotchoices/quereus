description: Three small optimizer housekeeping cleanups are implemented — a rule-engine contract is now documented, a debug-only file lost its `any` types, and dead context-helper code was deleted.
files: packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/framework/context.ts, packages/quereus/src/planner/debug.ts, packages/quereus/src/planner/framework/README.md, docs/optimizer.md, packages/quereus/test/optimizer/pass-manager.spec.ts, packages/quereus/test/planner/framework.spec.ts
difficulty: easy
----
Implementation of `tickets/implement/5-planner-optimizer-cleanups.md`. All three items landed; original ticket deleted.

## Item 1 — Convergence-model contract documented

`packages/quereus/src/planner/framework/pass.ts` — `PassManager.applyPassRules`, at the `markRuleApplied` / `inheritVisitedRules` pair (now ~line 594-601): added a `NOTE:` comment stating a rule is never re-offered its own output, and that a rule needing a fixpoint over its own rewrites must self-loop (points at `rule-filter-merge` as the pattern).

`docs/optimizer.md` — added a bullet under **Best Practices → Rule Development** (not the Pass Framework section — Best Practices reads more naturally as author-facing guidance) stating the same contract and naming `rule-filter-merge` (`planner/rules/predicate/rule-filter-merge.ts`) as the canonical example — it absorbs an arbitrarily deep stack of nested `Filter` nodes in one call via an internal `while` loop for exactly this reason.

**Test/validation**: doc-only + a code comment; no behavior change. Verified `rule-filter-merge` really does self-loop (read the source) before citing it.

## Item 2 — `planner/debug.ts` retyped, no more `any`

Removed the file-level `/* eslint-disable @typescript-eslint/no-explicit-any */` and every `any` in the file:

- `PlanNodeDebugInfo.type` → `BaseType` (the real return type of `PlanNode.getType()`; imported from `common/datatype.js`). `properties` → `Record<string, unknown>`.
- `isAstNode(value: unknown)` / `processValue(value: unknown): unknown` — same runtime logic, just untyped-`any` → `unknown` with the existing `typeof`/`in` narrowing preserved.
- `(node as any).estimatedRows` → `isRelationalNode(node) ? node.estimatedRows : undefined` (imported `isRelationalNode` from `nodes/plan-node.js`; `estimatedRows` only exists on `RelationalPlanNode`).
- `(node as any).physical` / `(physical as any)` → dropped entirely. Turns out `PlanNode.physical` is a public, non-optional getter on the base class (`get physical(): PhysicalProperties`) — no cast was ever needed. `physical.ordering.map((o: any) => ...)` → inferred element type from `PhysicalProperties.ordering` (`{ column: number; desc: boolean }[]`), no annotation needed.
- `scheduler: any` (in `generateInstructionProgram`'s `subProgramMap`) → `Scheduler` (imported type-only from `runtime/scheduler.js`; matches `Instruction.programs?: Scheduler[]`).

No `eslint-disable-next-line` needed anywhere — every site had a real type available.

**Test/validation**:
- `yarn workspace @quereus/quereus run lint` passes clean (eslint + `tsc -p tsconfig.test.json --noEmit`) — confirms no new lint/type errors surfaced elsewhere in the file after dropping the file-level disable.
- Full `yarn test` run (6896 passing, 13 pending — pending are pre-existing, not from this change) exercises `serializePlanTree` / `formatPlanTree` indirectly through EXPLAIN/plan-display tests under `test/plan/**`; this was a typing-only change with no logic altered, so output is expected byte-identical. **Gap**: I did not diff a specific EXPLAIN golden-plan output before/after by hand — I'm relying on the full green test run (which includes the plan golden-file comparisons) rather than an isolated manual check. Worth a spot-check if you want extra confidence, e.g. `yarn test:plans`.

## Item 3 — Dead `OptimizationContext` helper surface removed

Confirmed via `find_references`-equivalent greps (src + test, excluding `RuntimeContext.context` which is an unrelated runtime concept) that these had zero callers outside `context.ts` itself:

- `OptimizationContext.withPhase`, `.withContext`, `.getContext`, `.hasContext`, `.setContext`, `.deleteContext`, `.clearContext`, `.getContextSnapshot`, private `.copyTrackingState` — all deleted.
- `context: Map<string, unknown>` field — removed from both the `OptContext` interface and the `OptimizationContext` class.
- `isOptContext` type guard — deleted (was exported, zero callers).

**`phase` field — left in place, conservatively.** Traced every consumer: `createOptContext`'s `phase` parameter is never passed a non-default value by either call site (`Optimizer.optimize` / `optimizeForAnalysis` in `optimizer.ts`), and no pass or rule reads `context.phase` anywhere (`pass.ts` has zero `.phase` references). So it's arguably dead today too — but it's part of the documented phase-management contract (`RulePhase` in `registry.ts`, the *manifest entries'* `phase` field which is a separate, definitely-live concept) and removing it felt like it was reaching past what the ticket asked for. Left it with an inline doc comment on the interface explaining it's currently always `'rewrite'` and unconsulted, so the next person doesn't have to re-derive this. Flagging this explicitly as a **tripwire**, not a finding to act on: if a phase-gated pass is ever added, wire `context.phase` through `PassManager`; if it's still unused a year from now, it's a legitimate future deletion.

**`framework/README.md:64`** — `optimizer.getContext()` referenced a method that never existed on `Optimizer` (confirmed via grep — zero `getContext` matches in `optimizer.ts`). The whole code snippet was stale beyond that one line: it used `(node, optimizer)` as the rule signature, but the real `RuleFn` type (`registry.ts:15`) is `(node: PlanNode, context: OptContext) => PlanNode | null`. Fixed the snippet to match: renamed the param to `context`, replaced `optimizer.getContext()` / `optimizer.getStats()` with `context.stats` directly.

Also fixed two adjacent stale bullets in the same README section (`### Context (context.ts)`, ~line 19-23) while touching that file: "Depth Tracking" was renamed to "Rule Visitation Tracking" (there is no depth field on `OptContext`; the real loop-prevention mechanism is `visitedRules`/`optimizedNodes`), and the "Context Data: Key-value store..." bullet describing the now-deleted `context` Map was removed. This is slightly beyond the ticket's literal ask but directly adjacent/stale-because-of this change, so I fixed it rather than leave a freshly-wrong doc next to a freshly-fixed one.

**`docs/optimizer.md` "Context Lifecycle" section** (~line 924, found via a second grep pass for `withPhase` across `docs/`) — this entire section documented the now-deleted `withPhase`/`copyTrackingState` derivation pattern with a code sample. Rewrote it to state current reality: one `OptimizationContext` per optimization session, created once via `createOptContext`, not derived/specialized mid-session.

**Test call sites fixed**: `OptContext` object literals in `test/optimizer/pass-manager.spec.ts` and `test/planner/framework.spec.ts` each had a `context: new Map()` line (excess-property under the trimmed interface) — removed both. `test/optimizer/parallel-eager-prefetch-probe.spec.ts` uses `as unknown as OptContext` and never set `context`, so it needed no change. `test/emit-create-assertion.spec.ts` has an unrelated `context: new Map()` on a mocked `RuntimeContext` (different type entirely, confirmed by the existing `fork-contract.spec.ts` regex that explicitly excludes this distinction) — left untouched.

**Test/validation**: `tsc -p tsconfig.test.json --noEmit` (via `yarn lint`) catches any remaining test file that constructs an `OptContext` literal with a stray `context` key — it passed clean, so I'm confident the two fixes above are the complete set for `test/`.

## Known gaps / things the reviewer should double-check

- I did not hand-verify a byte-identical EXPLAIN output diff for Item 2 — relying on the green full test suite (see above).
- The `phase` field tripwire (Item 3) is a judgment call to leave rather than delete — worth a second opinion if you disagree with "conservative" here.
- I extended slightly past the ticket's literal file list into `docs/optimizer.md`'s "Context Lifecycle" section (not explicitly named in the ticket's `files:` header) because it was a second, separate stale reference to the same deleted API, found via a full-repo grep for `withPhase` after finishing the `files:`-listed edits. Flagging in case that's considered scope creep.

## Commands run

```
yarn workspace @quereus/quereus run lint   # exit 0, no output (clean)
yarn test                                   # 6896 passing, 13 pending, exit 0
```

No pre-existing failures encountered — nothing written to `tickets/.pre-existing-error.md`.
