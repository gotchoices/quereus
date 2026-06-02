description: An UPDATE through a view whose SET list targets two view columns that lower to the **same** base column silently applies last-wins instead of rejecting (or otherwise signalling). `update v set b = 5, bp = 100` on `create view v as select id, b, b + 1 as bp from t` lowers to `set b = 5, b = 99` and stores `b = 99` — the `b = 5` assignment is silently dropped. Pre-existing class (reachable before via duplicate identity/rename projections, e.g. `select b, b as b2` → `set b = 1, b2 = 2`), but `single-source-inverse-column-static-dynamic-divergence` widened the surface by making `inverse` columns writable. No diagnostic, no test today.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/runtime/emit/update.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## Problem

`rewriteViewUpdate` (single-source) maps each view-column assignment to a base-column
assignment independently. When two distinct view columns resolve to the same base
column, the lowered statement carries two assignments to that base column. The base
UPDATE executor (`runtime/emit/update.ts`) applies regular assignments in list order
into `updatedRow[targetIndex]`, so a later assignment to the same column index
overwrites the earlier one — **silent last-wins**, no error.

### Confirmed repro (observed during review)

```sql
create table t3 (id integer primary key, b integer null);
insert into t3 values (1, 10);
create view v3 as select id, b, b + 1 as bp from t3;   -- b and bp both lower to base b
update v3 set b = 5, bp = 100 where id = 1;            -- lowers to: set b = 5, b = (100 - 1)
select b from t3 where id = 1;                          -- 99  (b = 5 silently dropped)
```

The user wrote two contradictory intents (`b = 5` and `bp = 100`, i.e. `b = 99`) and got
one applied with no signal. The result is also order-dependent on the SET-list spelling.

The same shape is reachable without the inverse feature via duplicate identity/rename
projections (`select b, b as b2 …; update v set b = 1, b2 = 2`), so this is a
**pre-existing** correctness gap; the inverse ticket only widened the set of projections
that can collide onto one base column.

## Expected behavior (to decide in this ticket)

Settle the semantics, then enforce it consistently across **both** the single-source and
multi-source spines (multi-source `decomposeUpdate` has the same independent-mapping
shape):

- **Reject** is the safest default: a structured diagnostic (e.g. `conflicting-assignment`)
  when two SET targets lower to the same base column — whether or not the assigned values
  agree. This matches SQL's general intolerance of assigning a column twice in one UPDATE.
- A softer option is to reject only when the lowered values **differ** (allow `set b = 5,
  bp = 6` because both imply `b = 5`), but value-equality of arbitrary expressions is
  undecidable in general, so this is more complex and probably not worth it.

Also confirm what the base-table UPDATE path itself does with a directly-written duplicate
(`update t set b = 1, b = 2`) — if the parser/builder already rejects that, the view path
should produce the same diagnostic rather than silently lowering into it.

## Scope

- Detect duplicate base-column targets after lowering (single-source `rewriteViewUpdate`
  assignment map; multi-source `decomposeUpdate` per-base-op assignment fan-out) and raise
  a structured `raiseMutationDiagnostic`.
- Add `93.4` sqllogic coverage: the inverse-vs-base collision above, the duplicate-rename
  collision (`select b, b as b2`), and a same-value case to confirm the chosen semantics.
- Decide and document the semantics in `docs/view-updateability.md`.

## Severity / disposition

Pre-existing, narrow, and requires a small semantics decision — but it is a silent
wrong-write (data corruption relative to user intent), so worth a deliberate fix rather
than leaving latent. Flagged explicitly by the implementer of the inverse ticket as an
open reviewer decision.
