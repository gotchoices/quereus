---
description: The database cannot agree with itself on how to order duration values — "sort by this duration" and "is this duration bigger than that one" give opposite answers for the same two rows, and we need a human to decide which meaning is the right one before it can be fixed.
files:
  - packages/quereus/src/vtab/memory/utils/primary-key.ts        # PK BTree comparator (uses logicalType.compare)
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts # PK value-identity encoder (uses byte order)
  - packages/quereus/src/vtab/memory/table.ts                    # getPrimaryKeyComparator, comparePrimaryKey
  - packages/quereus/src/vtab/memory/module.ts                   # advertises PK order (providesOrdering), line ~351
  - packages/quereus/src/util/comparison.ts                      # compareSqlValuesFast (byte), createTypedComparator (type-aware)
  - packages/quereus/src/runtime/emit/sort.ts                    # ORDER BY comparator — byte order only
  - packages/quereus/src/runtime/emit/binary.ts                  # comparison operators — temporal special-case, line ~247/288
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts     # tryTemporalComparison — duration order for timespans, line ~378
  - packages/quereus/src/types/temporal-types.ts                 # TIMESPAN.compare — Temporal.Duration totals
  - packages/quereus/src/types/json-type.ts                      # JSON.compare — structural deep-compare
  - packages/quereus/test/logic/15-timespan.sqllogic             # existing test asserting DURATION order for `>` (line 174-178)
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # existing test asserting BYTE order for advertisement
difficulty: hard
---

# Decision needed: what is the canonical sort order of a duration (and a JSON) value?

## Why this is a human decision, not a fix

The starting bug report (`bug-memory-pk-btree-orders-by-logical-type-compare`) framed this
as "the in-memory table sorts by the wrong rule; make it match the rest of the engine." When
I reproduced it, the problem turned out to be bigger: **the engine does not have one rule to
match.** Different parts of it already order duration values in opposite ways, and they
disagree even in queries that involve no primary key and no in-memory-vs-persistent split.

