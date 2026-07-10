description: Verify the optimizer's cross-class "can this node do X?" checks now key off a compiler-enforced brand on each node, so a missing implementation fails to compile instead of silently going undetected.
prereq:
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/window-function.ts, packages/quereus/src/planner/nodes/aggregate-function.ts, packages/quereus/src/planner/nodes/internal-recursive-cte-ref-node.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/planner/framework.spec.ts
difficulty: hard
----

## What shipped

The optimizer had three ways to ask "what can this node do?": `instanceof` (class identity), `nodeType` enum compares (dispatch/serialization), and **duck-typed** capability detectors in `framework/characteristics.ts` (`CapabilityDetectors.is*`) that sniffed for the *presence* of methods/fields via `as any`. The duck-typed detectors were the fragile one — add a node that should have a capability, forget a method, and detection silently misfires.

This ticket replaced the duck typing with a **compiler-enforced brand**. Each capability interface now declares a unique `readonly is<X>Capable: true` marker; every implementer sets it; each guard is now a single brand comparison. Because `implements XCapable` fails to compile unless the class also sets the brand, "implements the capability" and "is detected as having it" became the same fact.

Concrete changes:

- **`characteristics.ts`**: added a brand field to all 16 capability interfaces; rewrote every `CapabilityDetectors.is*` guard to a single typed brand check; removed the file-level `/* eslint-disable @typescript-eslint/no-explicit-any */` and every `as any`; dropped the now-unused `isAggregateFunctionSchema` import; fixed the stray `(node as any).isCached()` in `CachingAnalysis.isCacheable` to a narrowed `node.isCached()`.
- **Node classes**: added the brand initializer (`readonly is<X>Capable = true as const;`) to every implementer; added `implements`+brand to the four informally-detected classes (`ColumnReferenceNode`, `WindowFunctionCallNode`, `AggregateFunctionCallNode`, `InternalRecursiveCTERefNode`) and to `StreamAggregateNode`/`HashAggregateNode`; converted the remaining value imports of capability interfaces to `import type`.
- **Tests**: updated the pre-existing duck-typed `CapabilityDetectors` unit tests (in both spec files) to the brand mechanism; added a behavior-preservation suite that constructs a real instance of each implementer and asserts the guard returns `true`, plus structurally-similar siblings that assert `false`.

## Validation performed

- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json`; exit 0, no output = no findings). This is the load-bearing check: it proves every `implements XCapable` is satisfied (brand present) and the test call sites still type-check.
- `yarn workspace @quereus/quereus run test` → **6877 passing, 9 pending, 0 failing** (exit 0). The golden-plan suite passing is the integration net: a missed brand would make a consuming rule stop firing and surface as a plan diff — none appeared.
- The `[property-planner] Rule '…' never fired across 30 runs` lines in test output are the fuzz/property test's own coverage notes (random queries didn't happen to trigger those rules); they are pre-existing and unrelated to this change.

## Where to look / use cases to probe

- **The brand-vs-shape contract.** `test/optimizer/characteristics.spec.ts` → `CapabilityDetectors — brand behavior preservation`. It builds real `AggregateNode`, `JoinNode`, `FilterNode`, `TableReferenceNode`, `AggregateFunctionCallNode`, etc. and asserts each guard accepts them; it asserts real sibling nodes lacking the brand are rejected.
- **The base-class-less aggregate family (the crux).** `isAggregating` must accept `AggregateNode` **and** the physical `StreamAggregateNode`/`HashAggregateNode`, which share no common base. See the dedicated test `recognizes StreamAggregate and HashAggregate as aggregating`. A naive `instanceof AggregateNode` guard would have silently dropped the two physical variants.
- **Shared-`nodeType` discrimination.** `AggregateFunctionCallNode` and `ScalarFunctionCallNode` both carry `nodeType === ScalarFunctionCall`; `WindowFunctionCallNode` is also scalar. The brand — not the function schema, not `nodeType` — now tells them apart. See `tells aggregate, window, and scalar function calls apart by brand alone` and the `isAggregateFunction detects AggregateFunctionCallNode, rejects scalar + look-alikes` test in `framework.spec.ts`.
- **Consumers to spot-check** (all still green, but worth an adversarial read): `rules/aggregate/rule-aggregate-streaming.ts` (`isAggregating`), `rules/join/rule-fanout-lookup-join.ts` (`isAggregating` during subquery-root descent), `rules/cache/rule-cte-optimization.ts` (`isCTE`/`isCached`), `analysis/constraint-extractor.ts` (`isPredicateSource`).

## Known gaps / things a reviewer should challenge

1. **Deviation from the ticket's literal cast form.** The ticket example uses `(node as Partial<X>)`. That fails the TypeScript "insufficient overlap" check for the interfaces that extend `RelationalPlanNode`/`ScalarPlanNode` (their `getType()` return type conflicts with the base `PlanNode.getType()`). I used `(node as Partial<Pick<X, 'is<X>Capable'>>)` instead — still typed (never `any`), still tied to the interface (rename the brand and the guard stops compiling), and it sidesteps the method-signature conflict by picking only the brand field. Confirm this is an acceptable equivalent.

2. **Stream/Hash aggregate is a real behavior change that I argue is neutral — please verify the argument.** The old duck-typed `isAggregating` matched **only** `AggregateNode`: `StreamAggregateNode`/`HashAggregateNode` never had `getGroupingKeys`/`getAggregateExpressions`, so the guard returned `false` for them. The ticket's narrative asserts all three were "duck-matched" — that was **not** true of the code as written. Per the ticket's explicit, repeated instruction to brand all three and include them in the positive set, I added `implements AggregationCapable` + the five missing methods to Stream/Hash, which flips `isAggregating(streamAgg/hashAgg)` from `false` to `true`. I argue this is behavior-neutral because:
   - `rule-aggregate-streaming` (the only rule that *converts* on `isAggregating`) is registered in `RULE_MANIFEST` with `nodeType: PlanNodeType.Aggregate`, so it never runs on a physical aggregate node → no re-fire/re-conversion.
   - `rule-fanout-lookup-join` (the only place `isAggregating` is called on arbitrary subquery roots) runs in the **Structural** pass, which precedes the **Physical** pass that creates Stream/Hash — so at fanout time an aggregate subquery root is still the logical `AggregateNode`. Branding the physical forms only makes that rule's own defensive comment ("robust to pass ordering… may still be logical") genuinely true, and removes a latent crash: the post-loop `root.getGroupingKeys()` now exists on the physical forms too.
   - Golden plans showed no diff, consistent with neutrality.
   The `requiresOrdering()`/`canStreamAggregate()` values I gave the physical nodes (Stream: `true`/`true`; Hash: `false`/`false`) are sensible but **never consumed** (the only reader is the nodeType-gated `rule-aggregate-streaming`). If the reviewer disagrees that Stream/Hash *should* be aggregation-capable, the alternative is to brand `AggregateNode` only — but that contradicts the ticket's stated design decision.

3. **Behavior-preservation tests use minimal `as any` mock constructor args.** The real nodes are constructed with lightweight mock sources / `{} as any` schemas because those args are consumed lazily (or not at all) by the constructors, and the guards read only the brand. This tests the brand/guard wiring, not full node semantics — sufficient for detection, but it is *not* an integration test. If any of those constructors later starts eagerly touching its args, these tests would need real fixtures. `TableReferenceNode`/`SeqScanNode` are the most exposed (constructed with `{} as any` schema/module/filterInfo).

4. **`canCombinePredicates` / `PredicateCombinable` has no implementers.** No node class implements it, so the guard is always `false` — same as before branding (behavior preserved). It is branded and ready; a future combinable node must set `isPredicateCombinableCapable`.

5. **Two "rejects" tests changed intent.** `isColumnReference rejects relational nodes` and `isColumnBindingProvider rejects a non-function member` were guarding the *old* duck-typed failure modes (scalar-vs-relational confusion; a same-named string member). Under branding those failure modes can't occur, so the tests now assert the simpler, stronger property "a node without the brand is rejected even with look-alike fields." Confirm that reframing is acceptable (the original defenses are subsumed by the brand, not lost).

6. **Docs intentionally untouched.** The convention doc's stale "never use `instanceof`" guidance and any `docs/optimizer.md` mention of duck-typed detection are **not** corrected here — the ticket defers that (and a lint rule to enforce the standard) to the follow-up `3.1-planner-discrimination-doc-and-lint`, already queued in `implement/`.

## Suggested adversarial checks

- Grep for any capability interface that has an `implements` on a class **without** a matching brand initializer — `tsc` should already reject this, but confirm no class slipped through via a structural (non-`implements`) satisfaction.
- Confirm no node class accidentally carries a brand it should not (over-branding → false positive). In particular verify `ScalarFunctionCallNode` does **not** carry `isAggregateFunctionCapable`, and that a physical table-access node is `isTableAccess` but **not** `isColumnBindingProvider` (only `TableReferenceNode` is).
- Re-run `yarn test` after any edit to a branded node to catch a golden-plan regression from a detection change.
