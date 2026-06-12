description: An identity-preserving refresh reshape applies survivor attribute shifts (alterColumn setDataType / setCollation) to the live PRE-reconcile rows, so a narrowing/recollation that the fresh body data satisfies but the stale backing rows do not throws a spurious MISMATCH/CONSTRAINT — turning an expressible reshape into an error, and a re-run does not self-converge. Mirror the NOT NULL tighten deferral (or clear-then-reshape) so attribute shifts validate against the reconciled body rows, not the data the reshape is about to discard.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # classifyBackingReshape (recordAttrShift / plan.ops ordering), reshapeBackingInPlace (ops loop runs BEFORE rebuildBacking; tightenNotNull is the only deferred class)
  - packages/quereus/src/vtab/memory/layer/manager.ts                 # alterColumn: setDataType iterates+validateAndParse existing rows (throws MISMATCH); setCollation → rebuildAllSecondaryIndexesStrict (throws CONSTRAINT on a stale-data unique collision)
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts   # add the narrowing-retype + recollate-collision + re-run-after-data-fix cases
  - packages/quereus-store/test/mv-store-backing.spec.ts              # store reshape narrowing parity (durable path)
difficulty: medium
----

# Reshape attribute shifts validate against the discarded (pre-reconcile) backing

## Symptom

A `refresh materialized view` whose re-derived body shape shifts a **surviving**
column's **type** or **collation** can fail with a `MISMATCH` / `CONSTRAINT`
error even though the reshape is classified *expressible* and the freshly
re-derived body rows would satisfy the new attribute. The MV is left `stale`, and
**a re-run refresh fails identically** — it does not self-converge — because the
offending data is the stale backing's, not the body's.

## Root cause

`reshapeBackingInPlace` (the in-place leg added by
`6.5-maintained-table-identity-preserving-reshape`) reshapes by:

1. applying every `plan.ops` entry through the host module's `alterTable`
   (renames → adds → **attribute shifts (retype / recollate / loosen)** → drops),
   **then**
2. `rebuildBacking` — re-run the body and `replaceContents`, fully discarding the
   old rows, **then**
3. asserting the deferred NOT NULL tightenings (`plan.tightenNotNull`).

Because the data is fully replaced in step 2, the *only* thing step 1 must achieve
is morphing the schema; the pre-reconcile rows are about to be thrown away. The
implementer recognised this for **ADD NOT NULL** and deferred the tighten to step 3
("a non-empty backing never trips ADD NOT NULL without a default"). The **same
hazard applies to narrowing type and collation shifts**, but those are *not*
deferred — they run in step 1 against the live old rows:

- `MemoryTable.alterColumn` with `setDataType` (physical conversion) iterates the
  primary tree and `validateAndParse`s every existing value, throwing `MISMATCH`
  on the first non-convertible one (`manager.ts` ~L1760-1787).
- `setCollation` runs `rebuildAllSecondaryIndexesStrict`, throwing `CONSTRAINT` on
  a stale-data UNIQUE collision under the new collation (`manager.ts` ~L1826-1830).

So a maintained passthrough column whose source type/collation narrows — where the
stale backing still holds the pre-narrowing values but the re-derived body produces
conforming ones — errors on a reshape that should succeed. And since `plan.ops`
runs before the reconcile on every attempt, the residual delta on a re-run still
contains the same retype against the same stale rows: **non-converging** (contra
the doc/handoff claim that "a re-run refresh re-derives the residual delta and
converges"; that holds for the NOT NULL tighten, not for narrowing attr shifts).

## Reproduction (sketch)

```
create table t (id integer primary key, v text);
insert into t values (1, 'abc');            -- non-integer-coercible
create materialized view mv as select * from t;   -- backing v: text, holds 'abc'
-- source narrows v, and the row that no longer conforms is removed/updated so the
-- NEW body is integer-clean, but the backing still holds 'abc':
delete from t where id = 1;  insert into t values (1, 42);
alter table t alter column v set data type integer;
refresh materialized view mv;               -- EXPECTED: reshape to integer + refill {1,42}
                                            -- ACTUAL:   MISMATCH converting backing 'abc'
refresh materialized view mv;               -- still MISMATCH (non-converging)
```

(An analogous case: a non-PK survivor `set collate` with a stale-data unique
collision under a covering structure → `CONSTRAINT` in the strict secondary-index
rebuild.)

## Fix direction (a design choice — pick with the dev)

The two columns of the trade-off the implementer already navigated for NOT NULL:

- **Defer narrowing attr shifts past the reconcile** (preferred symmetry with
  `tightenNotNull`): split survivor attribute shifts into a pre-reconcile class
  that the *old* rows always tolerate and a post-reconcile class asserted on the
  reconciled body rows. Caveat: the reconcile's `replaceContents` must accept the
  new-typed/-collated values into the not-yet-altered column — confirm the memory
  (and store) base-layer insert path is loose enough, or stage the type widen
  before / narrow after.
- **Clear-then-reshape**: drop the backing's rows *before* the structural ops, so
  every `alterTable` runs on an empty table (no value ever trips), then refill.
  Simpler and uniform, but a mid-sequence failure leaves an **empty** table rather
  than the recoverable old snapshot — revisit the "leave old data on failure"
  recoverability stance the current ordering was chosen for.

Whichever path: also pin the **store** (durable) reshape under the same narrowing —
the store module's `alterColumn` arms are currently exercised only by the
trailing-nullable-add case — and the **PK-column *type* change** route
(`alterColumn setDataType` on a PK column: memory's re-key-on-type-change path is
untested; the classifier permits it since only key set/order/direction/collation
are PK-definition changes).

## Tests to add

- A narrowing **retype** on a survivor where stale backing data is non-conforming
  but the re-derived body is clean → reshape succeeds (value under the right label,
  column type updated), no `MISMATCH`.
- A survivor **recollate** with a stale-data unique collision but a clean body →
  reshape succeeds.
- **Convergence after an actual mid-sequence module throw**: force a reshape failure
  (narrowing that even the body can't satisfy, or a forced `alterColumn` MISMATCH),
  fix the underlying data, re-refresh, assert it converges — the recovery leg the
  6.5 suite documents but never exercises beyond the NOT NULL fast-path second
  refresh.
- Store parity for the narrowing reshape (durable path), ideally inside an explicit
  transaction (multiple `alterTable` + one `replaceContents`).