Because the parts genuinely conflict, any fix has to first pick a winner — and picking the
winner is a product/semantics call ("when a user writes `order by <duration column>`, should
the shortest duration come first, or the one whose text happens to sort first?"). Reasonable
engineers land differently, existing tests encode *both* answers, and the persistent-storage
module's on-disk key format is built around one of them. That is why this is parked for a
human ruling rather than implemented.

A "duration" here is our `TIMESPAN` type: a length of time such as "2 hours" or "90 minutes",
stored as the ISO-8601 text `PT2H` / `PT90M`. `PT2H` is the longer span (7200 seconds) but
`PT90M` is the longer span numerically-by-total... no: `PT90M` is 5400 seconds, shorter. The
trap is that sorting the *text* puts `PT2H` first (because the character `2` sorts before `9`),
which is the *opposite* of sorting by actual elapsed time.

## What actually happens today (all reproduced)

Two rows, `PT2H` (2 hours = 7200 s) and `PT90M` (90 minutes = 5400 s). By elapsed time,
`PT90M < PT2H`. By raw text, `'PT2H' < 'PT90M'` (character `2` < character `9`).

| What you run | Which rule it uses | Answer you get |
| --- | --- | --- |
| `order by <duration col>` (the general sort) | text order | `PT2H`, `PT90M` |
| `where a > b` comparing two duration values | elapsed-time order | treats `PT2H > PT90M` as true |
| in-memory table, ordering by a duration **primary key** | elapsed-time order | `PT90M`, `PT2H` |
| persistent (store) table, same query | text order | `PT2H`, `PT90M` |
| in-memory table, `where dur_pk > 'PT90M'` (a range scan on the key) | **broken** | returns *no rows* — wrong under *either* rule (a plain scan returns `PT2H`) |

So three separate disagreements exist, not one:

1. **Sort vs. comparison.** `order by dur` (text order) contradicts `where dur1 > dur2`
   (elapsed-time order) for the very same column — no primary key or storage module involved.
   This is the root inconsistency; the primary-key story below is a symptom of it.
2. **In-memory vs. persistent.** The two storage backends answer `order by <duration primary
   key>` differently, because the in-memory table advertises its key order (letting the engine
   skip the sort) and that key order is elapsed-time, while the persistent table's key order is
   text.
3. **A plainly broken range scan.** On an in-memory duration primary key, `where dur > 'PT90M'`
   returns nothing, when a full scan of the same rows returns `PT2H`. Whichever ordering wins,
   this answer is wrong and must be fixed as part of the resolution.

There is also a **uniqueness** consequence: `PT60M` and `PT1H` are the same elapsed time
(60 minutes) but different text. The in-memory table rejects the second as a duplicate primary
key (elapsed-time order says "equal"); the persistent table accepts both (text order says
"different"). Whatever is decided for ordering decides this too.

## The two other places the same shape shows up

- **JSON columns** have the *same class* of bug but a **simpler** resolution. Only the in-memory
  primary-key path orders JSON values structurally (by JSON type, then numeric value — so
  `{"a":2}` sorts before `{"a":10}`). Everywhere else — the general sort, the `>` operator, and
  the persistent store — already orders JSON by its canonical text (so `{"a":10}` sorts before
  `{"a":2}`, because `1` < `2`). So for JSON there **is** a single prevailing rule (canonical
  text), and only the in-memory primary key is the outlier. If the decision below is "text order
  wins," the JSON case is a clean, low-risk fix at the same code site.
- The comparison operator's elapsed-time behavior is **timespan-only** — see
  `tryTemporalComparison` in `runtime/emit/temporal-arithmetic.ts`. JSON `>` already uses text
  order. That asymmetry is exactly why timespan is the hard case and JSON is the easy one.

## The decision, and what each choice costs

Both types are fixed at the **same code site** (the primary-key comparator in
`vtab/memory/utils/primary-key.ts` calls `createTypedComparator`, which is what pulls in the
type-specific `.compare`). So they should be decided together even though JSON is easier — a fix
for one touches the other.

**Option A — text order is canonical (elapsed-time comparison goes away).**
Make the in-memory primary key order by text (like the store already does), *and* remove the
timespan elapsed-time special-case from the `>`/`<`/`=` operators so comparison also uses text.
- Pro: cheapest; in-memory and persistent agree everywhere; one rule engine-wide.
- Con: `where dur1 > dur2` would stop meaning "is this a longer span" and start meaning "does
  this text sort later" — a worse SQL surface, and a behavior change that **breaks an existing
  test** (`test/logic/15-timespan.sqllogic` lines 174-178 assert `P2D > PT1H`, i.e. 2 days beats
  1 hour, which is elapsed-time order). Accepting Option A means deliberately changing that test.

**Option B — elapsed-time order is canonical (the sort becomes type-aware).**
Treat the in-memory primary key's current behavior as *correct*, and instead fix the general
sort (`runtime/emit/sort.ts`) to order durations by elapsed time, matching what `>` already
does. The persistent store, whose on-disk keys are text-ordered, would then have to **stop
advertising** that its key order satisfies an `order by <duration>` (and decline key range-scans
on such columns), so the engine runs a real sort for them.
- Pro: matches what a user means and what `>` already does; the in-memory table needs almost no
  change; the whole engine becomes self-consistent.
- Con: broad change touching the sort path and the store module's ordering/seek advertisements;
  the store loses an optimization for these column types.

Under **Option A**, the original bug report's framing holds (the in-memory table is wrong).
Under **Option B**, the framing flips: the in-memory table is right, and the store's
advertisement plus the text-ordered sort are the defects. That flip is the crux of why a human
must choose.

My recommendation, for whatever it's worth: **Option B** for timespan (users mean elapsed time;
`>` already does it; it makes the engine consistent), and fold JSON in as "canonical text order,
fix the in-memory outlier" regardless — because for JSON, text order is *already* the prevailing
rule everywhere else, so aligning JSON to Option A-style text order is correct even if timespan
goes to Option B. But this split (timespan → elapsed-time, JSON → text) is itself a judgment
call, which is the last reason this is a human decision.

## What unblocks this

A one-line ruling on each of:
1. Timespan ordering: text order (Option A) or elapsed-time order (Option B)?
2. JSON ordering: confirm canonical-text order for the in-memory primary key (align it to the
   rest of the engine)?

Once decided, this becomes a normal fix/implement ticket. The broken range scan (row 3 in the
table above) and the uniqueness divergence are fixed as part of whichever direction is chosen —
they are not separate decisions.

## Reproduction (for the implementer, once unblocked)

```sql
create table m (d timespan primary key);
insert into m values ('PT2H'), ('PT90M');
select d from m order by d;            -- in-memory: PT90M, PT2H (sort skipped, key order)
select d from m where d > 'PT90M';     -- in-memory: (no rows) -- BUG, should be PT2H

create table s (id integer primary key, d timespan);
insert into s values (1, 'PT2H'), (2, 'PT90M');
select d from s order by d;            -- PT2H, PT90M (a real sort runs — text order)
select d from s where d > 'PT90M';     -- PT2H (elapsed-time order)
```
