description: Review cross-source `set` admission through an inner-join view — `update v set a.x = b.y` where the read column has `base` lineage. The partner value rides the existing `__vmupd_keys` capture as a `srcN` projection and is read back correlated by the owning side's PK. Inner-join only; computed-partner reads, outer-join cross-source, and decomposition cross-member `set` stay rejected.
prereq: view-write-nway-inner-join
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What landed

`stripSideQualifier` previously threw `cross-source-assignment` the moment a multi-source UPDATE's assigned value referenced a column owned by a side **other** than the column it assigns. It now **captures and rewrites** such a reference (when the read column has `base` lineage), so `update v set a.x = b.y` is admitted: each affected view row's partner value rides the **same** up-front `__vmupd_keys` capture the keys do, and the reference lowers to a correlated scalar read of it.

```
-- view: select c.cc as cc, c.cv as cv, p.pv as pv from jchild c join jparent p on p.pp = c.pr
update jv set cv = pv where cc = 1
  -- capture: π_{c.cc as k0_0, p.pv as src0}( σ_{cc=1 ∧ p.pp=c.pr}( join ) )   (materialized ONCE, pre-mutation)
  -> update jchild set cv = (select src0 from __vmupd_keys k where k.k0_0 = cc)
        where exists (select 1 from __vmupd_keys k where k.k0_0 = cc)
```

Because the capture materializes **before** any base op fires (the eager key materialization the both-sides update / multi-side delete already use), the read-back is the **pre-mutation** partner value — so `set a.x = b.y, b.y = <new>` in one statement stores the OLD `b.y` into `a.x` even though the FK-parent (`b.y`) op runs first.

### Core changes (`multi-source.ts`)

- New exported `CrossSourceValue { alias; expr }` — a partner base column the SET reads, projected into the capture under a stable `srcN` alias.
- `decomposeUpdate` gained an optional `sourceValues?: CrossSourceValue[]` out-param (the carrier). It builds a `registerCrossSource` closure (dedupes by `<table>.<col>`, mints `src0/src1/…`, pushes to `sourceValues`) and passes it into `stripSideQualifier`. Absent the carrier (the legacy `propagateMultiSource` path — unreachable from build for join update/delete, which `buildViewMutation` intercepts) cross-source stays a hard reject, so no plan dangles.
- `stripSideQualifier` signature gained `owningSideIndex` + `registerCrossSource`. On an other-side leaf: if no carrier → the old `cross-source-assignment` throw; else → `registerCrossSource(col)` + rewrite the leaf to `capturedValueSubquery(srcAlias, owningSideIndex, owningPk)` = `(select srcN from __vmupd_keys k where k.k<owningSide>_<j> = <pk_j> …)`. The unqualified `<pk_j>` bind to the lowered UPDATE's own target row (same correlation shape as the per-side identifying EXISTS). The owning-quals-first check is preserved (self-join owning-alias refs still strip).
- New `gateCrossSourceReads` (run only when the carrier is present): walks the value's **top-level** column refs; for each that reads a partner side and is **not** `base`-writable (computed) → reject `no-inverse`. `viewColumnReadSides` resolves a base column to its owning side, a computed column to every side its base-term leaves resolve to (so a **same-side** computed read stays admissible — preserving today's behavior — while a **cross-source** computed read rejects). Helpers `forEachTopLevelColumnRef` / `forEachColumnRefDeep` reuse `transformExpr`.
- `buildMultiSourceKeyCapture` gained an optional `sourceValues` — after the per-side PK projections it appends one projection per `srcN` (built over `analysis.joinScope`), pushing matching `keyColumns` so the readers' `makeMultiSourceKeyRef` exposes them. Order is PK-cols-then-src-cols, positionally aligned.

### Builder (`view-mutation-builder.ts`)

