description: When a query named a WITH query twice under the same name, the planner reused one internal reference for both mentions, so the engine thought it was used once and ran it per mention, and a nested WITH reusing an outer WITH's name could read the outer one's rows. Each mention now gets its own reference; review the fix and its one intended behaviour change.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/building/select.ts  # buildFrom non-recursive CTE branch: one CTEReferenceNode per mention
  - packages/quereus/src/planner/planning-context.ts  # cteReferenceCache field removed
  - packages/quereus/src/planner/building/expression.ts  # subquery / IN / EXISTS no longer copy the cache; pass ctx straight through
  - packages/quereus/src/planner/building/schema-authored-context.ts  # no longer clears the cache; fast path simplified
  - packages/quereus/src/planner/stored-body-context.ts  # no longer clears the cache
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/derived-row-validator.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # shouldMaterializeCTE doc comment
  - packages/quereus/src/planner/building/with.ts  # data-modifying CTE comment + NOTE
  - docs/optimizer.md
  - docs/runtime-caching.md
  - packages/quereus/test/logic/07.8.2-subquery-selecting-outer-column.sqllogic
  - packages/quereus/test/logic/13.4-cte-extras.sqllogic
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts
  - packages/quereus/test/view-cte-isolation.spec.ts
repro: verified
----

## What changed

`buildFrom` (`packages/quereus/src/planner/building/select.ts`) used to keep a statement-wide `cteReferenceCache` keyed by `"<cteName>:<alias>"` and hand every FROM mention with the same key the same `CTEReferenceNode`. That caused two defects:

- **Undercount.** Two mentions sharing one reference node gave the `CTENode` one parent, so `MaterializationAdvisory` saw one reference, did not mark it `materialize`, and each mention ran the body separately (`random()` differed between mentions).
- **Name collision across WITH clauses.** The key had no notion of which WITH clause defined the name, so a nested `with c` and an outer `c` shared one entry; whichever was built first won.

The cache is gone. Each non-recursive FROM mention builds `new CTEReferenceNode(parentContext.scope, cteNode, fromClause.alias)`. All mentions still point at the one `CTENode` from `cteNodes`, so the advisory's per-descriptor parent count is now the number of mentions, and `emitCTE`'s descriptor-keyed buffer is still shared.

The `cteReferenceCache` field was removed from `PlanningContext`, so TypeScript rejects any context factory that sets it. Removed from three src factories (`database.ts`, `derived-row-validator.ts`, `schema/manager.ts`), the two isolation contexts (`storedBodyContext`, `schemaAuthoredContext`), the three subquery contexts in `expression.ts` (which now pass `ctx` directly, since the spread existed only to carry the cache; I grepped for in-place mutation of planning contexts and found none), and 15 hand-built contexts in test specs. Also removed the now-unused `logger` in `select.ts` and the unused `CTEReferenceNode` type import in `planning-context.ts`.

## Intended behaviour change

A body that reads the outer row (correlated) and is mentioned twice under one name is now counted as two references, so:

- recursive: `(with recursive c(x) as (select t.b union all …) select (select max(x) from c) + (select min(x) from c))` is now refused with `Recursive CTE 'c' reads a column of an outer query …` — the same refusal the self-join form already got. Before, it passed only because of the shared node, and only because its two subqueries happened to run one after the other.
- non-recursive, non-deterministic: `(with c as (select t.b + random() as x from u) select (select max(x) from c) + (select min(x) from c))` is now refused with `CTE 'c' reads a column of an outer query`, which is what `docs/runtime-caching.md` already said should happen.

The lifting path (a CTE buffer scoped to one run of the enclosing correlated subquery) is out of scope, as the ticket decided.

## Tests

- `07.8.2-subquery-selecting-outer-column.sqllogic`: the recursive one-name case moved from the "allowed" section to the "Refused" section, next to the recursive self-join case, now expecting the error. Added the non-deterministic one-name case after the two-alias non-deterministic case, expecting the error.
- `13.4-cte-extras.sqllogic`: two shadowing cases (scalar subquery after outer mention; FROM-clause subquery) pinning that a nested WITH reusing an outer name reads its own rows and the outer mention reads the outer rows. One `random()` case pinning that two mentions under one name see one stored value (`same = true`). I added only two of the ticket's three shadowing statements: the dropped one is the scalar-subquery case with the order reversed, which is the same collision as the first.

I did not re-run the new 13.4 cases against the old code in this session (no reverting the tree); the ticket's fix stage verified that these statements fail with the cache in place.

## Validation

- `yarn test` in `packages/quereus`: 11135 passing, 26 pending, 0 failing.
- `yarn lint` in `packages/quereus` (eslint + `tsc -p tsconfig.test.json`): clean.
- Not run: `yarn test:store`.

## Comments and docs reworded

The undercount claims were removed or turned into history in: `materialization-advisory.ts` (`shouldMaterializeCTE` doc), `with.ts` (data-modifying CTE comment; the streaming NOTE now says buffering could become conditional on reference count while still overriding `NOT MATERIALIZED`), `docs/optimizer.md` (data-modifying CTE bullet), `docs/runtime-caching.md` (new sentence in § Shared CTE materialization that each FROM mention gets its own reference node; the recursive-CTE bullet now says one-name mentions are refused like a self-join), `13.6-cte-dml-runs-once.sqllogic` header, `cte-dml-plan-shape.spec.ts` header, `view-cte-isolation.spec.ts` header and the third-leak-channel comment, and the doc comments of `storedBodyContext` / `schemaAuthoredContext`.

## Things a reviewer might check

- The cache's original comment claimed it kept "consistent attribute IDs across multiple references". The full suite passing is the evidence that nothing relies on two mentions sharing attribute IDs; each mention binds through its own `registerColumnScope`.
- Plan size: a CTE mentioned N times now has N `CTEReferenceNode` parents instead of fewer. Each reference already emitted its own copy of the body subtree, so emitted code size should be unchanged for distinct aliases; it grows only for the one-name case that previously (wrongly) shared.
- `schemaAuthoredContext`'s identity fast path now checks only `cteNodes` and `schemaPath`.
