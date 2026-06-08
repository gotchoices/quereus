description: Review the EAV-pivot decomposition UPDATE captured-value support — arbitrary EAV values (self-reference, cross-member, embedded subquery) now ride the single-identity `__vmupd_keys` capture per attribute (matched-UPDATE + filtered-materialize-INSERT triple pair) instead of rejecting `unsupported-decomposition-update`.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped

An EAV-pivot value column is projected by the get body as a **correlated subquery**
(`(select val from pivot where entity = anchor.key and attr = '<attr>')`), so **any** EAV
self-reference (`set p = p + 1`), cross-member read, or embedded subquery lowers to a subquery value
and previously landed `arbitrary` → rejected. This ticket flips EAV onto the **same** single-identity
(anchor-key) `__vmupd_keys` capture the columnar prereq (`view-write-decomposition-update-captured-columnar`)
built, per attribute.

Per captured EAV attribute cell the emit is the triple analogue of the columnar pair:

```
-- update x.E set p = p + 1 where id = 1   (E_eav(eid,attr,val) PK (eid,attr); entity 1 has a 'p' triple)
-- capture: __vmupd_keys = π_{E_core.id as k0_0, ((select val …attr='p') + 1) as src0}( σ_{id=1}( E_core ) )
-- matched UPDATE (existing 'p' triples; read-back by the entity column):
--   update E_eav set val = (select src0 from __vmupd_keys k where k.k0_0 = eid)
--     where attr = 'p' and eid in (select id from E_core where id = 1)
-- materialize INSERT (entities lacking 'p'; read-back by the anchor key, non-null filtered):
--   insert into E_eav (eid, attr, val)
--     select E_core.id, 'p', (select src0 from __vmupd_keys k where k.k0_0 = E_core.id)
--     from E_core where id = 1 and (select src0 …k.k0_0 = E_core.id) is not null
--     on conflict (eid, attr) do nothing
```

The matched UPDATE is **unfiltered**: a captured-null on a matched triple writes `val = null`
(reads identically to an absent triple through the get-side subquery — a benign physical divergence
from the explicit `set p = null` DELETE). The materialize INSERT's runtime non-null filter means a
captured null on an absent entity (incrementing an attribute it lacks) materializes no phantom triple.
Conflict target `(entity, attr)` is the deploy-guaranteed pivot PK/UNIQUE.

## Changes

- **decomposition.ts**
  - `lowerMaterializedValue`: removed the columnar-only gate — an EAV owner with the capture carrier
    now classifies `captured` instead of raising. `EavCell.kind` widened to admit `captured`.
  - `emitEavMemberUpdate`: added a `captured`-cell branch → `emitEavCapturedAttr`, which registers the
    lowered value into the capture (one `srcN` per attribute) and emits the matched UPDATE
    (`buildEavAttrOp('update', valueOverride)` — new optional value-override param) + the filtered
    materialize INSERT (`buildEavCapturedInsert`, new). Reuses `capturedValueSubquery(srcAlias, 0,
    [pivot.entityColumn])` (matched) and `…[anchorKey]` (materialize). `null`/`anchor`/`constant`
    branches unchanged. Threaded `registerCapturedExpr` through `decomposeUpdate → emitEavMemberUpdate`.
  - Module-header + doc-comment updates; removed the EAV-arbitrary deferral bullet (now supported).
  - **No routing change** in `buildViewMutation` — the prereq already routes every decomposition UPDATE
    through the carrier + capture; EAV cells register into the same carrier.
