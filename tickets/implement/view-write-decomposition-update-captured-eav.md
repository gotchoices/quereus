description: Admit an **arbitrary** assigned value (any EAV self-reference, a cross-member read, or an embedded subquery) in a decomposition **EAV-pivot** UPDATE by reusing the single-identity capture substrate the columnar prereq builds — routing a captured EAV cell through a per-attribute matched-UPDATE + filtered-materialize-INSERT triple pair that reads the captured value back. Removes the EAV `arbitrary` reject.
prereq: view-write-decomposition-update-captured-columnar
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/lens.md, docs/view-updateability.md
----

## Problem

An EAV-pivot value column is projected by the get body as a **correlated subquery**
(`(select val from pivot where entity = anchor.key and attr = '<attr>')`), so **any** EAV
self-reference (`set p = p + 1`) lowers to a subquery value and lands `arbitrary` — rejected
`unsupported-decomposition-update`, alongside the cross-member and explicit-subquery EAV cases.
The columnar prereq (`view-write-decomposition-update-captured-columnar`) built the whole capture
substrate but deliberately scoped its emit to columnar members; the EAV cell classifier and
`emitEavMemberUpdate` still reject `arbitrary`. This ticket flips EAV onto the same capture.

## Design — reuse, don't rebuild

The capture (`buildDecompositionKeyCapture`), the `__vmupd_keys` wiring, `capturedValueSubquery`,
and the `captured` `ValueKind` already exist from the prereq. EAV adds **only** the per-attribute
emit and lifts the columnar-only gate in `lowerMaterializedValue`.

