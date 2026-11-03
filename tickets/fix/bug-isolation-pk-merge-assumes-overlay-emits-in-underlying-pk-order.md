description: Inside a transaction, reading a table wrapped by the isolation layer can return a row twice (once with its old value, once with the new) when the underlying module sorts its primary keys differently from the in-memory table that holds the uncommitted changes.
architecture: docs/design-isolation-layer.md
files:
  - packages/quereus-isolation/src/isolated-table.ts   # mergedQuery primary-key branch (~:467-487) and queryOverlayAsMergeEntries (~:877) — the overlay stream is merged in whatever order the overlay MemoryTable emits
  - packages/quereus-isolation/src/merge-iterator.ts   # mergeStreams — walks both inputs in step under comparePK; correct only if BOTH inputs are ordered by it
  - packages/quereus-isolation/test/isolation-layer.spec.ts  # likely home for the reproduction
  - docs/design-isolation-layer.md                     # "Solution: Module-Provided Comparator" (~:698-719) promises comparator agreement the code does not enforce
repro: verified
----

Filed from the lamina board while planning lamina slug `bug-claimed-leading-member-scan-emits-outside-covering-index-order`.

## What happens

The isolation layer's primary-key merge (`IsolatedTable.mergedQuery`, the branch taken for a full scan or any access path whose index has `role: 'primary'`) feeds two streams to `mergeStreams` and compares them with `getComparePK()`, which prefers the underlying table's `comparePrimaryKey`:

- the underlying stream, which the underlying module emits in its own order — the order its `comparePrimaryKey` states;
- the overlay stream, which comes straight out of the overlay `MemoryTable` (`queryOverlayAsMergeEntries` → `overlay.query(...)`), in the **memory table's** primary-key order: the engine's per-type comparator, collation and direction.

Nothing reorders the overlay stream. When the underlying's `comparePrimaryKey` and the memory table's order disagree on some pair of staged keys, the overlay stream reaches `mergeStreams` out of order under the comparator it is walked with. The merge then moves past an underlying row before the staged row that shadows it comes up, so both the committed row and its staged replacement are emitted.

The secondary-index branch (`mergedSecondaryIndexQuery`) does not have this problem: it collects the overlay rows and sorts them by the merge's own sort key before merging (`overlayRows.sort(...)`, ~:568), and it excludes shadowed rows by primary-key set rather than by position.

## Reproduction (measured 2026-10-07 from lamina, published `@quereus/isolation` 4.20.2)

Lamina wraps its module in `IsolationModule`. For a compound primary key with a TIMESPAN member, lamina's storage keys the member by canonical identity text (`'i:<seconds>'`), so its `comparePrimaryKey` orders `PT20M` (`i:1200`) before `PT10M` (`i:600`). The overlay `MemoryTable` orders the same two keys by duration, the other way round.

```sql
create table ev (k text, d timespan, v text not null, primary key (k, d));
insert into ev values ('x','PT20M','twenty'),('x','PT10M','ten');
begin;
update ev set v = 'TEN'    where k = 'x' and d = 'PT10M';
update ev set v = 'TWENTY' where k = 'x' and d = 'PT20M';
select v from ev;     -- twenty, TEN, TWENTY   ← three rows from a two-row table; stale 'twenty' surfaces
commit;
select v from ev;     -- TWENTY, TEN           ← correct
```

The plan for the in-transaction `select` is a plain sequential scan, so this is the primary-key merge. The overlay emits `TEN` (600 s) then `TWENTY` (1200 s); the merge compares `TEN` against the underlying's first row `twenty` under lamina's comparator (`i:600` > `i:1200`), emits `twenty` unshadowed, and only then meets `TWENTY`.

The same shape reproduces with a single-column `json` primary key holding bare scalars, where lamina orders by canonical JSON text and the memory table orders by type tier (staging one insert and one update in the same transaction surfaces five rows from a four-row table; recorded on the lamina board under `bug-json-column-scalar-values-order-by-tier-not-canonical-text`).

A reproduction inside this repo needs an underlying module whose `comparePrimaryKey` (and scan order) differs from the engine's default order for the declared type — e.g. a small test vtab that keeps its rows sorted by a custom comparator (say, text by length, then value) and exposes that comparator as `comparePrimaryKey`. Stage two updates whose keys the two orders rank oppositely, then do a full scan inside the transaction.

## Expected behaviour

A merged primary-key read returns each primary key exactly once, with the staged version winning, whatever order the underlying module uses — as long as the underlying's scan agrees with its own `comparePrimaryKey`, which is the contract `docs/design-isolation-layer.md` places on the module.

`docs/design-isolation-layer.md` already says "the isolation layer passes these comparators to the overlay module (if configurable) or validates that the overlay and underlying modules use compatible orderings". Neither happens today; the fix should make one of them true and update that sentence to describe what the code does.

Suggested direction (the triage agent should confirm or replace it): when the underlying supplies `comparePrimaryKey`, collect the overlay entries for the window and sort them under the merge's comparator before handing them to `mergeStreams`. The secondary branch already does exactly this, and the overlay holds one transaction's staged writes. A reversed (DESC-ordered) scan must sort in the reversed direction. The alternative — building the overlay `MemoryTable` with the underlying's comparator — avoids the sort but couples the overlay's B-tree to a module hook.
