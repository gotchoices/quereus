description: `describePhysicalPkChange` now treats a PK-column *type* change as a PK-definition change, so a refresh reshape whose only delta is a physical-PK column's logical type retypes is classified inexpressible → the sited `inexpressibleReshapeError` (table untouched, derivation stale). Planning's reachability claim was verified empirically true: a body `order by` over a non-PK source column seeds the backing's physical PK with that column, and the source permits retyping a non-PK column, so the path is a live keying hazard reachable as black-box SQL (not dead code). Review the type-check placement, the reason string, and the reachability test.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # THE FIX: describePhysicalPkChange (~L1300) backingTypeMatches(curCol,shCol) check; two docblock updates (classifyBackingReshape ~L1163, describePhysicalPkChange ~L1272)
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts  # NEW black-box reachable test in `inexpressible → sited error` (~L308, after the PK-collation case)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # reference (unchanged): computeBackingPrimaryKey (~L209, order-by seeding), classifyBackingReshape early-return (~L1257), backingTypeMatches (~L1044), recordAttrShift retype push (~L1203)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # reference ONLY — source-side "Cannot SET DATA TYPE on PRIMARY KEY column"; deliberately NOT changed
difficulty: medium
----

# Review: reject a PK-column type change as an inexpressible reshape

## What was implemented

`describePhysicalPkChange` previously compared each physical-PK component's
**name, direction, and collation** but **not its type** — so a reshape whose only
delta was a PK column's logical type change returned `null` (no PK change) and was
classified **expressible**. The fix adds a type comparison inside the per-component
loop, using the existing shared predicate `backingTypeMatches`, positioned right
after the name check / before the direction check:

```ts
if (!backingTypeMatches(curCol, shCol)) {
    return `primary-key column ${k} '${curCol.name}' type ${curCol.logicalType.name} → ${shCol.logicalType.name}`;
}
```

`curCol`/`shCol` are already in scope (`current.columns[currentPk[k].index]` and
`shape.columns[shapePk[k].index]`), so the comparison is on the underlying column
schemas — a renamed-and-retyped PK column (name carried through `renameMap`) still
trips this. When the function returns a reason, `classifyBackingReshape` hits its
early-return (`if (pkReason) return { expressible: false, reason: pkReason }`,
~L1257) **before** building the expressible plan, so the whole local op plan —
including the `retype` op `recordAttrShift` already pushed into `postReconcileOps`
for this same column — is discarded. No stale op leaks; the caller raises the sited
`inexpressibleReshapeError` and leaves the table untouched.

Two stale doc comments were inverted to match: `classifyBackingReshape`'s
inexpressible-PK enumeration now lists **type** alongside set/order/direction/
collation; `describePhysicalPkChange`'s docblock now states a key-column type
change *is* a PK-definition change (the old text claimed it was "left to
`alterColumn`, not a PK-definition change").

`alter-table.ts` was **not** touched — the source-side PK-retype block is the
*other* (still-unreachable) entry and is out of scope.

## The reachability finding (verified empirically — this is the crux)

The originating plan asserted this branch was **unreachable dead code** because
`alter column <pk> set data type` is rejected at the source. That holds only for a
PK whose components are the *source* PK columns. It is **false** for an
`order by`-seeded physical PK:

- `computeBackingPrimaryKey` (~L209) seeds the backing's physical PK with the
  body's `order by` columns *leading*, logical key appended as tiebreaker.
- An `order by` column may be a **non-PK** source column, and
  `alter column <non-pk> set data type` **is permitted** at the source.

I verified the precondition empirically before writing the test (throwaway spec,
since removed): for `create materialized view mv as select v, k from t order by v`
over `t(k integer primary key, v text)`, the live backing's
`primaryKeyDefinition` is `[{index:0=v(text)}, {index:1=k(integer)}]` — physical PK
leads with the non-PK column `v`. `alter table t alter column v set data type
integer` then re-derives a body whose PK column `v` is integer while the live
backing's `v` is still text → a genuine, reachable PK-column type change. Without
the fix, `recordAttrShift` queues a `retype` and the reshape is wrongly applied,
re-keying the integer body rows under the **old text comparator**
(`'10' < '9'` text vs `10 > 9` int) → mis-ordered / mis-keyed rows. The fix turns
this into a clean sited error.

## Use cases for testing / validation

Primary black-box test added to `inexpressible → sited error`
(`materialized-view-refresh-reshape.spec.ts` ~L308):

- **Reachable order-by-seeded PK + multi-component PK in one case.** `mv as select
  v, k from t order by v` over `t(k integer primary key, v text)`, values `(1,'10')`,
  `(2,'9')` (sort-order-diverging: text `'10' < '9'`, int `10 > 9`, so a regression
  that *applied* the reshape would visibly mis-order). Asserts the empirical
  precondition first (`primaryKeyDefinition` leads with `v`, `v` is TEXT, PK is
  2-component `[v,k]`); retypes source `v` text→integer; refreshes and asserts:
  the sited error (`/changed incompatibly|primary-key/`), the reason names the
  **seed** column `v` / component 0 (`/'v'|column 0/`) and **not** the tiebreaker
  `k`; no `table_removed/table_added/table_modified` events; column count
  unchanged (2); `derivation.stale === true`; and the stored snapshot still reads
  under the original text key (rows preserved, un-reshaped).

Reviewer's-eye items worth scrutiny / known gaps (your tests are a floor, not a
ceiling):

- **Renamed-AND-retyped PK column** is covered by the code path (comparison is on
  the underlying schemas, name carried through `renameMap`) but is **NOT** directly
  tested — the ticket itself rated it lower priority. If you want belt-and-braces,
  a test would need a body that both positionally renames and retypes the seed PK
  column; I judged it not worth the test-construction complexity given the code is
  demonstrably name-agnostic, but flagging it honestly.
- **No-over-rejection guard** (a *non-PK* column type change must stay expressible):
  not given a *new* dedicated test — the type check lives inside
  `describePhysicalPkChange`, which only iterates PK components, so a non-PK retype
  is structurally unreachable by the new code. The existing expressible-reshape
  suite (`a non-PK attribute shift … reshapes in place`, `a narrowing retype
  validates the reconciled body …`) exercises non-PK retypes and still passes —
  rely on those, but a reviewer may want an explicit "only delta is non-PK retype →
  still expressible" assertion to pin it.
- **Collation/direction independence**: the existing PK-collation-change test
  (~L286) passes unchanged — the new check is additive. Not separately re-asserted
  for direction (no existing PK-direction test exists to extend).

## Validation done

- `yarn workspace @quereus/quereus test` — **5939 passing, 9 pending** (green).
  The target spec runs all 12 cases including the new one.
- `yarn workspace @quereus/quereus lint` — clean (exit 0, no output).
- `yarn workspace @quereus/quereus typecheck` — clean (exit 0).
- `test:store` was **not** run (memory-vtab default per AGENTS.md); this fix is
  classification logic in the emit layer, not store-path-specific, so no store
  divergence is expected — but a reviewer wanting full coverage could run it.

## Acceptance (from the ticket) — status

- PK-column type-change reshape has a defined, tested outcome (sited
  `inexpressibleReshapeError`, table untouched, derivation stale). ✅
- `inexpressible → sited error` suite gains the PK-column-type-change case
  (black-box, reachable per the verified finding — no classifier-unit fallback
  needed). ✅
- Existing expressible-reshape and PK-collation-change tests still pass. ✅
- Test + lint green. ✅ (typecheck also green.)