For EAV, the capture identity is still the anchor key (`k0_0`), which equals the pivot's entity
value (the shared stitch key). The lowered EAV value substitutes the attribute's get-body
projection: `set p = p + 1` → `(select val from E_eav e where e.eid = E_core.id and attr = 'p') + 1`,
captured over the anchor scan (the pivot is in the subquery's own FROM, so the capture FROM needs
only the anchor — already covered by `findBodySource`'s anchor-only path).

Per **captured** EAV attribute cell, emit the triple analogue of the columnar pair (mirroring the
existing EAV constant path `buildEavAttrOp('update')` + `buildEavInsertSelect('nothing')`,
decomposition.ts ~1392-1511):

```
-- update x.E set p = p + 1 where id = 1     (E_eav(eid, attr, val), entity 1 has a 'p' triple)
-- capture: __vmupd_keys = π_{E_core.id as k0_0, ((select val …attr='p') + 1) as src0}( σ_{id=1}( E_core ) )
-- matched UPDATE (existing 'p' triples for matched entities; reads captured by the entity column):
--   update E_eav set val = (select src0 from __vmupd_keys k where k.k0_0 = eid)
--     where attr = 'p' and eid in (select id from E_core where id = 1)
-- materialize INSERT (entities lacking 'p'; reads captured by the anchor key, non-empty filtered):
--   insert into E_eav (eid, attr, val)
--     select E_core.id, 'p', (select src0 from __vmupd_keys k where k.k0_0 = E_core.id)
--     from E_core where id = 1
--       and (select src0 from __vmupd_keys k where k.k0_0 = E_core.id) is not null
--     on conflict (eid, attr) do nothing
```

The conflict target is `(entity, attr)` (the deploy-guaranteed pivot PK/UNIQUE), as in the existing
EAV upsert path. The matched UPDATE is **unfiltered**; a captured-null on a matched triple writes
`val = null`, which reads identically to no triple under the get-body subquery — a benign physical
divergence from the explicit `set p = null` DELETE (document it). The materialize INSERT is filtered
on the captured value being non-null, so no phantom null triple is created. Always emit the INSERT
(the runtime non-empty filter decides per row — no plan-time fold).

## Changes

- `lowerMaterializedValue` (decomposition.ts): remove the columnar-only restriction the prereq
  added, so an EAV owner with a carrier also registers a `captured` cell instead of raising. The
  `EavCell` kind set widens from `constant | anchor` to include `captured` (update the comment at
  ~832-833 and the `EavCell` shape).
- `emitEavMemberUpdate` (~1392-1413): add a `captured`-cell branch routing to the matched-UPDATE +
  filtered-materialize-INSERT triple pair above. Reuse the value read-back
  `capturedValueSubquery(srcAlias, 0, [pivot.entityColumn])` (matched) and
  `capturedValueSubquery(srcAlias, 0, [anchorKey])` (materialize). The existing `null` (delete) and
  `anchor` (do-update upsert) and `constant` branches are unchanged.
- No routing change in `buildViewMutation` (the prereq already routes every decomposition UPDATE
  through the carrier + capture path; EAV cells now register into the same carrier).

## Residual rejects

After capture, an EAV value of any scalar shape is expressible. Residual EAV rejects stay
structural: a write to a **logical column the EAV pivot does not back** (`no-inverse`/unbacked),
the shared-key write, composite key, and the non-anchor/subquery **WHERE** predicate gate
(`unsupported-decomposition-predicate` — unchanged). Never widen the view image.

## Edge cases & interactions

- **EAV self-reference** `set p = p + 1`: matched entity (has 'p') increments its real value;
  entity lacking 'p' captures `null + 1` = null → filtered, no triple materializes (you cannot
  increment a non-existent attribute).
- **EAV cross-member / anchor-mixed** `set p = a + 1` where `a` is a columnar member's value, or
  `set p = (select max(v) from other)`: present + absent over the captured value.
- **Captured-null matched triple**: leaves `val = null` (reads as absent through `x.E`); assert the
  `x.E` read-back, and that a subsequent `set p = 5` upserts it back.
- **Mixed cells on one EAV member**: `set p = p + 1, q = 99` — `p` routes captured (per-attribute),
  `q` routes the existing constant path; both coexist (EAV attributes are independent triples) and
  the capture carries only `p`'s `srcN`.
- **Mixed columnar + EAV members** in one statement (a decomposition with both): each member group
  routes independently; the single capture carries every member's `srcN` values.
- **`(entity, attr)` conflict target** correctness: a captured materialize for an entity that *does*
  have the triple conflicts and is ceded to the matched UPDATE (`do nothing`), never double-inserts.
- **Predicate / RETURNING / atomicity** — unchanged from the columnar prereq.

## Tests (lens-put-fanout.spec.ts — extends the existing `x.E` EAV fixture)

`x.E` fixture: anchor `E_core(id)`, pivot `E_eav(eid, attr, val)` PK `(eid, attr)`, logical columns
`p`, `q`; triples `(1,'p',11), (1,'q',12), (2,'p',21)`.

- **Flip the EAV self-reference reject to success** (was ~868-879): `update x.E set p = p + 1
  where id = 1` → entity 1's `'p'` triple `11 → 12`; verify base + `select p from x.E where id = 1`.
- **EAV self-reference materializes nothing on an absent attribute**: `update x.E set q = q + 1
  where id = 2` (entity 2 lacks `'q'`) → captured null → no `(2,'q',…)` triple; `x.E.q` reads null.
- **EAV anchor-mixed / explicit subquery**: `set p = id * 10 + 1` (mixes anchor id with the
  attribute? — pick a genuinely mixed/sub-query shape that previously hit `arbitrary`) over present
  + absent.
- **Captured-null matched read-back + re-upsert**: drive a matched triple's captured value to null,
  confirm `x.E` reads null, then `set p = 5` upserts it back to a real triple.
- **Mixed `p` (captured) + `q` (constant)** in one statement.

## Docs

- decomposition.ts module header — remove the EAV qualifier the columnar prereq left on the
  "arbitrary value" deferral bullet (now fully captured); update the EAV UPDATE bullet
  (~63-67) to list the captured triple pair alongside the null/anchor/constant cases.
- docs/lens.md (§ The Default Mapper) and docs/view-updateability.md — note the EAV captured value.

## TODO

- Lift the columnar-only gate in `lowerMaterializedValue`; widen `EavCell` to carry a `captured`
  cell (with its `srcAlias`).
- Add the `captured`-cell branch to `emitEavMemberUpdate` (matched UPDATE + filtered materialize
  INSERT triple, reusing `capturedValueSubquery`).
- Flip / add the EAV tests above.
- Update the decomposition.ts header + docs.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log` and
  `yarn workspace @quereus/quereus run lint`. Fix all fallout.
