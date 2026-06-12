description: Multi-source view UPDATE — resolve an UNQUALIFIED body-projection column reference to its owning join side by unique column ownership inside `stripSideQualifier`, so a cross-source SET value (or an authored-inverse `new.<x>` forward read) reaching a partner side through an unqualified projection rides the existing captured-read machinery instead of failing at base build with the generic `Column not found`.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts        # stripSideQualifier (~2447), its sole caller lowerValueOntoSide (~1568), resolveColumnSide (~2773)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # cross-source `set` section (~563-694) — add unqualified-projection cases
  - docs/view-updateability.md                                   # § Inner Join, cross-source `set` (~149)
difficulty: medium

# Cross-source reads through unqualified body projections

## Problem

`stripSideQualifier`'s leaf `substitute` returns `undefined` for an **unqualified**
column reference (`if (!col.table) return undefined`), implicitly assuming it belongs to
the owning side and leaving it bare. That is correct only when the column is owned by the
owning side — a bare column name in a lowered single-table UPDATE resolves against that
table. But a join-view body may legally project a **partner-side** column unqualified when
the name is unambiguous across the sides:

```sql
create view v as
    select a.pid, bv || '' as bv2, av     -- `av` lives only on side `a`
    from a join b on b.k = a.pid;
```

The projection's `baseTermExpr` for view column `av` is then the **unqualified** `av`. When
a cross-source SET value (`update v set <b-column> = av`) — or an authored inverse's
`new.av` forward read — is lowered onto a **partner-owning** side (`b`), the leftover
unqualified `av` survives the qualifier strip and lands in side `b`'s base UPDATE, where
column `av` does not exist → build fails with the generic `Column not found: av`.

Qualifying the projection in the body (`a.av as av`) is the current workaround. The qualified
cross-source path already works end-to-end (see `ax_jv_x` in `93.4-view-mutation.sqllogic`);
only the unqualified projection mis-routes. This is a functionality/diagnostics gap, not a
correctness hole — no silent mis-bind exists today (a both-sides name fails body planning as
ambiguous; a partner-only name fails loud as above).

## Design (resolved)

Implement **preference 1** from the plan: resolve the unqualified reference to its owning
side by **unique column ownership** — the exact rule `resolveColumnSide` already applies to
join-condition operands — then route a partner-resolved reference through the existing
captured-read machinery, identical to a qualified partner read.

### `stripSideQualifier` leaf handling

Today the leaf `substitute` has three outcomes: owning-qualifier → strip to bare column;
other-qualifier → cross-source route (capture + correlated read, or `cross-source-assignment`
reject when no carrier); unqualified / unknown → `undefined` (leave untouched).

Change the **unqualified** branch (`!col.table`) to resolve the side via
`resolveColumnSide(col, sides)` against the **full** sides array:

- **Resolves to the owning side, OR unresolvable (`undefined`)** → return `undefined`
  (leave the reference exactly as today). The owning-side bare column resolves correctly in
  the lowered single-table UPDATE; a genuinely-unresolvable name (a correlated outer ref, a
  name on no side) keeps its current pass-through so nothing that works today regresses.
- **Resolves to a partner side** → qualify it with that side's `alias`
  (`{ ...col, table: sides[partnerIdx].alias }`) and route it through the **same** path the
  qualified `otherQuals` branch already uses: `gateCrossSourceCardinality?.(col)` →
  `registerCrossSource(qualified)` → `capturedValueSubquery(srcAlias, owningSideIndex,
  owningPk)`, or `cross-source-assignment` reject when `registerCrossSource` is absent (the
  legacy non-build path). Qualifying before `registerCrossSource` makes the capture projection
  byte-identical to the qualified case and keeps the `srcN` dedup key (`<table>.<col>`)
  consistent, so a body mixing `a.av` and bare `av` does not mint two capture columns.

