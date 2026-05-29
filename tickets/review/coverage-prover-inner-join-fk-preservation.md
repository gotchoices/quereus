description: Review the coverage prover's new INNER/CROSS-equi join admit path — it now admits an inner/cross join body as covering a single-table UNIQUE on T when a NOT-NULL FK→PK from T to the lookup table proves the inner join loses no T rows (extends the LEFT/RIGHT outer-join admit path).
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/util/key-utils.ts, docs/materialized-views.md, docs/optimizer.md
----

## What landed

`proveCoverage` (`planner/analysis/coverage-prover.ts`) previously admitted a join
body as covering `unique(...)` on base table `T` **only** when `T` sat on the
row-preserving side of a LEFT/RIGHT outer join (+ the no-fan-out gate). It now also
admits an **INNER (or CROSS-with-equi) join** when `T`'s rows are provably retained
by enforced referential integrity.

The shape-walk side/type gate was refactored from "reject everything but
preserving-side outer joins" into an explicit two-path **no-row-loss** test:

- **(a) row preservation** (unchanged) — `T` on the preserving side (`left`→left
  subtree, `right`→right subtree).
- **(b) referential integrity** (new) — `innerJoinRetainsConstrainedTable`: an
  `inner`/`cross` join whose equi-pairs are a **NOT-NULL FK from `T` to the lookup
  table's primary key**, over a lookup side that exposes the parent's **full** row
  set. Enforced RI then makes every `T` row match exactly one lookup row ⇒ no loss.

New private helpers in `coverage-prover.ts`:

- `innerJoinRetainsConstrainedTable(join, tSide, lookupSide, baseTable)` — the
  no-row-loss proof. Maps the join's equi-pairs (attribute-id form) to base-column
  indices on each side, then `lookupCoveringFK(T, lookup, fkCols, pkCols)` (from
  `ind-utils.ts`) + `!match.nullable`.
- `pureJoinEquiAttrPairs(join)` — equi-pairs of a join as attr-id pairs, or
  `undefined` if the join carries any residual / non-equi condition (physical
  `BloomJoin`/`MergeJoin`: `residualCondition` must be unset; logical `JoinNode`:
  `condition` must be a pure AND-of-column-equalities, checked by
  `isPureColumnEquiCondition`). A residual conjunct could drop `T` rows the FK
  guarantee assumes survive, so it disqualifies.
- `resolveFullScanTableRef(lookupSide)` — the optimized-plan analogue of
  `ind-utils.ts`'s `isRowPreservingPathToTable`. Returns the lookup leaf
  `TableReferenceNode` iff the path is full-row-set: bare `TableReference`, full
  (non-`rangeBoundedOn`) `SeqScan`/`IndexScan`, `Alias`/`Sort`/`Retrieve`. Any
  seek/filter/limit/distinct/etc. ⇒ `undefined` ⇒ reject.
- `findConstrainedTableRef` — returns `T`'s `TableReferenceNode` (vs. the existing
  boolean `subtreeContainsConstrainedTable`) so equi-pair attr-ids map to `T` cols.

The **no-fan-out** obligation (`proveJoinOneToOne` → `isUnique(T.pk, topJoin)`) and
the name-collision guard are **unchanged**; a NOT-NULL FK→PK join passes them
automatically (the FK target is the unique PK). All LEFT/RIGHT/single-source v1
behavior is byte-for-byte unchanged (the refactor preserves every prior outcome —
verified by the untouched existing tests).

## Why `ind-utils.ts`, not just `key-utils.ts`

The ticket named `key-utils.ts` (`checkFkPkAlignment`) as the FK seam. I used
`lookupCoveringFK` from `ind-utils.ts` instead because it **returns the FK's
nullability bit**, which the scope explicitly requires (NOT-NULL FK). This mirrors
exactly how `rule-join-elimination`'s INNER branch proves the same property.
`key-utils.ts` is unchanged.

## Soundness — the load-bearing assumption (REVIEW THIS)

The admit path is sound **iff Quereus enforces declared FKs as inclusion
dependencies** (`child.fk ⊆ parent.pk`). Confirmed:

- `foreignKeys` defaults to `true` (`common/types.ts`); `pragma foreign_keys` gates
  runtime enforcement.
- The whole `ind-utils.ts` module and the INNER branches of `rule-join-elimination`
  + `rule-fanout-lookup-join` **already** trust declared FKs this way, with **no
  pragma gate**. Admitting the same shape in the prover introduces no new
  assumption: if FKs were advisory (or RI disabled + orphan child rows inserted),
  inner join elimination would already be unsound — a global optimizer stance, not
  one this prover owns.

