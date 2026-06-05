description: A both-side outer-join INSERT through a view threads the minted shared key into the preserved side's join column unconditionally, even for rows whose non-preserved value is null (the per-row presence gate drops that side's insert). The preserved row then points its FK at a minted key with no partner row — a dangling reference (FK violation with enforcement on; latent spooky-join if that key is ever materialized). Fix: thread the shared key into the preserved side conditionally per row (`<joinKey> = case when <non-preserved present> then <key> else null`).
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Repro

```sql
pragma foreign_keys = true;  -- the bug is masked with FK off
create table ojp (pp integer primary key default (coalesce((select max(pp) from ojp),0)+mutation_ordinal()), pv integer null);
create table ojc (cc integer primary key, pr integer null references ojp(pp), cv integer null);
create view ojv as select c.cc as cc, c.cv as cv, p.pv as pv from ojc c left join ojp p on p.pp = c.pr;

-- pv is in the column list ⇒ the parent (non-preserved) side is STATICALLY active ⇒
-- the child side threads the minted shared key into ojc.pr. But pv is NULL for this
-- row ⇒ the parent side's per-row presence gate (`pv is not null`) drops the parent
-- insert. Result: ojc.pr = <minted K>, but no ojp row has pp = K.
insert into ojv (cc, cv, pv) values (5, 55, null);
```

With FK enforcement on this is a constraint violation (or, depending on order, a dangling FK). With FK off it reads back correctly null-extended (the left join finds no `pp = K`), so it is silent today — but the base `ojc.pr` holds a bogus surrogate instead of `null`, and if a parent row with `pp = K` is ever inserted the previously-null-extended view row spontaneously joins.

## Why it happens

`analyzeMultiSourceInsert` (`multi-source.ts`) decides a non-preserved side is **active** statically — "≥1 of its columns appears in the supplied set" — and, when ≥2 sides are active, threads the minted shared key into *every* active side's join-key column unconditionally. The non-preserved side additionally carries a per-row `presenceGateIndices` so its *own* insert is dropped for rows that supply only nulls — but the **preserved** side's key thread is not gated, so the FK column is populated even when the partner row is absent for that row.

The statically-absent case (a non-preserved side with **no** supplied columns at all) is already correct: it is inactive, no key is threaded, the preserved-only insert leaves the join column null. Only the *per-row* null within a statically-active side is wrong.

The implementer documented this as a known gap ("Dangling minted key on a per-row-absent non-preserved value") and tested only FK-off single-non-null-row inserts.

## Fix

Thread the preserved side's join-key column **conditionally per row**: where a minted key is shared with a presence-gated non-preserved side, the preserved side projects `case when <that side's presence predicate> then <key> else null end` into its join-key column instead of the raw key. Reuse the presence predicate already built for the non-preserved side (`buildPresenceGate`). When the preserved side's join column is its own FK referencing the non-preserved side, a null is the correct "no partner" marker (matching the preserved-only insert).

Generalize to n-way: a preserved side's join-key column tied (via the equivalence class) to a presence-gated optional member gets the conditional; a key shared only among always-active sides stays unconditional.

## Acceptance

- The repro above round-trips with `pragma foreign_keys = true`: `ojc.pr` is null, the view reads `{cc:5, cv:55, pv:null}`, no FK violation.
- A both-side insert with a **non-null** pv still threads the real key and the parent row materializes (unchanged happy path).
- A multi-row VALUES / SELECT source mixing null and non-null non-preserved values routes each row independently.
- Extend the LEFT-join property test (`property.spec.ts`) to run with FK on and to include rows where `joined` is true but pv is null, and add a `93.4-view-mutation.sqllogic` case under FK enforcement.
- Update the "Known gaps" note in `docs/view-updateability.md` (remove the documented gap once fixed).