Factor the cross-source route the qualified `otherQuals` branch performs into a small local
helper (e.g. `routePartnerRead(col)`) so both the qualified-other and unqualified-partner
branches share one implementation (DRY; `owningPk` lazy-resolution stays shared).

### Signature change

`stripSideQualifier` currently receives `others` (the non-owning sides, index mapping lost).
`resolveColumnSide` needs the full, index-aligned sides array to return an index comparable to
`owningSideIndex`. Pass `analysis.sides` (the full array) and derive `otherQuals` internally
from `owningSideIndex` (drop the `others` param, or add `allSides` alongside it — prefer
dropping `others` since `allSides` + `owningSideIndex` subsumes it). There is exactly **one
caller** (`lowerValueOntoSide`, multi-source.ts ~1568); update it.

### Why preference 2 (structured ambiguity diagnostic) is intentionally NOT added

The plan's fallback — reject with a structured diagnostic when the side is ambiguous — is
**unreachable by construction** and would be dead code. `resolveColumnSide` returns
`undefined` for an unqualified name owned by **two or more** sides; but such a body projection
(`select av …` where `av` is on both sides) is already ambiguous at body planning, so
`analyzeJoinView` → `analyzeBodyLineage` → `buildSelectStmt` throws before decomposition ever
reaches `stripSideQualifier`. The remaining `undefined` case (a name on **no** side) is not a
side-ambiguity at all and must keep its pass-through. Document this reasoning inline; do not
add a diagnostic branch that cannot fire.

### Reuse note — the existing gates already handle unqualified

No change is needed to the up-front gates; they already cover the unqualified case:
- `gateCrossSourceReads` walks the **view-term** value (pre-substitution), so it sees the
  view column `av` and admits it via its `base`/`writable` lineage exactly as for a qualified
  read; a computed cross-source partner read still rejects `no-inverse`.
- `gateCrossSourceCardinality` calls `resolveColumnSide`, which already resolves unqualified
  refs — so the 1:many reject still fires for an unqualified partner read.
- `viewColumnReadSides` likewise resolves base-term leaves through `resolveColumnSide`.

The only mis-routing site is the `stripSideQualifier` leaf; that is the whole fix.

## Edge cases & interactions

- **Owning-side unqualified base column** (`set cv = bv` where both on owning side, body
  projects `bv` unqualified): resolves to owning side → returns `undefined` → stays bare →
  resolves in the single-table UPDATE. Must be byte-identical to today (no capture minted).
  Cover with a same-side unqualified read that does **not** create a `srcN` capture.
- **Partner-side unqualified base column** (the headline bug): `update v set x = av`, `x` on
  side `b`, `av` unqualified on side `a` → captured + correlated read, partner value lands
  correctly. The exact `ax_jv_x` scenario but with `pv` (not `p.pv`) in the body projection.
- **Authored-inverse `new.<x>` forward read of a non-assigned unqualified partner column**:
  the put's `new.av` resolves to the unqualified view-column displayName, flows through
  `lowerValueOntoSide` → `substituteViewColumns` → `stripSideQualifier`; the unqualified base
  `av` must route through capture onto the put's side. Cover an authored column whose put on
  side `b` reads `new.av` (av on side `a`, projected unqualified).
- **Computed column whose base-term spans both sides, read cross-source**: still rejected
  `no-inverse` upstream by `gateCrossSourceReads` (computed = non-writable). Assert it stays
  rejected (no new path admits it).
- **Unqualified partner read in the 1:many direction**: still rejected
  `cross-source-ambiguous-cardinality` at plan time (gate uses `resolveColumnSide`). Mirror
  `xs1n_v` with an unqualified projection.
- **Unqualified partner read pinned by a partner UNIQUE (not PK)**: accepted via the unique
  branch — mirror `xs1u_v` unqualified.