- `buildViewMutation` allocates `const sourceValues: CrossSourceValue[] = []`, passes it to `decomposeUpdate`, and threads it to `buildIdentityCapture` → `buildMultiSourceKeyCapture`. The capture is already built for **every** multi-source update, so a single-side cross-source update (which only needs its own side's key) materializes the capture once with the extra `srcN` column — no new capture-trigger logic needed.

## Use cases to validate (the acceptance gate)

`test/property.spec.ts` § View Round-Trip Laws → `describe('multi-source inner join')`:
- **`PutGet/GetPut: cross-source set (cv = pv) copies the joined partner value`** — after `update jv set cv = pv where cc = K`, the matched joined child's `cv` equals its joined parent's `pv`; unjoined/dangling and non-matched children and the parent base untouched. GetPut: re-running is a no-op (cv already = pv).
- **`both-sides + cross-source: cv := the PRE-mutation pv even as pv is rewritten`** — `set cv = pv, pv = NV` (NV disjoint from seeds): cv takes the pre-mutation pv, not NV. Proves eager capture / mutation-order independence.
- **Flipped existing test**: the B1 inverse test's part (2) (`update jv2 set cv1 = pv + 1`) was a `cross-source-assignment` reject; now it is an **accept** — the inverse wraps the captured read (`cv = ((select src…)+1)-1`), so cv stores the partner pv. Title renamed to "inverse-wrapped cross-source read".
- **Flipped negative** in `reject-do-not-widen`: `update rj_inner set cv = pv` now accepted (smoke: every view row has `cv == pv` after). Added negatives there: cross-source through `rj_outer` (outer join → `unsupported-join`) and reading a **computed** partner column `rj_pc` (`p.pv * 2 → no-inverse`).
- `93.4-view-mutation.sqllogic`: the old `cannot write through` cross-source negative (`ax_jv_x`) was rewritten to a self-contained accept (`set cval = pv`, integer→integer) + a computed-partner reject (`ax_jv_xc`, `(p.pv*2)`).

## Validation performed

- `yarn workspace @quereus/quereus test` — **4602 passing**, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — clean.
- `cd packages/quereus && npx tsc --noEmit` — clean.
- (Did not run `test:store` — change is planner/mutation-layer, no storage path touched.)

## Known gaps / where to scrutinize (honest — tests are a floor)

- **Shared `__vmupd_keys` node instance within one base op.** A cross-source base op now references `__vmupd_keys` **twice** (the identifying EXISTS + the value subquery), both resolving via `cteNodes` to the **same** injected `InternalRecursiveCTERefNode` instance (a DAG). Tests pass (single-side + an inverse-wrapped expression both exercise this), and it mirrors how regular CTE refs are deliberately shared via `cteReferenceCache`. **Untested:** *multiple distinct* cross-source leaves in one statement (e.g. `set x = b.y + b.z`, or `set x = b.y, w = b.z`) — each mints its own `srcN` but all share the one keyRef instance. Worth a reviewer-added test to confirm the optimizer/emitter tolerate the wider DAG and that distinct `srcN` columns resolve correctly.
- **Gate is top-level only.** `gateCrossSourceReads` walks the value's top-level column refs (parity with `guardTopLevelScope`). A computed partner column referenced **inside a value subquery** is not gated — `substituteViewColumns`' descent would expand it and `stripSideQualifier`'s threaded substitute would capture its base leaves rather than reject. Beyond ticket scope (top-level cross-source set), but a reviewer may want an explicit nested-subquery test or a documented limitation.
- **The 1:many ambiguous direction is not tested.** The capture row carries one `srcN` per joined (owning, partner) pair. When the **owning** side joins many partners (e.g. a parent-side column reading a child column — one parent, many children), `(select srcN from __vmupd_keys k where k.k<owner>_0 = <pk>)` returns multiple rows. All tests use the child-reads-parent (1:1) direction. Confirm the runtime behavior (scalar-subquery-too-many-rows error vs. first-row) is acceptable, or whether the genuinely-ambiguous direction should be diagnosed at plan time.
- **Self-join + composite-PK-owning cross-source are not directly tested.** The rewrite uses `keyColumnName(owningSideIndex, j)` over `requireKeyColumns(owning)`, so it *should* handle a composite-PK owning side (conjoins all PK cols) and a self-join (owning-quals-first strip, alias-keyed `owningSideIndex`), but no property/sqllogic case exercises a cross-source `set` on those shapes. Worth adding.
- **Type affinity:** the sqllogic accept uses integer→integer (`cval = pv`) to dodge text-affinity ambiguity; int→text cross-source assignment is not pinned.
- **`computed` detection hinges on `* `/`||` being opaque.** The negatives (`p.pv * 2`) rely on `*` classifying as non-invertible (`writable=false`), consistent with the pre-existing delete-RETURNING test's "body-computed `c.cv * 2`". If invertibility classification ever widens to cover `* k`, those negatives would flip to accepts (and would then be correct — the leaf is still `base`); the reviewer should be aware the negative is really "computed view column", not "this specific expression".
- **Out of scope (unchanged, by design):** cross-member `set` in the decomposition fan-out (`decomposition.ts` `rewriteAssignedValue` still rejects `cross-source-assignment` / `cross-member assignment` — covered by `lens-put-fanout.spec.ts`), and cross-source through an outer join (deferred with the whole outer-join body).

## Unrelated pre-existing change in the tree

`packages/quereus/src/schema/manager.ts` carries an **uncommitted, unrelated** modification (reordering VTab module `destroy` to await-before-teardown on DROP) that was present in the working tree before this ticket's work and is not touched by it. The full suite passes with it present. Flagging so the commit/reviewer is aware it will be bundled if not separated.
