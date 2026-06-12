description: MemoryIndexEntry.primaryKeys is a JS Set keyed by reference/SameValueZero identity, but composite primary keys are arrays (fresh per extraction) and integer keys can vary representation (bigint vs number). removeEntry therefore cannot remove a composite PK by value — stale PKs accumulate in secondary-index entries until the entry empties. Pre-existing; surfaced while implementing maintained-table secondary-UNIQUE enforcement.
files:
  - packages/quereus/src/vtab/memory/types.ts          # MemoryIndexEntry { primaryKeys: Set<BTreeKeyForPrimary> }
  - packages/quereus/src/vtab/memory/index.ts          # addEntry / removeEntry (Set.add / Set.delete by identity)
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts  # secondary-index scans iterate entry.primaryKeys → primaryTree.get(pk)
  - packages/quereus/src/vtab/memory/layer/manager.ts  # checkUniqueViaIndex (already live-validates candidates — the enforcement-side mitigation)
difficulty: medium
----

# Memory secondary-index entries track primary keys by JS identity, not value

`MemoryIndexEntry.primaryKeys` is `Set<BTreeKeyForPrimary>`. For a
single-column primary key the stored element is a bare primitive and `Set`
membership mostly works by value — except across integer representations
(`compareSqlValues` treats `5n ≡ 5`; `Set` does not). For a **composite**
primary key the element is an **array**, and every PK extraction
(`createPrimaryKeyFunctions.extractFromRow`, `buildPrimaryKeyFromValues`)
builds a fresh array — so `Set.delete(pkArray)` in `MemoryIndex.removeEntry`
compares by reference and **never removes anything**.

## Consequences (composite-PK tables with secondary indexes)

- A row UPDATE that changes an indexed column, or a row DELETE, leaves the old
  PK stranded in the index entry's Set. Stale PKs accumulate until the entry's
  Set happens to empty (it may never).
- **Phantom index-scan rows**: `scan-layer.ts` yields `primaryTree.get(pk)` for
  each PK in a matching entry without re-validating the indexed column against
  the row. A stale PK whose row still EXISTS (updated in place, index value
  changed) yields a row that no longer matches the scanned index key.
  (A stale PK whose row is gone is null-skipped — no phantom there.)
- **Inflated index stats**: `getBaseLayerStats` / `MemoryIndex.size` count
  entries; stale PK members also skew any per-entry cardinality assumptions.
- UNIQUE **enforcement** is no longer affected: `checkUniqueViaIndex` now
  validates each candidate PK against the live effective row (value + partial
  predicate, collation-aware) before acting — the same stale-candidate
  discipline as `checkUniqueViaMaterializedView` — so stale members cannot
  false-reject or REPLACE-evict an innocent row. That mitigation is
  enforcement-side only; scans and stats still trust the Set.

## Repro sketch (phantom scan)

```sql
create table t (a integer, b integer, c text, primary key (a, b));
create index ix_c on t(c);
insert into t values (1, 1, 'x');
update t set c = 'y' where a = 1 and b = 1;
-- index entry for 'x' still holds PK [1,1] (removeEntry's Set.delete missed);
-- an index-driven scan for c = 'x' can yield the live (1,1,'y') row.
```

(Whether a given query routes through the secondary index depends on the
access planner; assert at the MemoryIndex level if the planner is hard to pin.)

## Expectation

Primary-key membership in a secondary-index entry must use VALUE semantics
under the table's PK comparator (collation- and representation-aware), for
add (no duplicate equal-by-value members), remove (actually removes), and
iteration. Note the related, already-fixed layering hazard documented on
`MemoryIndex.ownedEntries` (entries shared across inherited layer trees are
now copy-on-written) — any redesign of the entry structure must preserve that
copy-on-write discipline. `test/logic/10.5*` (indexes), `51.9` (maintained
secondary UNIQUE), and the full-rebuild composite-PK scenarios exercise the
neighborhood.
