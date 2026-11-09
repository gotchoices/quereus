description: When a query named a WITH query twice under the same name, the planner reused one internal reference for both mentions, so the engine thought it was used once and ran it per mention, and a nested WITH reusing an outer WITH's name could read the outer one's rows. Each mention now gets its own reference.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/planning-context.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/src/planner/building/schema-authored-context.ts
  - packages/quereus/src/planner/stored-body-context.ts
  - packages/quereus/src/planner/building/with.ts
  - packages/quereus/src/planner/cache/materialization-advisory.ts
  - docs/optimizer.md
  - docs/runtime-caching.md
  - packages/quereus/test/logic/07.8.2-subquery-selecting-outer-column.sqllogic
  - packages/quereus/test/logic/13.4-cte-extras.sqllogic
repro: verified
----

## Summary

`buildFrom` (`packages/quereus/src/planner/building/select.ts`) used to keep a statement-wide cache of `CTEReferenceNode`s keyed by `"<cteName>:<alias>"`, so two FROM mentions under one name shared one reference node. The materialization advisory then counted one reference and did not store the body's rows once (each mention re-ran it, so `random()` differed between mentions), and a nested WITH that reused an outer WITH's name collided with it on the same cache entry.

The cache (`PlanningContext.cteReferenceCache`) was removed. Each non-recursive FROM mention now builds its own `CTEReferenceNode` over the one shared `CTENode`, so the advisory's per-descriptor parent count equals the number of mentions and `emitCTE`'s descriptor-keyed buffer is still shared. All context factories (src and test specs) stopped setting the field; the three subquery contexts in `expression.ts` pass `ctx` through directly, since their spread existed only to carry the cache.

Intended behaviour change: a correlated body mentioned twice under one name now counts as two references, so the recursive one-name case and the non-deterministic one-name case are refused with the same `UNSUPPORTED` errors the two-alias / self-join forms already got. Pinned in `07.8.2-subquery-selecting-outer-column.sqllogic`. Shadowing and one-stored-value cases pinned in `13.4-cte-extras.sqllogic`.

Landed in `ticket(implement): bug-cte-mentioned-twice-under-one-name-runs-twice`.

## Review findings

- **Correctness of the core change** — read `select.ts` `buildFrom`: the recursive-reference branch (`InternalRecursiveCTERefNode`) is untouched; the non-recursive branch now mints a fresh `CTEReferenceNode` per mention. `CTEReferenceNode.buildAttributes` already mints fresh attribute ids per instance, so the old sharing actually put two `cte_ref` context slots with the same attribute ids into one statement when the mentions sat in separate subqueries; removing it removes that hazard too. The old cache's claimed purpose ("consistent attribute IDs") is not relied on anywhere: no other `new CTEReferenceNode` site exists outside `withChildren` (which preserves ids). Nothing found.
- **Context identity / in-place mutation** — the deleted `parentContext.cteReferenceCache = new Map()` was the only in-place mutation of a planning context in `src/planner` (grepped `(ctx|context|parentContext)\.<field> = `; only `plan-validator.ts` sets `context.provenance` on its own validation context). No `WeakMap`/identity check keyed on `PlanningContext`, so passing `ctx` straight into subquery builders instead of a spread copy is safe. Nothing found.
- **Leftover references** — `cteReferenceCache` now appears only in stale `dist/` build output; no src, test or docs hits. Grepped docs and source comments for remaining "undercount" / "same alias shares one reference" claims; the only remaining mentions are the deliberately historical ones in `13.6-cte-dml-runs-once.sqllogic` and `cte-dml-plan-shape.spec.ts`. Nothing to fix.
- **Behaviour interactions** — reasoned through: a non-correlated CTE named at top level and again inside a correlated subquery now counts 2 and is buffered once per statement instead of re-running per outer row (faster, same results); a correlated deterministic body named twice under one name re-runs per reference (functional), as the two-alias form already did. The newly refused shapes are the intended change and are documented in `docs/runtime-caching.md` and `docs/optimizer.md`. No regression found.
- **Docs** — read the touched sections of `docs/runtime-caching.md` and `docs/optimizer.md`, and the doc comments of `storedBodyContext`, `schemaAuthoredContext`, `shouldMaterializeCTE` and the data-modifying CTE comment/NOTE in `with.ts`; all reflect the new reality. The `with.ts` NOTE (streaming a data-modifying CTE's RETURNING set) remains a valid tripwire with an updated revisit path. No other doc describes the cache.
- **Tests** — the new sqllogic cases each pin a named behaviour (one-name refusal for recursive and non-deterministic bodies, nested-WITH shadowing in both scalar and FROM positions, one stored value across two same-name mentions); none restates the implementation. No tests cut, none added. I did not re-run the new 13.4 cases against the pre-fix code (that would require reverting the tree); the fix stage verified they failed with the cache in place.
- **Hygiene** — removed unused logger/import were the right cleanup; lint is clean. Nothing found.
- **Performance / resource cleanup** — plan gets one `CTEReferenceNode` per mention; each reference already emitted its own body copy, so emitted size changes only for the previously-shared one-name case. No measured concern; nothing filed.
- **Validation** — `yarn lint` in `packages/quereus`: clean. `yarn test` in `packages/quereus`: 11135 passing, 26 pending, 0 failing. Not run: `yarn test:store` (the change is planner-only and storage-independent).
- **Tickets filed / tripwires added** — none; no major or conditional findings.
