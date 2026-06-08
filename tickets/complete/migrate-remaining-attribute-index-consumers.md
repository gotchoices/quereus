description: Second/final pass of the DRY migration from ad-hoc `findIndex(a => a.id === …)` attribute-index scans to the cached `RelationalPlanNode.getAttributeIndex()` surface. No-behavior-change cleanup across optimizer rules + analysis. Reviewed and completed.
files: packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/rules/join/equi-pair-extractor.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts, packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts, packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts
----

## Summary

Completed the DRY migration started in `migrate-attribute-index-consumers`. Ten ad-hoc linear `attrs.findIndex(a => a.id === id)` scans across optimizer rules + analysis were replaced with the cached `getAttributeIndex().get(id) ?? -1` surface (defined `planner/nodes/plan-node.ts:494`). Pure consistency/DRY change; the `?? -1` preserves the legacy `-1` miss sentinel exactly.

## Review findings

### Scope of review

Read the implement diff (`49e6e7b2`) first with fresh eyes, then the handoff. Verified the core invariant, every migrated call site's miss-semantics, the two sites that retain the array variable, the three "intentionally left" decisions, and re-ran build/lint/test. Swept the whole `planner/` tree for residual `findIndex(... .id === ...)` scans.

### Correctness — checked, sound

- **Core invariant.** `getAttributeIndex()` builds `map.set(attrs[i].id, i)` in order, so for a present id it returns the same index as `findIndex(a => a.id === id)`. The only theoretical divergence is duplicate ids (map = last-write-wins vs `findIndex` = first-match), which cannot occur because attribute ids are unique within a node's output. `?? -1` reproduces the `-1`-on-miss sentinel; every migrated caller previously branched on `>= 0`/`< 0`/`=== -1`, all preserved.
- **All 10 migrated sites verified** individually against their old form: constraint-extractor (2 scans), equi-pair-extractor (2), rule-join-physical-selection, rule-lateral-top1-asof, rule-aggregate-streaming (incl. the `isOrderedForGrouping` signature change `readonly {id}[]` → `ReadonlyMap`), rule-aggregate-predicate-pushdown, rule-orderby-fd-pruning, rule-monotonic-window, rule-grow-retrieve.
- **Retained-array sites are correct.** `createSortForEquiPairs` (`attrs[idx]`) and `rule-monotonic-window` (`sourceAttrs[o.column]`) keep the array because they do index→attr lookups (opposite direction). `rule-aggregate-predicate-pushdown` keeps `sourceAttrs` because `rewriteOutputToSource` does `sourceAttrs.find(...)` (lines 105/172/192) — a different lookup shape returning the `Attribute`, legitimately out of scope.
- **"Intentionally left" decisions are sound.** `physical-utils.deriveOrderingFromMonotonicOn` has zero callers (verified) and a raw `{id}[]` param. `key-utils.deriveProjectionColumnMap` not only takes raw attrs but its doc explicitly relies on **first-occurrence-wins** semantics (line 108) — migrating to the last-write-wins map would be a *behavior change*, so leaving it is strictly correct, not just convenient.

### Minor — fixed inline this pass

- **Under-documented surviving scans.** The handoff's "intentionally left" list omitted two *other* `findIndex(a => a.id===)` scans in `physical-utils.ts`: `extractOrderingFromSortKeys` (line ~39, raw `{id}[]`, directly unit-tested against bare arrays in `framework.spec.ts`, called from `sort.ts` + `rule-grow-retrieve.ts`) and `getColumnIndex` (line ~67, raw `Array<{id}>`, no live callers). The *decision* to leave them is consistent with the established rule (exported raw-array helpers with direct array unit-tests stay; only node-local private scans migrate — which is why `isOrderedForGrouping` was migrated but these were not). Leaving them silent, however, broke the first-pass invariant that every surviving scan carries a one-line justification. **Fix:** added the same explanatory comment to both sites so a future "is the migration done?" sweep is trivial. Lint re-run clean.

### Observed, pre-existing — no action

- `createSortForEquiPairs` does `attrs[idx]` then reads `.name`; on a missing id (`idx === -1`) this is `attrs[-1] === undefined` → throw. **Identical** in old and new code (both index `attrs[-1]`), and this path only runs on equi-pair attr ids that are guaranteed present in the source. Latent, not introduced here, not worth a ticket.

### Major findings

None. No new fix/plan/backlog tickets filed.

### Docs

`getAttributeIndex()` was already documented on `PlanNode` by the first pass; verified the docstring (plan-node.ts:488) still reflects reality. No user-facing or `docs/` changes warranted for a no-behavior-change refactor.

### Tests

No new tests added — this is a no-behavior-change refactor whose regression net is the existing optimizer/planner suite, including the direct unit tests of the helpers I confirmed stay (`framework.spec.ts`). Happy/edge/error/miss paths are exercised by that suite.

## Verification

- `yarn workspace @quereus/quereus run build` — clean (EXIT=0).
- `yarn workspace @quereus/quereus run lint` — clean (EXIT=0), re-run after the inline comment edits (EXIT=0).
- `yarn workspace @quereus/quereus run test` — **3637 passing, 9 pending, EXIT=0**.
- `yarn test:store` (LevelDB path) **not run**: planner-only, store-agnostic change; slow store suite deferred to CI/human per agent-runnable guidance.
