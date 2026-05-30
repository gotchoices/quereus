description: The engine-generated `partial` lens backfill emits a key-only skeleton `insert` that leaves the genuinely-new column NULL for the app to UPDATE. Because Quereus columns are NOT NULL by default, that skeleton insert fails an unguarded NOT NULL constraint at runtime for the common case — the generated `backfill_sql` is un-runnable as documented. Decide + implement the right behavior (reclassify to `needs-data`, omit the skeleton, or guard), and surface nullability/default in the snapshot so the classifier can decide.
files: packages/quereus/src/schema/basis-backfill.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/test/lens-backfill.spec.ts, docs/lens.md
----

## Problem

`computeBasisBackfill` (`src/schema/basis-backfill.ts`) classifies a new basis
relation as `partial` whenever **≥1** of its columns is reconstructible from the
prior get-body. For a `partial` relation it generates

```sql
insert into <R> (<reconstructible cols>) select <cols> from (<prior get>) as __lens_prior
```

— i.e. a **key-only skeleton** when the only reconstructible columns are the join
key(s). The intended flow (docs/lens.md § Sequencing contract): run `backfill_sql`
to seed the skeleton rows, then the application `UPDATE`s the genuinely-new
columns.

The skeleton insert leaves every `missing` column unset → NULL. **Quereus columns
are NOT NULL by default** (verified: `create table T (id integer primary key, color text); insert into T (id) values (1)` → `NOT NULL constraint failed: T.color`).
So whenever a `missing` column is NOT NULL and has no default — the *common*
case, since NOT NULL is the default — running the generated `partial`
`backfill_sql` verbatim fails at runtime. The documented "run it then UPDATE"
contract is impossible: you cannot insert the skeleton row first.

This was flagged at implement time as a design question ("is skeleton-insert the
right default?") and confirmed at review as a real runtime failure, not just an
open question. The existing `partial` test (`lens backfill: new column needs
application data`) only asserts *classification* and that `color` is never
fabricated — it never runs the partial `backfill_sql`, which is why the failure
was latent. The review added `lens backfill: partial backfill runs end-to-end`
which exercises the runnable path by declaring the new column explicitly
`null`; the NOT-NULL-default path is the gap this ticket owns.

## Root cause

The classifier has no visibility into basis-column nullability or defaults. The
deployment snapshot's `LensRelationBacking.columns` carries only
`{ basisColumn, logicalColumn }` pairs — no `notNull` / `hasDefault`. So
`classifyRelation` cannot tell a skeleton-able relation (missing cols nullable or
defaulted) from an un-skeleton-able one (a NOT NULL missing col with no default).

## Expected behavior / options to decide

The fix-stage research should pick among (and the choice belongs to the dev — ask
if unsure):

1. **Reclassify.** A relation whose missing columns include a NOT-NULL,
   no-default basis column cannot be skeleton-inserted. Either:
   - downgrade the whole relation to `needs-data` (app owns the entire insert), or
   - keep `partial` but emit `backfill_sql = null` (only `generated_columns` /
     `missing_columns` populated) so the app never tries to run an insert that
     must fail, with the `reason` explaining the NOT-NULL block.
2. **Keep the skeleton but make it sound** by synthesizing column defaults the
   basis declares (only when *every* missing col is nullable or defaulted —
   otherwise fall back to option 1).

Whichever is chosen, the snapshot must capture enough basis-column metadata
(`notNull`, and whether a default exists) for the classifier to decide
deterministically from the snapshot pair alone (preserving the "snapshot, not
live catalog, is the source of truth" invariant — see docs/lens.md). Capture it
in `deriveRelationBacking` (`src/schema/lens-compiler.ts`) where the basis
`TableSchema`/columns are already in hand.

## Acceptance

- Running the generated `backfill_sql` for any emitted row never fails an
  unguarded NOT NULL constraint (either it is sound to run, or it is `null` and
  the app is told to own the insert).
- A test re-decomposing into a member with a **NOT NULL, no-default** new column
  asserts the chosen behavior (no un-runnable skeleton SQL is emitted as
  runnable), alongside the existing nullable-column happy path.
- docs/lens.md § Classification updated to state the NOT-NULL rule explicitly.
