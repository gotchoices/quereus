description: Admit an **arbitrary** assigned value (cross-member read, embedded subquery, or a mixed anchor+self expression) in a decomposition **optional columnar** UPDATE by building a single-identity (anchor-key) per-row capture that reuses the multi-source `__vmupd_keys` substrate, and emitting a matched-UPDATE + filtered-materialize-INSERT pair whose value is read back from the capture. Removes the columnar `arbitrary` reject. EAV is the prereq-chained follow-up (`view-write-decomposition-update-captured-eav`).
prereq:
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/view-updateability.md, docs/lens.md
----

## Problem

Writing an optional columnar decomposition member with a value that is neither anchor-resolvable
nor a pure member self-reference currently rejects `unsupported-decomposition-update`
(`lowerMaterializedValue`, decomposition.ts ~940-945; and the `hasAnchor && hasSelf` reject in
`emitOptionalMemberUpdate` ~1066-1072). The rejected shapes:

```sql
update x.T set c = b + 1     where id = 7;  -- cross-member read (b on T_b, c on T_c)
update x.T set c = c + a     where id = 7;  -- mixed anchor + member self
update x.T set c = (select max(v) from other) where id = 7;  -- embedded subquery
```

These are deferred because the matched-UPDATE base op runs in the **member's** row scope while
the materialize-INSERT runs over the **anchor** scan; a value reading partner-base columns (a
sibling member, or the member's own pre-mutation value mixed with anchor leaves) is expressible
in neither branch directly. The multi-source cross-source `set a.x = b.y` path already solved the
identical problem with an up-front per-row capture (`multi-source.ts` § `__vmupd_keys`): every
affected row's identity + the partner values it reads are materialized **once** before any base
op fires, and each base op reads the value back via a correlated scalar read keyed by the owning
side's PK.

## Core insight

A decomposition's identity is a **single column** — the anchor key — and every member is keyed
1:1 to it by the shared stitch key. So the decomposition capture needs only **one** identity
column (`k0_0` := the anchor key) plus one `srcN` column per arbitrary value, lowered to base
terms over the **planned get body** (`anchor ⋈ members`). Because the get body **null-extends**
absent optional members, the captured value already encodes the right per-row behavior:

| value shape | absent-row captured value | desired materialize |
|---|---|---|
| `c = b + 1` (cross-member, b present) | `b + 1` (non-null) | materialize |
| `c = c + a` (mixed self+anchor)       | `null + a` → null   | stay absent  |
| `c = (select max(v) …)` returns null  | null                | stay absent  |

So a **single** emit structure handles every arbitrary value, with no need to distinguish
"anchor-flavored" from "self-flavored": mirror the existing `self` two-op shape, but source the
value from the capture and gate the materialize on the captured value being non-null at **runtime**
(not the plan-time `foldsConstantFalse` the `self` path uses — a captured value is data-dependent).

```
-- update x.T set c = b + 1 where id = 7   (T_c optional, T_b mandatory)
-- capture (materialized ONCE, pre-mutation, over the planned body):
--   __vmupd_keys = π_{T_core.id as k0_0, (T_b.b + 1) as src0}( σ_{id = 7}( T_core ⋈ T_b ⋈ T_c ) )
-- matched UPDATE (present T_c rows; reads captured by the member key):
--   update T_c set c = (select src0 from __vmupd_keys k where k.k0_0 = T_c.id)
--     where T_c.id in (select id from T_core where id = 7)
-- materialize INSERT (absent rows; reads captured by the anchor key, non-empty filtered):
--   insert into T_c (id, c)
--     select T_core.id, (select src0 from __vmupd_keys k where k.k0_0 = T_core.id)
--     from T_core where id = 7
--       and (select src0 from __vmupd_keys k where k.k0_0 = T_core.id) is not null
--     on conflict (id) do nothing
```

The matched UPDATE is **unfiltered** (so a captured-null on a matched row writes `c = null`,
observationally identical to absent under the read — a benign physical divergence from the
constant all-null DELETE fast-lane), the materialize INSERT is filtered (so no phantom null row
springs into being), and `do nothing` cedes matched rows to the UPDATE (which is emitted first).
These two ops **cannot** collapse into an upsert: the filter must suppress the absent branch
without suppressing the matched write.

## Why these collapse onto the capture

Once captured, an arbitrary value is a **per-row constant** from each base op's perspective (a
correlated scalar read of `__vmupd_keys`). Both branches read the identical pre-mutation value, so
a **both-sides write** — `update x.T set c = b + 1, b = b + 100 where id = 7` — is correct: the
capture materializes `b` (hence `c = b + 1`) **before** the `b` base op rewrites it, so `c` reads
the pre-mutation `b`. The capture also turns a volatile value (`set c = random()`) into one value
per row shared by both branches — strictly better than the inline path.

