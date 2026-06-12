description: Make `describePhysicalPkChange` treat a PK-column *type* change as a PK-definition change (inexpressible → sited "alter and re-attach, or drop and recreate" error), matching the source's refusal to retype a PK column in place. Add a PK-column-type-change case to the `inexpressible → sited error` suite. Planning found this path is **reachable** (not dead code) via an `order by`-seeded physical PK over a non-PK source column, which makes the keying hazard live and the test black-box.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # describePhysicalPkChange (~L1280) — add the PK-column type check; classifyBackingReshape (~L1183) doc
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts   # inexpressible → sited error describe block (~L255)
  - packages/quereus/src/runtime/emit/alter-table.ts                  # ~L880 — source-side "Cannot SET DATA TYPE on PRIMARY KEY column" (context only; do NOT change)
difficulty: medium
----

# Reject a PK-column type change as an inexpressible reshape

## Triage decision (locked)

**Reject explicitly.** Make `describePhysicalPkChange` treat a PK-column *type*
change as a PK-definition change — inexpressible → the sited
`inexpressibleReshapeError` ("alter the table to the new shape and re-attach, or
drop and recreate"). This matches the source's own refusal to retype a PK column
in place (`runAlterColumn`, `alter-table.ts` ~L880: *"Cannot SET DATA TYPE on
PRIMARY KEY column"*). The "support it properly" branch is out of scope.

## Planning finding that changes the original ticket's premise

The originating plan ticket asserted the post-reconcile PK-column-retype branch
is **unreachable dead code** (because `alter column <pk> set data type` is
rejected at the source). That is true only for a PK whose components are the
*source* PK columns. It is **false** for an `order by`-seeded physical PK:

- `computeBackingPrimaryKey` (`materialized-view-helpers.ts` ~L209) seeds the
  backing's physical PK with the body's `order by` columns, *leading* the key,
  with the logical key appended as a tiebreaker.
- An `order by` column can be a **non-PK source column**, and
  `alter column <non-pk> set data type …` is **permitted** at the source
  (`alter-table.ts` only blocks retype on a *PRIMARY KEY* source column).
- So: `create materialized view mv as select v, k from t order by v` over
  `t(k integer primary key, v text)` gives `mv` a physical PK seeded by `v`
  (text). `alter table t alter column v set data type integer` then re-derives a
  body whose PK column `v` is integer, while the live backing's PK column `v` is
  still text — a genuine, **reachable** PK-column type change.

This means the branch is not merely dead — it is a **live keying hazard** today:
`recordAttrShift` (~L1202) already pushes a `retype` op for the PK column into
`postReconcileOps`, and `describePhysicalPkChange` currently returns `null` for a
type-only delta (it checks name/direction/collation but **not type**), so the
reshape is wrongly classified *expressible*. The reconcile then keys the
re-derived integer body rows under the **old text comparator** before the retype
runs — `'10' < '9'` (text) vs `10 > 9` (int) → mis-ordered / mis-keyed rows. The
fix turns this into a clean sited error and the test is plain black-box SQL (no
need to export internals or hand-build a `BackingShape`).

## The change

In `describePhysicalPkChange` (`materialized-view-helpers.ts` ~L1280), inside the
per-component loop (after the name check, alongside direction/collation), add a
**type** comparison using the existing shared predicate `backingTypeMatches`:

```ts
if (!backingTypeMatches(curCol, shCol)) {
    return `primary-key column ${k} '${curCol.name}' type ${curCol.logicalType.name} → ${shCol.logicalType.name}`;
}
```

`curCol`/`shCol` are already in scope as `current.columns[currentPk[k].index]`
and `shape.columns[shapePk[k].index]` — the right schemas to compare (a rename
carried via `renameMap` does not change a column's type identity, so a
renamed-and-retyped PK column still trips this).

This only narrows the PK loop — a **non-PK** column retype stays expressible
(routed to the post-reconcile batch, unchanged), because the type check lives
inside `describePhysicalPkChange`, which only iterates PK components.

Update the two stale doc comments that currently assert the opposite:

- `describePhysicalPkChange`'s docblock (~L1276-1278) ends with *"…only a
  key-column type change is left to `alterColumn`, which is not a PK-definition
  change."* — invert it: a key-column **type** change *is* a PK-definition change
  and is now rejected as inexpressible (re-keying replicated row identity in
  place is refused, same as a set/order/direction/collation change).
- `classifyBackingReshape`'s docblock (~L1166-1168) enumerates the inexpressible
  PK change as *"column set, order, direction, or collation of the key"* — add
  **type** to that list.

When the function returns the new reason, `classifyBackingReshape` returns
`{ expressible: false }` and discards the whole op plan — the `retype` op that
`recordAttrShift` already pushed into `postReconcileOps` is dropped with it, so
no stale op leaks. Confirm this by reading the early-return at ~L1254-1255.

Do **not** touch `alter-table.ts` — the source-side PK retype block stays as is;
it is the *other* (still-unreachable) entry, and this fix is about the
reshape-classification entry.

## Edge cases & interactions

- **Reachable order-by-seeded PK (the primary case).** `mv as select v, k from
  t order by v` over `t(k integer primary key, v text)`; retype source `v`
  text→integer; refresh must raise the sited inexpressible error, leave the table
  untouched, and keep the derivation `stale`. Use sort-order-diverging values
  (`'10'`,`'9'` → `10`,`9`) so a regression that *applied* the reshape would
  visibly mis-order rows. **Verify the precondition empirically first**: assert
  `db.schemaManager.getTable('main','mv')!.primaryKeyDefinition` actually leads
  with `v`'s column index before the source alter — if the optimizer does not
  carry the body `order by` into the backing shape (so `v` is not in the PK), the
  scenario is not reachable this way and you must fall back (see below).
- **Multi-component PK, only the seed retypes.** `[v(text), k(integer)]` →
  `[v(integer), k(integer)]`: the name/direction/collation checks pass on both
  components and the type check must fire on component 0 (`k=0`) — assert the
  reason names column 0 / `v`, not `k`.
- **Renamed + retyped PK column.** A positional rename routes the column through
  `renameMap`, so the name check passes; the type check must still reject. (Lower
  priority to test, but the code path must be correct — the comparison is on the
  underlying column schemas, which carry the post-rename type.)
- **Non-PK retype stays expressible (no over-rejection).** A reshape whose only
  delta is a *non-PK* column type change must still classify expressible and
  reconcile in place — guard against accidentally globalizing the type check.
  The existing expressible-reshape tests cover this; make sure they still pass.
- **Collation vs type independence.** The existing PK-collation-change test
  (`spec.ts` ~L286) must still pass unchanged — the new type check is additive,
  not a rewrite of the collation/direction checks.
- **Table left coherent on rejection.** No `table_removed`/`table_added`/
  `table_modified` events; column count unchanged; stored snapshot still reads
  correctly; `derivation.stale === true` (mirror the assertions in the existing
  interleaving-reorder test ~L256).

## Fallback if the order-by seed is not reachable as black-box

If empirical inspection shows the body `order by` does **not** seed the physical
PK over a non-PK column (so no supported source op can present a PK-column type
change), the path is genuinely unreachable end-to-end. In that case the goal is
unchanged — the branch must not be silently dead — so prove the classifier
rejects it directly: export `classifyBackingReshape` (or a thin test seam) and
assert `{ expressible: false }` with a PK-type reason against a hand-built
`current` + `BackingShape` differing only in a PK column's `logicalType`. Prefer
the black-box test; only fall back if reachability genuinely fails.

## Acceptance

- A reshape whose only delta is a PK-column type change has a **defined, tested**
  outcome: the sited `inexpressibleReshapeError` ("…alter the table to the new
  shape and re-attach, or drop and recreate"), table untouched, derivation
  `stale`.
- The `inexpressible → sited error` suite gains a PK-column-type-change case
  (black-box if reachable per the finding above; otherwise the classifier unit
  assertion).
- Existing expressible-reshape and PK-collation-change tests still pass.
- `yarn workspace @quereus/quereus test` green; `yarn workspace @quereus/quereus
  lint` clean.

## TODO

- Read `describePhysicalPkChange` (~L1280) and the early-return at
  `classifyBackingReshape` ~L1254 to confirm the discarded-plan reasoning.
- Add the `backingTypeMatches(curCol, shCol)` check + reason string inside the PK
  loop.
- Update both stale doc comments (PK-column type change is now a PK-definition
  change / add "type" to the inexpressible enumeration).
- Empirically confirm `mv as select v, k from t order by v` seeds the physical PK
  with `v` (inspect `primaryKeyDefinition`); if so, write the black-box reachable
  test, else write the classifier-unit fallback.
- Add the PK-column-type-change test to the `inexpressible → sited error`
  describe block in `materialized-view-refresh-reshape.spec.ts` with sort-order-
  diverging values and the table-untouched / stale assertions.
- Run `yarn workspace @quereus/quereus test` and `lint`; fix anything in-diff.
