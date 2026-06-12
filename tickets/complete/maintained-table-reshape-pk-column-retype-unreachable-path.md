description: A refresh reshape whose only delta is a physical-PK column's logical-type change is now classified inexpressible → the sited `inexpressibleReshapeError` (table untouched, derivation stays stale). `describePhysicalPkChange` compares each physical-PK component's type via the shared `backingTypeMatches` predicate, alongside the existing name/direction/collation checks. The branch is reachable as black-box SQL: an `order by` over a non-PK source column seeds the backing's physical PK with that column, and the source permits retyping a non-PK column — so a refresh can produce a genuine PK-column type change against the live text-keyed identity.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # describePhysicalPkChange type check + two docblock updates
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts  # black-box reachable test in `inexpressible → sited error`
  - docs/materialized-views.md                                       # review fix: PK-definition-change enumeration now lists "type"
difficulty: medium
----

# Reject a PK-column type change as an inexpressible reshape

## Summary

`describePhysicalPkChange` previously compared each physical-PK component's name,
direction, and collation but **not its type**, so a reshape whose only delta was a
PK column's logical type change returned `null` (no PK change) and was wrongly
classified **expressible** — silently re-keying the maintained table's replicated
row identity under the stale comparator. The fix adds a type comparison (shared
`backingTypeMatches` predicate) inside the per-component loop, after the name check
/ before the direction check. When it fires, `classifyBackingReshape` early-returns
inexpressible *before* building the op plan, so the `retype` op `recordAttrShift`
queued for that same column is discarded; the caller raises the sited
`inexpressibleReshapeError` and leaves the table untouched, derivation stale.

The branch is genuinely reachable as black-box SQL (not dead code): `order by`
over a **non-PK** source column seeds the backing's physical PK with that column
leading (`computeBackingPrimaryKey`), and `alter column <non-pk> set data type` is
permitted at the source — so a refresh can re-derive a PK column whose type differs
from the live backing's. Verified empirically: `mv as select v, k from t order by v`
over `t(k integer primary key, v text)` keys the backing `[v(text), k]`; retyping
source `v` text→integer yields a reachable PK-column type change.

## Review findings

**Implement diff reviewed at e98f439c, fresh-eyes-first.** Verdict: the fix is
correct, minimal, well-placed, and uses the existing shared comparison vocabulary
rather than rolling its own. One minor doc gap found and fixed; the implementer's
self-flagged "known gaps" were independently assessed and accepted with reasons.

### Checked — and the outcome

- **Correctness / placement.** The type check sits in the one consumer of
  `describePhysicalPkChange` (`classifyBackingReshape`, sole caller confirmed via
  reference search). It iterates only physical-PK components, compares the
  underlying column schemas (`current.columns[…]` vs `shape.columns[…]`) via the
  shared `backingTypeMatches` (name-interned, case-insensitive — robust to the
  store module rebuilding `TableSchema` with fresh instances after an ALTER). The
  early-return at L1255-1256 discards the whole op plan, so no stale `retype` leaks.
  ✅ correct.

- **Reachability claim.** Independently re-derived from source: `order by` seeds
  the physical PK with the order-by output column leading (`computeBackingPrimaryKey`
  L209-222); the source-side guard in `alter-table.ts` L875-882 blocks
  `set data type` only on a **source** PK column, so retyping the non-PK seed slips
  through. The new black-box test asserts the precondition empirically before
  exercising the path. ✅ live keying hazard, not dead code.

- **Fast-path bypass.** Confirmed the data-only fast path (`backingShapeMatches` →
  `replaceContents`) cannot silently absorb a PK-type change: its positional
  `describeBackingShapeMismatch` checks type (L1073), so a type-differing shape
  falls through to `reshapeBacking` → the new check. ✅ no silent re-key.

- **Over-rejection guard (non-PK retype must stay expressible).** Structurally
  guaranteed — the new code only iterates PK components. Confirmed the existing
  `a narrowing retype validates the reconciled body …` test (L170) uses a no-`order
  by` `select *` body, so its physical PK is `[id]` and the retyped `v` is
  definitively non-PK; it asserts the reshape proceeds **in place** and passes. ✅
  no over-rejection; a dedicated new test would add nothing.

- **Tests.** Full suite **5939 passing, 9 pending** (green). New test confirmed
  executing and green in isolation (`--grep "physical-PK column type change"` →
  1 passing, 49ms). Lint exit 0, typecheck exit 0. ✅

### Found and fixed (minor)

- **Stale user-facing doc.** `docs/materialized-views.md:196` enumerated the
  physical-PK definition change as "the key's column set, order, direction, **or
  collation**" — out of date after the fix. The implementer updated the two source
  docblocks but missed this doc, which the change should have touched. Added "or a
  key column's logical type" to the enumeration. (Markdown — not eslint-covered, so
  no re-lint needed.)

### Assessed and accepted (no action — with reasons)

- **Renamed-AND-retyped PK column — not directly tested.** Independently traced its
  reachability and found it **marginal**, validating the implementer's decision to
  skip it: renaming the order-by **seed** column breaks the body's `order by <name>`
  (the stored body re-plan would fail to resolve the old name), and the appended
  **tiebreaker** is the source PK (retype-blocked at source) — so a same-component
  rename+retype is only reachable through an exotic `order by <ordinal>` body, not
  straightforwardly. The code is name-agnostic by inspection (type compares
  `curCol` vs `shCol` independent of the `renameMap` name mapping). Forcing a
  fragile test through the ordinal path would couple it to ordering-ordinal
  semantics for negligible added confidence. **Accepted gap.**

- **Direction-independence not separately re-asserted.** No existing PK-direction
  test exists to extend; the new check is additive and the PK-collation test
  (~L286) passes unchanged. **Accepted** (parity with prior coverage).

- **`test:store` not run.** This is classification logic in the emit layer, not
  store-path-specific; memory-vtab is the agent default per AGENTS.md. No store
  divergence expected. **Accepted** (out-of-band coverage if desired).

No major findings — no follow-up ticket filed.

## Acceptance — status

- PK-column type-change reshape has a defined, tested outcome (sited
  `inexpressibleReshapeError`, table untouched, derivation stale). ✅
- `inexpressible → sited error` suite gains the PK-column-type-change case
  (black-box, reachable). ✅
- Existing expressible-reshape and PK-collation tests still pass. ✅
- Test + lint + typecheck green. ✅
- Docs reconciled to the new classification. ✅ (review fix)
