description: Make a leading-WITH CTE name a real DML write target — `update <cte>`, `insert into <cte>`, `delete from <cte>` route the CTE body through the existing view-mutation substrate (the same predicate-driven updateability framework a named view uses). No grammar change (a CTE name already parses as a bare identifier); this is pure resolution/routing plus an `ephemeral` flag on the view-like adapter.
prereq:
files:
  - packages/quereus/src/planner/building/insert.ts                 # ~475 target dispatch (getView/getMaintainedTable) — add CTE-target resolution before it
  - packages/quereus/src/planner/building/update.ts                 # ~69 same; also must build stmt.withClause into the context (today ignored)
  - packages/quereus/src/planner/building/delete.ts                 # ~70 same; also must build stmt.withClause into the context (today ignored)
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # ~44 buildViewMutation: guard recordDependency + validateMutationTags on the new ephemeral flag
  - packages/quereus/src/planner/mutation/single-source.ts          # ~58 MutableViewLike: add `ephemeral?: boolean`
  - packages/quereus/src/planner/building/select-context.ts         # buildWithContext — generalize so update/delete can reuse it to thread CTEs into scope
  - packages/quereus/src/planner/building/with.ts                   # buildWithClause — used to materialize the CTE plan nodes for reads
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts    # `recursive-cte` reason already exists
  - docs/view-updateability.md                                      # L668 § CTEs and Subqueries; L81 prose — make true for the CTE-name target
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic         # add a CTE-target law block alongside the existing view round-trip cases
difficulty: hard
----

# CTE name as a DML write target

## What this delivers

`with t as (select id, color from base) update t set color = 'x' where id = 1`
writes through to `base` **exactly as the equivalent named view would** — and the
same for `insert into t …` and `delete from t …` over a decomposable CTE body.
The equivalence to a named view is the acceptance bar: a CTE body that is
structurally a single-source projection-and-filter must produce a byte-identical
base-op plan to `create view t as (select id, color from base)` followed by the
same DML against `t`.

This ticket covers **only the CTE-name target** (`update <cte>` /
`insert into <cte>` / `delete from <cte>`). The inline subquery target
(`update (select …) as v …`) is the chained ticket `inline-subquery-dml-write-target`,
which reuses the ephemeral view-like routing this ticket introduces.

## Why no grammar change

The three DML productions already parse their target through `tableIdentifier()`
(parser.ts ~422 / ~2296 / ~2356), which yields an `IdentifierExpr`. A CTE name
*is* an identifier, so `update t …` already parses. The only gap is **resolution**:
the builders today dispatch the target through `getView` / `getMaintainedTable` /
`buildTableReference` (schema-manager lookups), none of which know about CTEs, so a
CTE name falls through to a "table not found" miss. The fix is to intercept the
target against the statement's own `withClause` **before** that schema dispatch.

## Design

### 1. `MutableViewLike.ephemeral`

`buildViewMutation` (view-mutation-builder.ts) is the single funnel for every
view-/MV-mediated write. It works purely off `MutableViewLike` (`name`,
`schemaName`, `selectAst`, `columns?`, `tags?`, `noun?` — single-source.ts ~58).
A CTE/subquery target is structurally the same adapter with **no backing schema
object**. Add:

```ts
export interface MutableViewLike {
  // … existing fields …
  /** True when this view-like is a CTE body or inline FROM-subquery, NOT a
   *  schema-registered view/MV. Suppresses the schema-dependency recording and
   *  view-tag validation in buildViewMutation (there is no schema object to
   *  depend on or carry tags), and signals diagnostics to use `noun`. */
  readonly ephemeral?: boolean;
}
```

In `buildViewMutation`, guard the two schema-object-coupled steps on it:

