description: Close the subquery-source arm of the lens override basis-source check. `validateOverrideBasisSources` only walks top-level `table`/`join` FROM nodes, so a cross-basis table buried in a subquery source (`from (select * from Z.Foo)`) is NOT rejected when the override covers every logical column explicitly (no gap-fill to trip the basis-reachability error). The body then silently re-anchors the lens off its declared `over Y` basis — the exact failure class the deploy-time basis-source validation exists to prevent.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-overrides.spec.ts, docs/lens.md
----

## Problem

`lens-override-body-shape-validation` added `validateOverrideBasisSources` (lens-compiler.ts), which rejects an override whose FROM names a `table` (or join leg) qualified with a schema other than the declared basis. The walk handles `table` and `join` nodes only; `subquerySource` / `functionSource` are treated as opaque and skipped.

The implementer's stated mitigation — "a cross-basis table hidden in a subquery is left to the existing gap-fill error path" — only holds when some logical column is left **uncovered**. A subquery-source override that covers every logical column explicitly produces no gap-fill, so no error fires and the body re-anchors silently.

Confirmed reproduction (schemas `y` and `z` both exist; lens is `over y`):

```sql
declare schema y { table CarCore { id integer primary key, speed integer } }
apply schema y;
declare schema z { table CarCore { id integer primary key, speed integer } }
apply schema z;
declare logical schema x { table Car { id integer primary key, speed integer } }
declare lens for x over y { view Car as select id, speed from (select * from z.CarCore) sub }
apply schema x;   -- deploys WITHOUT error; reads z.CarCore, not the y basis
```

This is narrow (requires an explicit subquery source naming a different *existing* schema, and full coverage) and is a pre-existing hole that the v1 ticket explicitly scoped out — not a regression. But it defeats the soundness guarantee of the top-level check and should be closed.

## Expected behavior

A subquery (or function) source whose body references a relation outside the declared basis is rejected at deploy/parse time, with a message consistent with the top-level `references basis relation '<schema>.<table>' outside the declared basis` wording.

## Design notes / scope

- Extend the FROM walk to descend into `subquerySource` inner SELECT FROM trees and apply the same basis-schema check. A function source's argument subqueries (if any) should be considered too.
- **CTE / alias hazard:** a nested subquery may define its own `with` CTEs or reference outer aliases; those names are not basis relations and must not be flagged. The walk needs to thread the set of in-scope CTE names (and skip non-`table` sources it cannot resolve) rather than naively treating every `table` node as a basis reference. This is why it was deferred from v1 — it is a real recursive-scope walk, not a one-line addition.
- Consider whether to unify with `collectOverrideSources` (which already flags opaque sources via `hasOpaqueSource`) or keep a dedicated validator — the v1 author deliberately kept them separate because `collectOverrideSources` is also used where cross-basis is legitimate (`deriveRelationBacking`, `validateOverrideAdvertisementConflict`).
- Add a regression test asserting the reproduction above throws, plus a positive test that a subquery source over the *basis* schema (`from (select * from y.CarCore)`) still deploys.

## Reference

Code comment marking the gap: `validateOverrideBasisSources` docstring in `packages/quereus/src/schema/lens-compiler.ts` (references this slug). Docs note: docs/lens.md § "v1 override body-shape restrictions".