**Decision I made (please confirm):** I did **not** gate the prover on
`pragma foreign_keys`, for consistency with join elimination (and because the pragma
can be toggled after MV creation, so a creation-time check is illusory anyway). If
the team wants belt-and-suspenders, the gate would have to live at enforcement time,
not here. Documented in the module doc § "Referential-integrity soundness".

Mitigating context: a **join-bodied MV is not row-time-enforcement-eligible**
(`containsAnyJoin` ⇒ single-source gate fails), so a covering link on a join MV
cannot currently drive a row-time ABORT / miss a conflict. The link is informational
for join bodies in this release. Still, treat the RI assumption as load-bearing for
any future enforcement consumer.

## Use cases — what to test / validate

Positive (should cover):
- `orders` (`unique(customer_id, sku)`, `foreign key (customer_id) references
  customers(id)`) `inner join customers c on o.customer_id = c.id`, projecting
  `c.name` so the join survives elimination, `order by customer_id, sku` → covers.
- Composite NOT-NULL FK `(pa, pb) references parent(a, b)` inner join → covers.

Negative (must NOT cover, reason `shape`):
- NULLABLE FK (declare the FK column `... null` — **Quereus columns are NOT NULL by
  default**, Third Manifesto; `column.ts:createDefaultColumnSchema`): NULL FK has no
  parent ⇒ inner join drops the row.
- Non-FK equi-join to a UNIQUE-but-non-PK lookup key (no inclusion guarantee).
- Inner join with **no** FK declared (the pre-existing negative test, intact).

Tests added to `test/covering-structure.spec.ts` § "multi-source (join) bodies":
2 positive (single + composite FK), 2 negative (nullable FK, non-FK unique key),
1 eager-link. Full quereus suite: **3818 passing, 0 failing, 9 pending** (the 9
pending are pre-existing). Build, typecheck, lint clean. No `.pre-existing-error.md`.

## Known gaps / things to scrutinize (tests are a floor, not a ceiling)

- **`resolveFullScanTableRef` full-scan detection.** I treat a `SeqScan`/`IndexScan`
  with `rangeBoundedOn` unset as a full scan. Evidence it's complete: the access
  rule emits filters as **explicit `Filter` nodes above** the scan (rejected by the
  walk) and sargable bounds as `rangeBoundedOn` (rejected); equality on an index
  becomes an `IndexSeek` (rejected). **Please double-check** no other row-reducing
  `SeqScan`/`IndexScan` form exists (e.g. handled `filterInfo.constraints` without
  `rangeBoundedOn`). A false "full scan" here would be a false `Covers`.
- **Module-hidden filters.** If a vtab module consumed a pushdown filter into a
  surviving `RetrieveNode`'s `moduleCtx` (rather than producing a `RemoteQueryNode`),
  a filtered lookup side could slip through `resolveFullScanTableRef`. Not observed
  for the memory vtab (a supported pipeline becomes a `RemoteQueryNode`, not a
  filtered `Retrieve`). Confirm for index/remote backends if this path is exercised
  there.
- **`isPureColumnEquiCondition` duplicates `isAndOfColumnEqualities`**
  (`rule-join-elimination.ts`). I wrote a small local copy to avoid an analysis→rules
  layering inversion (analysis must not import from `rules/`). Could be DRYed by
  hoisting that helper to a shared util — judgment call left to the reviewer.
- **CROSS-with-equi is handled by construction, not by an explicit test.** The code
  admits `joinType === 'cross'`, but a cross join carrying equi-pairs is unusual to
  produce from SQL (cross joins have no ON clause); no dedicated test exercises a
  `cross` `BloomJoin` with `equiPairs`. Inner is fully tested.
- **NestedLoopJoin.** No `NestedLoopJoinNode` class exists; a logical inner join that
  stays nested-loop remains a `JoinNode` (handled). If a future physical
  NestedLoopJoin node with `equiPairs` appears, `pureJoinEquiAttrPairs` returns
  `undefined` ⇒ conservative reject (not unsound, just incomplete).
- **Surface area.** The inner-FK multi-source path only fires when the lookup side is
  **referenced** in the body (else `rule-join-elimination` collapses the FK→PK join
  to the v1 single-source chain, which already covers). The positive tests project a
  lookup column to keep the join alive. Verify this is the intended/expected surface.

## Suggested review focus

1. The RI-trust decision (no pragma gate) — accept, or file a follow-up to gate
   enforcement.
2. `resolveFullScanTableRef` completeness (the only place a false `Covers` could
   originate from a row-reduced lookup side).
3. Equi-pair → base-column mapping in `innerJoinRetainsConstrainedTable` (attr-id
   classification handles the T-on-left and T-on-right symmetry; composite + permuted
   FK pairs are rejected by `lookupCoveringFK`'s positional alignment — spot-check).