- `validateMutationTags(view, req.stmt)` — an ephemeral view-like carries no
  `tags`, so skip it (it is keyed on a schema view's reserved tags).
- `ctx.schemaDependencies.recordDependency({type:'view', schemaName, objectName}, view)` —
  skip for ephemeral. There is no schema object; recording a `view` dependency on a
  non-existent `<schema>.<cteName>` would spuriously invalidate the cached plan if a
  real view of that name were later created, and there is nothing to invalidate
  *on* (the CTE body is part of the statement, re-planned every run anyway).

Every other step in `buildViewMutation` already degrades correctly for an
ephemeral target: each `getLensSlot(view.name)` / `getMaintainedTable` /
`decompositionStorage` lookup returns `undefined` for a name with no schema
object, so the lens-constraint collectors return `[]`, `isLensWrite` is `false`,
and the single-source spine is taken. **Verify** this in code, do not assume —
in particular confirm `decompositionStorage` and `isSetOpMembershipBody` are
`undefined`/`false` for a plain projection-filter CTE body so the single-source
path is reached.

### 2. Shared CTE-target resolver

Add a small helper (suggested: a new `planner/building/dml-target.ts`, or co-located
in view-mutation-builder.ts) reused by all three builders:

```ts
/** Resolve a DML target identifier against the statement's own WITH clause.
 *  Returns an ephemeral MutableViewLike over the named CTE's body, or undefined
 *  when the target is not a CTE (a schema table / view / MV — unchanged dispatch).
 *  Rejects a recursive-CTE target with the structured `recursive-cte` diagnostic. */
function resolveCteTarget(
  ctx: PlanningContext,
  table: AST.IdentifierExpr,
  withClause: AST.WithClause | undefined,
): MutableViewLike | undefined
```

Behavior:

- Return `undefined` if there is no `withClause`, or if `table.schema` is set (a
  schema-qualified name can never be a bare CTE reference).
- Look up `table.name.toLowerCase()` in `withClause.ctes`. Miss → `undefined`.
- **Recursive reject.** If the matched CTE is recursive — `withClause.recursive`
  is true **and** the CTE body self-references (its name appears in its own body's
  FROM, i.e. the compound/self-referential shape `buildRecursiveCTE` in with.ts
  detects) — raise `raiseMutationDiagnostic({ reason: 'recursive-cte', table: name,
  message: … })`. A `with recursive` clause whose *target* CTE happens to be a
  plain non-self-referential member is still writable, so gate on actual
  self-reference, not merely the `recursive` keyword. Reuse with.ts's recursion
  detection rather than re-implementing a body walk.
- Otherwise construct and return:
  ```ts
  {
    name: cte.name,
    schemaName: ctx.schemaManager.getCurrentSchemaName(),
    selectAst: cte.query,            // the CTE body QueryExpr
    columns: cte.columns,            // declared `with t(a,b) as …` names, if any
    ephemeral: true,
    noun: 'common table expression',
  }
  ```
  `schemaName` is cosmetic for an ephemeral target (only lens/dependency lookups
  read it, and both are now suppressed/return undefined); the current schema name
  keeps any leaked diagnostic readable.

### 3. Wire into the three builders

In each of `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt`, **before**
the existing `getMaintainedTable` / `getView` dispatch:

```ts
const cteTarget = resolveCteTarget(ctx, stmt.table, stmt.withClause);
if (cteTarget) {
  return buildViewMutation(ctxWithCtes, cteTarget, { op, stmt });
}
```

`ctxWithCtes` must have the statement's CTEs in scope so that (a) a sibling-CTE
read inside the user `where` / `set` / source resolves, and (b) the
self-reference / Halloween discipline below holds. `buildViewMutation` /
`propagate` re-plan the lowered **base** ops against the base table directly
(`buildTableReference` → `resolveTableSchema`, which never consults CTEs — verified
in table.ts:28), so the CTE never shadows the base op's own target; the CTEs are
needed only for the *user-authored* expressions descended onto those ops.

- **insert.ts:** the target dispatch is at ~475. `stmt.withClause` is already
  consumed at ~597 to build `parentCtes` for the *source* SELECT — that path is
  unchanged. Add the CTE-target check above the dispatch. The CTE target body is
  re-planned by the substrate (not as a read), so insert needs no new scope
  threading for the target itself.
- **update.ts / delete.ts:** these builders **ignore `stmt.withClause` today** —
  CTEs are never built into their context, so even a CTE *read* in an UPDATE/DELETE
  `where` subquery does not resolve currently. Build the WITH clause into the
  context and thread it, mirroring `buildWithContext` (select-context.ts): generalize
  that helper's parameter from `AST.SelectStmt` to `{ withClause?: AST.WithClause }`
  (it only reads `stmt.withClause`), call it, and use the returned
  `contextWithCTEs` as the planning context for both the target resolution and the
  WHERE/SET build. This closes the read gap as a side effect (note it in the PR).

### Resolution-order decision (settled)

A CTE name **shadows** a same-named schema table / view / MV as a write target,
matching SQL read semantics (a CTE shadows a base table in FROM). Therefore the
`resolveCteTarget` check runs **first**, ahead of `getView` / `getMaintainedTable` /
`buildTableReference`. Document this in docs/view-updateability.md § CTEs. No
warning is emitted for the shadow (consistent with read-side shadowing, which is
silent).

## Edge cases & interactions

- **CTE shadowing a real table/view as the write target.** `with base as
  (select id, color from base) update base set color='x'` — the CTE `base` shadows
  the real `base` as the *target*, but the lowered base op still targets the real
  `base` table (resolved via the schema manager, not CTEs). Test that the write
  lands on the real table and the user predicate is rewritten through the CTE
  body's lineage. This is the load-bearing self-reference case.
- **CTE read in the same statement (Halloween / self-reference).** `with t as
  (select id,color from base) update t set color='x' where id in (select id from
  t)`. The substrate's eager-capture discipline (the same one views use) must
  apply; confirm the read of `t` is captured before the base op mutates. If the
  capture discipline does not reach a CTE-sourced read, document and test the
  resulting behavior — do not silently produce a Halloween-unsafe plan.
- **Recursive CTE target** → `recursive-cte` structured reject (never a generic
  "table not found"). Test `with recursive r as (select 1 as n union all select
  n+1 from r where n<3) update r set n=0`.
- **Non-decomposable CTE body** (aggregate / DISTINCT / LIMIT / GROUP BY / window)
  → the *same* structured diagnostic the equivalent view body raises
  (`unsupported-body` / `no-inverse` / etc. from `analyzeView`), reached through the
  new target kind. Test parity: the diagnostic `reason` for `update <cte over
  aggregate>` must equal the one for `update <view over the same aggregate>`.
- **CTE body that references another CTE** (`with a as (…), t as (select * from a)
  insert into t …`). The substrate's base-lineage walk will hit `a` as a non-base
  FROM source. v1 boundary: this rejects with `no-base-lineage` (or inlines if the
  substrate already handles it). Pin whichever the substrate actually does as the
  documented v1 behavior; a transparent multi-level inline is out of scope (park in
  backlog if a test demands it).
- **Multi-source (join) CTE body as UPDATE/DELETE target.** Views already support
  this; confirm it composes unchanged through `resolveCteTarget` (the substrate's
  `isJoinBody` path fires off `view.selectAst`). One positive test that a
  key-preserving two-table join CTE updates the intended side.
- **Compound / set-op-bodied CTE target** — out of scope here (membership-routed
  set-op writes are their own substrate); it should reach the existing set-op
  reject/route off `selectAst`. Do not special-case; just confirm no crash and a
  structured outcome.
- **`with schema` / `with context` / `with tags` on a CTE-targeted DML.** These
  trailing/leading clauses are statement-level and already parsed onto the stmt;
  confirm they still validate at the dml-stmt site and thread to the lowered base
  ops (mutation context especially). The leading `with t as (…)` and a `with
  context (…)` must not collide in the parser (they are distinct WITH forms — the
  CTE WITH is the statement-leading one, context/tags are the post-target ones).
- **Schema-qualified target** `update main.t` where `t` is a CTE — `table.schema`
  is set, so `resolveCteTarget` returns undefined and it dispatches as a schema
  object (a CTE is never schema-qualified). Test that `main.t` does NOT resolve to
  the CTE.
- **Plan-cache invalidation.** Because ephemeral targets record no schema
  dependency, confirm a CTE-target DML is not wrongly cached against a later
  `create view t` (it should re-plan from its own AST each run). Add to the
  view-dependency-invalidation reasoning if a test exists there.

## Tests (TDD targets)

- `93.4-view-mutation.sqllogic` (or a new sibling): a **CTE Round-Trip Law** block
  mirroring the existing view round-trip cases — for a single-source
  projection-filter CTE, assert `update t` / `insert into t` / `delete from t`
  produce the same observable base-table state as the equivalent named view.
- Reject-parity cases: `update <cte over aggregate>` and `update <recursive cte>`
  assert the exact diagnostic `reason` strings.
- A self-reference (`where id in (select id from t)`) write-through correctness
  case.

## TODO

### Phase 1 — adapter + funnel guards
- [ ] Add `ephemeral?: boolean` to `MutableViewLike` (single-source.ts).
- [ ] In `buildViewMutation`, guard `validateMutationTags` and
  `recordDependency` on `!view.ephemeral`; verify all downstream
  lens/decomposition/set-op lookups degrade to undefined/false for an ephemeral
  single-source body.

### Phase 2 — resolver
- [ ] Implement `resolveCteTarget` (no withClause / schema-qualified → undefined;
  name miss → undefined; recursive self-reference → `recursive-cte` reject; else
  ephemeral view-like). Reuse with.ts recursion detection.

### Phase 3 — wire builders
- [ ] insert.ts: add the CTE-target check above the getView dispatch (~475).
- [ ] Generalize `buildWithContext` to accept `{ withClause? }`; use it in
  update.ts and delete.ts to thread the statement's CTEs into the build context,
  then add the CTE-target check above their getView dispatch (~69 / ~70).

### Phase 4 — docs + tests
- [ ] Make docs/view-updateability.md § CTEs and Subqueries (L668) and the L81
  prose true for the CTE-name target; document the CTE-shadows-table resolution
  order and the multi-level-CTE-body v1 boundary.
- [ ] Add the CTE Round-Trip Law block + reject-parity + self-reference tests.
- [ ] `yarn workspace @quereus/quereus test` green; `yarn lint` clean.