- **backward-body.ts** — `findBodySource` made **scope-aware**: returns the outermost node that
  actually carries a registered output scope (the `JoinNode` for a join body, the FROM `AliasNode` for
  an anchor-only EAV body) rather than the deepest `TableReferenceNode`. **This was a latent prereq
  gap**: the prereq claimed the anchor-only path was "already covered", but `bodyScope =
  outputScopes.get(bodySource)` returned `undefined` for the anchor-only body (the scope is registered
  on the FROM `AliasNode`, not the inner table ref), so the capture raised `no-base-lineage`. Columnar
  is unchanged (still returns the `JoinNode`, the first scoped node from root). Removed the now-unused
  `JoinNode` import.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus test` — **5283 passing, 9 pending, 0 failing.**
- `yarn workspace @quereus/quereus run lint` — clean.

## Use cases / tests to exercise

New tests in `lens-put-fanout.spec.ts` (`x.E`: anchor `E_core(id)`, pivot `E_eav(eid,attr,val)` PK
`(eid,attr)`, logical `p`/`q`; triples `(1,'p',11),(1,'q',12),(2,'p',21)`):

- **EAV self-reference (flipped reject→success)**: `set p = p + 1 where id = 1` → entity 1's 'p' 11→12;
  other triples untouched.
- **Self-reference materializes nothing on an absent attribute**: `set q = q + 1 where id = 2`
  (entity 2 lacks 'q') → captured null → no `(2,'q',…)` triple, `x.E.q` reads null.
- **Anchor-mixed self over present + absent**: `set p = p + id * 10` (no WHERE) → 21 / 41 (both matched).
- **Materialize via anchor-mixed self**: `set q = coalesce(q,0) + id` → entity 1 'q' 12→13 (matched),
  entity 2 materializes `(2,'q',2)`.
- **Captured-null matched read-back + re-upsert**: `set p = q + 1 where id = 2` (entity 2 has 'p',
  lacks 'q') → matched 'p' triple `val = null`, reads null through `x.E`; then `set p = 5` re-upserts.
- **Mixed captured `p` + constant `q`** in one statement → `p` captured (own srcN), `q` constant path.

`property.spec.ts`: extended the "accepts: an EAV write…" test with the captured self-reference
(present increment + absent-attribute no-materialize); converted the EAV reject test to assert only the
non-anchor-predicate structural reject (arbitrary EAV value is no longer rejected).

## Known gaps / things to scrutinize (treat as a floor, not a finish line)

1. **NOT-NULL pivot value column is untested.** The captured-null matched write (`set p = q + 1` over
   a matched triple) writes `val = null`, so it requires a **nullable** pivot value column. I changed
   the `setupEav` fixture to `val integer null` + logical `p/q integer null` (matching the existing
   `property.spec` EAV fixture) to exercise the documented benign-divergence path. With a **NOT NULL**
   pivot value column, that same write would raise a base NOT NULL constraint error at runtime (atomic,
   no widen) — the EAV analogue of the columnar "invisible logical row" boundary (docs/lens.md §
   Current Limitations). **No test asserts this NOT-NULL boundary**, and the docs do not call it out for
   EAV specifically. A reviewer may want an explicit test + a doc note.
2. **`findBodySource` is shared infrastructure.** The scope-aware change touches the one backward-walk
   consumer multi-source, columnar, and EAV all share. The full suite is green (columnar/surrogate/
   multi-member capture tests all pass), but the change is broader than EAV — worth a deliberate look
   that no join body now resolves a *different* node than before (it should not: `JoinNode` is still the
   first scoped node from root).
3. **No EAV captured fuzz arm.** The `property.spec` EAV PutGet oracle exercises only
   `insert`/`delete`/`update-p`/`update-p-null` — not a captured self-reference arm (e.g. `update-p-self`
   = `set p = p + 1`). Added explicit accept tests instead. A reviewer wanting parity with the columnar
   fuzz arms (`update-c-self`, `update-c-cross`, …) could add one, with the oracle modeling the
   matched-null-on-absent / materialize-on-non-null semantics.
4. **Mixed columnar + EAV members in one statement** (a decomposition with both): the single capture
   carries every member's `srcN` and each member group routes independently. Covered indirectly (each
   path tested in isolation; the carrier dedup keys EAV by `cap:<rel>:attr:<attr>` and columnar by
   `cap:<rel>:<col>`, so no collision), but not exercised by a single combined-fixture test.

## Residual rejects (unchanged, structural)

A write to a logical column the EAV pivot does not back (`no-inverse`/unbacked), the shared-key
(identity) write, composite key, and the non-anchor/subquery WHERE predicate gate
(`unsupported-decomposition-predicate`) all stay rejected. The view image is never widened.