## Design — what to build

### 1. Reuse the multi-source capture primitives (multi-source.ts)

The decomposition treats the anchor as "side 0" with a single-column PK, so it reuses verbatim:
`MS_UPDATE_KEYS_CTE`, `keyColumnName(0, 0)` → `k0_0`, `MultiSourceKeyCapture`
(`{ source, descriptor, keyColumns }`), `makeMultiSourceKeyRef`, and the builder's `withKeyCapture`
+ `ViewMutationNode.identityCapture` wiring. **Export `capturedValueSubquery`** (currently
file-private, ~2353) — the decomposition read-back is `capturedValueSubquery(srcAlias, 0,
[keyColumn])` = `(select <srcAlias> from __vmupd_keys k where k.k0_0 = <keyColumn>)`, where
`<keyColumn>` is the member's own key column for the matched UPDATE, or the anchor key for the
materialize INSERT (both correlate `k.k0_0`, which holds the shared stitch-key value).

### 2. Thread the planned-body source + scope (backward-body.ts / decomposition.ts)

`buildDecompositionKeyCapture` builds plan nodes over the **already-planned** body (the dual of
`buildMultiSourceKeyCapture`, multi-source.ts:1874-1926). `analyzeBodyLineage` already plans the
body once and returns `root`; extend `BodyBackwardLineage` (and thread through `DecompShape`) with
the body's **relational source node + its scope** (`ctx.outputScopes.get(bodySource)`), mirroring
`analyzeJoinView`'s `joinNode` / `joinScope` (multi-source.ts:926-927). Generalize
`findJoinNode` to a `findBodySource(root)` that returns the join node for a columnar body **or**
the bare anchor table/retrieve node for an anchor-only body (so the EAV follow-up reuses it). The
body source scope resolves the member-relationId-qualified base columns the lowered values carry.

### 3. Capture builder (view-mutation-builder.ts)

`buildDecompositionKeyCapture(ctx, view, shape, where, capturedValues)`:
- identity predicate = `anchorPredicate(view, shape, where)` (the existing anchor-resolvable
  lowering) built as a `ScalarPlanNode` over the body scope; `FilterNode(scope, bodySource, pred)`.
- projections: `{ node: <anchorKey over scope>, alias: keyColumnName(0,0) }` followed by one
  `{ node: buildExpression({…ctx, scope}, sv.expr), alias: sv.alias }` per `CapturedDecompValue`.
- `ProjectNode(scope, filtered, projections, …, preserveInputColumns=false)`; return
  `{ source, descriptor: {}, keyColumns }` with `keyColumns` in projection order
  (`k0_0` typed as the anchor key column, each `srcN` typed `node.getType()`).

### 4. Carrier-threaded classifier + emit (decomposition.ts)

- Add `CapturedDecompValue { alias: string; expr: AST.Expression }` (or reuse multi-source's
  `CrossSourceValue` shape) and a `captured` member to `ValueKind`.