- **Self-join, unqualified read**: a self-join shares one table name across two aliases, so a
  *plain* unqualified base column is owned by BOTH sides → ambiguous → body planning already
  rejects it (it can never reach the leaf). A rename projection that exposes a single side's
  column under a distinct unqualified output name is the writable shape; confirm the alias-keyed
  capture correlation still holds. (Self-join bodies route by alias, so `resolveColumnSide`'s
  alias-preferred qualified path is unaffected; only the unqualified branch is new.)
- **Composite-PK owning side**: the correlated read-back conjoins one equality per owning PK
  column via `requireKeyColumns`/`capturedValueSubquery` — unchanged; verify an unqualified
  partner read on a composite-PK owner still keys all PK columns (mirror `ax_xscpk_v`).
- **`srcN` dedup**: a statement reading the same partner column once qualified (`a.av`) and
  once unqualified (`av`) must mint **one** `srcN` (qualifying-before-register guarantees this).
- **Legacy non-build path** (`propagateMultiSource`, no `registerCrossSource` carrier): an
  unqualified partner read must reject `cross-source-assignment`, same as the qualified case.
- **Nested subquery value**: `stripSideQualifier` threads its `substitute` through embedded
  query exprs (`mapQueryExprUniform`); an unqualified partner ref nested in a value subquery
  must route identically. Reuse a value-subquery cross-source case with an unqualified body
  projection.

## Tests

Add a focused block to `93.4-view-mutation.sqllogic` immediately after the existing
cross-source `set` section (~579), mirroring the established `ax_jv_x` / `ax_xscpk_v` /
`xs1n_v` / `xs1u_v` scenarios but with **unqualified** body projections. Key cases and
expected outputs:

- Unqualified partner read accepted (the headline): a view `select c.cid as cid, cval, pv
  from c join p …` (note bare `cval`, `pv`), `update … set cval = pv where cid = 2` →
  child `cval` becomes the joined parent's `pv`; the other child untouched; parent base
  unchanged. (The unqualified analogue of `ax_jv_x`.)
- Owning-side unqualified read — no capture minted, plain strip, value lands locally.
- Authored-inverse put reading `new.<unqualified partner column>` → routes onto the put's
  side via capture; assert the resulting base rows.
- 1:many unqualified partner read → `-- error: assigned side joins more than one` (plan-time
  reject; base table unchanged).
- Computed unqualified partner read → `-- error: cannot write through` (`no-inverse`).

Also confirm the substrate spec (`test/quereus/view-mutation-substrate.spec.ts`) and
`property.spec.ts` still pass — no signature they depend on changes publicly
(`stripSideQualifier` is module-internal).

## Docs

Update `docs/view-updateability.md` § Inner Join, cross-source `set` (~149): note that a
partner column projected **unqualified** (when unambiguous across the sides) is resolved to
its owning side by unique column ownership — the same rule join-condition operands use — and
rides the identical captured-read machinery; only a both-sides-ambiguous name (rejected at
body planning) or a same-/owning-side name (plain strip) diverges.

## TODO

- [ ] Add `routePartnerRead(col)` local helper in `stripSideQualifier` factoring the existing
      `otherQuals` cross-source route (capture + `capturedValueSubquery`, or
      `cross-source-assignment` reject); keep `owningPk` lazy resolution shared.
- [ ] Change the `!col.table` branch to `resolveColumnSide(col, sides)`: owning/unresolvable →
      `undefined`; partner → qualify with the partner alias and call `routePartnerRead`.
- [ ] Thread the full `analysis.sides` array into `stripSideQualifier` (drop/replace `others`);
      update the sole caller `lowerValueOntoSide` (~1568).
- [ ] Add an inline comment recording why preference-2 (ambiguity diagnostic) is unreachable
      (body-planning ambiguity gate) and intentionally omitted.
- [ ] Add the unqualified-projection cross-source cases to `93.4-view-mutation.sqllogic`.
- [ ] Update `docs/view-updateability.md` § Inner Join cross-source `set`.
- [ ] `yarn workspace @quereus/quereus run build`, then `yarn workspace @quereus/quereus test`
      (stream with `tee`); run lint on the package.
