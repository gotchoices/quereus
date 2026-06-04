description: Admit cross-source `set` values through an inner-join view — `update v set a.x = b.y where …` — where the read column's lineage proves it is a `base` column. Currently rejected wholesale with `cross-source-assignment`.
prereq: view-write-nway-inner-join
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Why

`docs/view-updateability.md` § Inner Join allows a `set` clause "assigning columns from both sides", but a value that **reads** a column owned by a *different* side than the column it assigns (`set a.x = b.y`) is rejected today: `stripSideQualifier` (`multi-source.ts`) raises `cross-source-assignment` the moment a base-term assigned value references the non-owning side. The ticket scope (§ 3) admits this "where lineage proves the read column is `base`". This is the smallest of the three shape families but a real expressiveness gap.

## The problem

For an inner join, `update v set x = y where p` (x on side A, y on side B) means: for each joined row matching `p`, set `A.x` to *that row's* `B.y`. A single-table `update A set x = <const>` cannot express a per-row value sourced from the partner row — which is exactly why `stripSideQualifier` rejects it rather than silently mis-binding `y` to a same-named column on A.

## Target architecture

Reuse the up-front identity capture (`buildMultiSourceKeyCapture`, generalized to composite keys by the prereq) as the carrier for the partner value. The capture already materializes, per affected view row, the owning side's PK; extend it to **also project the cross-source read column(s)** the SET needs. Then lower the assignment to read that captured value back, correlated by the owning side's PK:

```
-- view: select a.x as x, b.y as y from ta a join tb b on b.k = a.fk
update v set x = y where a.x = 1
  -- capture: select a.<pkA> as k0_0, b.y as src0 from (ta ⋈ tb) where <idPred>
  -> update ta set x = (select src0 from __vmupd_keys k where k.k0_0 = ta.<pkA>)
        where <pkA> in / exists (capture)         -- the ordinary identifying predicate
```

The cross-source value rides the **same** `__vmupd_keys` descriptor and is read by an `InternalRecursiveCTERefNode` over it — no second plan of the join body. Because the capture is materialized *before* any base op fires (eager key materialization, § Multi-Base-Table Mutations), the partner value is the pre-mutation `b.y`, robust against a both-sides update that also writes `b.y`.

### Admit only when the read column is `base`

Gate on the read column's backward lineage (`OutColumn` / `BackwardColumn`): admit a cross-source value reference only when it resolves to a `base` site (identity / rename / invertible — already classified in `analyzeJoinView`). A reference to a **computed** / `null-extended` partner column stays rejected (`no-inverse` / the outer-join deferral), and a same-side reference keeps today's behavior (no capture needed — the owning-side qualifier strip handles it). A scalar **expression** over a partner column (`set x = b.y + 1`) reduces to capturing `b.y` and applying the (invertible-or-not) expression on read — admit when every cross-source leaf is `base`; reject otherwise.

### Where the rewrite lives

`stripSideQualifier` currently throws on any other-side reference. Replace the throw with: collect the other-side base-term column references, register each as a capture projection (returning a stable `srcN` alias + the side's owning info), and rewrite the reference to a `select srcN from __vmupd_keys k where <ownerPk = capture>` correlated subquery against the owning UPDATE's target row. The owning side's identifying predicate is unchanged. Thread the extra capture projections through `buildMultiSourceKeyCapture` (it already takes the analysis + sides; add the requested source expressions) and `buildIdentityCapture` in the builder.

## Out of scope

- Cross-source `set` through an **outer** join (a partner value on a null-extended side) — defers to `view-write-outer-join-static` / `view-write-optional-member-transitions`; keep rejecting until those land.
- Cross-source `set` in the **decomposition** fan-out (`decomposition.ts` `rewriteAssignedValue`) — its `cross-source-assignment` reject stays; this ticket is the multi-source join path only.

## Tests (acceptance gate: `test/property.spec.ts` § View Round-Trip Laws → `describe('multi-source inner join')`)

- **Cross-source `set`.** Flip the current negative `expectMutationReject('update rj_inner set cv = pv where cc = 1','cross-source-assignment')` (property.spec ~L3462) to an **accept**: after `update jv set cv = pv where cc = K`, the child's `cv` equals the joined parent's `pv` for the matched joined rows, unjoined/dangling child rows untouched (PutGet). Add a GetPut variant (writing the read-back value is a no-op).
- **Both-sides + cross-source in one statement** (`set cv = pv, pv = <NV>`): the captured `pv` used for `cv` is the **pre-mutation** value even though `pv` is also rewritten — proves eager capture.
- **Negative:** a cross-source value reading a **computed** partner column still rejects (`no-inverse`); a cross-source `set` through `rj_outer` (outer join) still rejects until the outer ticket lands.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` and `yarn workspace @quereus/quereus lint`.

## TODO

- Extend `MultiSourceKeyCapture` / `buildMultiSourceKeyCapture` to carry extra **source-value** projections (stable `srcN` aliases) alongside the per-side key columns.
- In `decomposeUpdate`, detect cross-source value references during assignment lowering; for each, register a capture projection and rewrite the reference to a correlated `select srcN from __vmupd_keys …` over the owning UPDATE's target row.
- Replace `stripSideQualifier`'s throw-on-other-side with the capture-and-rewrite path, gated on the read column resolving to a `base` site; keep the `computed` / outer-join reject.
- Thread the extra capture projections through `buildIdentityCapture` in `view-mutation-builder.ts`; ensure the capture is built (and materialized once) for a cross-source single-side update that previously needed no capture.
- Add the property-spec accept + GetPut + both-sides-precedence + negatives; flip the `rj_inner` negative.
- Update `docs/view-updateability.md` § Inner Join (cross-source `set` now admitted for `base` reads) and § Current limitations.