- `decomposeUpdate` (decomposition) takes an optional `capturedValues?: CapturedDecompValue[]`
  out-param + a `registerCapturedExpr(key, expr) → srcAlias` closure (mirroring
  `decomposeUpdate`'s `registerCapturedExpr`, multi-source.ts:1298-1307). Thread it into
  `lowerMaterializedValue`.
- `lowerMaterializedValue`: when the value is `arbitrary` **and a carrier is present and the owner
  is columnar**, register the lowered value (`substituteViewColumns(asg.value, shape, view)`) and
  return `{ kind: 'captured', value: <captured read-back placeholder>, isNull: false }`. The cell
  carries the registered `srcAlias`. When no carrier (the legacy `propagate` path) **or** the owner
  is EAV, keep raising `unsupported-decomposition-update` (EAV is the follow-up ticket). Keep the
  existing `constant` / `anchor` / `self` classification untouched.
- `emitOptionalMemberUpdate`: when the member group contains ≥1 `captured` cell, route the **whole
  group** through the captured two-op path (capturing every cell's value as a `srcN`, including any
  anchor/self/constant siblings — uniform, harmless). This **subsumes and replaces** the
  `hasAnchor && hasSelf` reject (~1066-1072): a mixed anchor+self value is now a captured value.
  Emit:
  - matched UPDATE via `memberUpdateOp` with each cell value = `capturedValueSubquery(srcAlias, 0,
    [singleKeyColumn(member)])`;
  - materialize INSERT modeled on `buildSelfMaterializeInsertSelect` but value =
    `capturedValueSubquery(srcAlias, 0, [anchorKey])`, WHERE = `pred AND (<OR over each cell's
    captured-by-anchorKey read-back> is not null)`, `on conflict (<memberKey>) do nothing`. **Always
    emit** the INSERT (the runtime filter — not `foldsConstantFalse` — decides per row). Reuse
    `assertNoUnassignedValueColumnWiden` + `assertNoMissingNotNull` gates verbatim.

### 5. Routing (view-mutation-builder.ts)

Parallel to the multi-source branch (lines 105-122, 164): for `req.op === 'update'` && a
decomposition (`decompositionStorage`), call the decomposition analysis once
(export `analyzeDecomposition` or a thin wrapper) to get the shape, then
`baseOps = decomposeUpdate(ctx, view, shape, req.stmt, capturedValues)`. If `capturedValues` is
non-empty, `keyCapture = buildDecompositionKeyCapture(...)` and fold it into the existing
`keyCapture` / `injectKeyRef` / `withKeyCapture` / `identityCapture` machinery (lines 164-213) —
so each base op resolves `__vmupd_keys` via the injected context-backed key ref, and the capture
materializes once before any op fires. An empty carrier (constant/anchor/self updates) builds **no**
capture and produces byte-identical base ops to today's `propagate` path. Decomposition DELETE and
INSERT routing are unchanged. Keep `propagateDecomposition`'s update path (carrier-absent) rejecting
arbitrary as the defensive legacy path, exactly as `propagateMultiSource` does.

## Residual rejects (must stay precise)

After capture, **no value shape** is genuinely inexpressible for a columnar member (any scalar over
the logical row is computable over the get body). The remaining rejects are **structural**, not
value-shape, and must keep their precise diagnostics: shared-key/identity write
(`unsupported-decomposition-update`), computed-mapping / unbacked target (`no-inverse`), composite
shared key (`unsupported-decomposition-key`), a non-anchor / subquery **WHERE**
(`unsupported-decomposition-predicate` — a separate deferred substrate, unaffected here), and the
`assertNoUnassignedValueColumnWiden` view-widen gate. Never silently widen the view image.

## Edge cases & interactions

- **Present vs absent rows** for cross-member (`c = b + 1`), mixed self+anchor (`c = c + a`), and
  subquery (`c = (select max(a) from main.T_core)`) values — matched updates, absent materializes
  only when the captured value is non-null.
- **Captured-null on an absent row** → filtered out, no phantom row (the read still yields null).
- **Captured-null on a matched row** → matched UPDATE writes `c = null` (a benign physical
  divergence: reads identically to absent; not a widen). Assert the read-back, not just the base row.
- **Both-sides write** `set c = b + 1, b = b + 100` — `c` reads the **pre-mutation** `b` (capture
  is materialized before any base op). This is the ticket's headline "rewrites a value the other
  branch reads" case; PutGet must hold row-for-row.
- **Multiple arbitrary cells** on one member (`set c1 = b + 1, c2 = a + b`) — each registers its own
  `srcN`; the materialize non-empty filter ORs over all cells (mirror `selfMaterializeNonEmptyFilter`).
- **Mixed captured + constant/anchor/self** cells on the same member — the whole group goes captured
  (subsumes the retired `hasAnchor && hasSelf` reject; add a test that `set c = c + a` now succeeds).
- **Volatile value** `set c = c + random()` — captured once per row, matched and materialize agree.
- **WHERE still gated** — `set c = b + 1 where notanchor = …` must still reject on the predicate
  (`unsupported-decomposition-predicate`), not the value; atomicity preserved (raise before any op).
- **Capture attribute alignment** — `keyColumns` order must match the `ProjectNode` projection
  order so `makeMultiSourceKeyRef` reads back positionally (the multi-source invariant).
- **Mutation order / anchor-last** — the capture is pre-mutation regardless of base-op order; the
  matched-UPDATE-before-materialize-INSERT order within a member still holds.
- **RETURNING** through a decomposition update stays rejected (`rejectReturning`) — the capture is
  value-only, no re-query.
- **Non-lens / lens enforcement** — captured base ops still flow through `constraintsForOp` /
  `extraConstraints` (a captured op is an ordinary AST `BaseOp`); injecting `__vmupd_keys` into a
  constant/anchor/self op's `cteNodes` it never references is harmless.

## Tests (lens-put-fanout.spec.ts — extends the existing `x.T` columnar fixture)

The `x.T` fixture: anchor `T_core(id, a)`, mandatory `T_b(b)`, optional `T_c(c)`, key `id`; rows
`(1, a=10, b=100, c=1000)` and `(2, a=20, b=200, c=absent)`.

- **Flip the two reject tests to success**: `set c = b + 1` (was ~393-405) and
  `set c = (select max(a) from main.T_core)` (was ~407-416). `update x.T set c = b + 1 where id = 1`
  → `T_c.c = 101`; `where id = 2` (absent, b=200) → materialize `T_c(2, 201)`; verify via both the
  base table and `select c from x.T`.
- **Mixed self+anchor now admitted**: `update x.T set c = c + a where id = 1` → `1000 + 10 = 1010`
  (present); `where id = 2` (absent) → captured `null + 20` = null → no materialize, `x.T.c` reads
  null. (Replaces the spirit of the `mixes anchor and self` reject test ~561-571.)
- **Cross-member absent both sides**: drop `T_b` row 2's mandatory? (b is mandatory, present) —
  instead test a value reading an **optional** sibling that is absent so the captured value is null
  and no phantom materializes (add a second optional member to the fixture or assert the null path
  via `c = c + a` above).
- **Both-sides write**: `update x.T set c = b + 1, b = b + 100 where id = 1` → `T_c.c = 101`
  (pre-mutation b=100), `T_b.b = 200`. PutGet on `select c, b from x.T where id = 1`.
- **Multiple arbitrary cells** (extend fixture's `T_c` with a second optional value column, or add a
  member): `set c1 = b + 1, c2 = a + b` over present + absent.
- **Captured-null matched read-back**: a value that evaluates null on a matched row leaves the row
  readable as null through `x.T`.
- **Predicate still gated**: `set c = b + 1` with a non-anchor WHERE still rejects
  `unsupported-decomposition-predicate`, base untouched.
- **EAV still rejects** (until the follow-up): `update x.E set p = p + 1` keeps rejecting
  `/capture substrate|subquery/i` (test ~868-879 unchanged) — confirms ticket 1 scopes to columnar.

## Docs

- decomposition.ts module header (lines ~96-104, the deferred-shape bullet) — narrow the "arbitrary
  value" deferral to **EAV only** (columnar is now captured), and document the capture reuse.
- docs/view-updateability.md (§ Outer Joins / the decomposition put fan-out) and docs/lens.md
  (§ The Default Mapper) — describe the single-identity decomposition capture and the captured
  matched-UPDATE + filtered-materialize-INSERT pair.

## TODO

Phase 1 — substrate
- Export `capturedValueSubquery` from multi-source.ts.
- Thread the planned-body source node + scope through `BodyBackwardLineage` and `DecompShape`;
  add `findBodySource` (generalized `findJoinNode`, handles the no-join anchor-only case).
- Add `buildDecompositionKeyCapture` in view-mutation-builder.ts (dual of
  `buildMultiSourceKeyCapture`).

Phase 2 — classifier + emit (columnar)
- Add `CapturedDecompValue` + the `captured` `ValueKind`; thread a `capturedValues` carrier +
  `registerCapturedExpr` closure through the decomposition `decomposeUpdate` →
  `lowerMaterializedValue` (register-captured only for a **columnar** owner; EAV keeps raising).
- Route a `captured`-bearing optional member group through a matched-UPDATE + always-emitted
  filtered-materialize-INSERT pair reading `capturedValueSubquery`; remove the `hasAnchor && hasSelf`
  reject.

Phase 3 — routing
- In `buildViewMutation`, route a decomposition UPDATE through the shape + carrier + capture path,
  folding the decomposition capture into the existing `keyCapture` / `withKeyCapture` /
  `identityCapture` wiring. DELETE / INSERT unchanged.

Phase 4 — tests + docs
- Add/flip the tests above; update the module header + the two docs.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log` and
  `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows). Fix all fallout.
