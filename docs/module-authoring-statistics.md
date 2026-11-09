# Module Statistics

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

What a module reports through `getStatistics()` for the cost model, what `ANALYZE` collects for whatever it leaves out, and how a module persists statistics across a reopen. A satellite of [Virtual Table Module Authoring Guide](module-authoring.md).

## Statistics for Cost-Based Optimization

Virtual table modules can optionally provide statistics for the optimizer's cost model. Implement `getStatistics()` on your `VirtualTable` subclass to report what your storage already knows **exactly**: the row count, plus per-column distinct values, min/max and histograms *only* where you maintain them. Report nothing else — `ANALYZE` scans for whatever you leave out, and both shipped backends leave out everything but the row count.

```typescript
import type { TableStatistics, ColumnStatistics } from '@quereus/quereus';

class MyTable extends VirtualTable {
  getStatistics(): TableStatistics {
    return {
      rowCount: this.data.length,
      // Both figures are exact and maintained by this module's write paths — `id` is the
      // primary key, and `uniqueNames` is a running count. A module that would have to
      // sample for these reports `columnStats: new Map()` instead and lets ANALYZE scan.
      columnStats: new Map([
        ['id', { distinctCount: this.data.length, nullCount: 0 }],
        ['name', { distinctCount: this.uniqueNames, nullCount: 0 }],
      ]),
    };
  }
}
```

The `ANALYZE` command calls `getStatistics()` when it is implemented, and otherwise collects statistics by scanning the table. Statistics are cached on `TableSchema.statistics` and consumed by `CatalogStatsProvider` for selectivity estimation.

`ANALYZE` also runs **on its own**: once a table has drifted past the `auto_analyze` threshold, the engine runs it for that table from a background timer (see `docs/sql-txn.md` §9.5). Both hooks below are therefore called without any user statement in flight, and `saveStatistics` may be called for a table nobody asked about — neither may assume it is running inside a user's `ANALYZE`.

**Report a column statistic only if it is exact over every live row the connection can see. A sample is not an answer** — leave `columnStats` empty and let `ANALYZE` scan. The figures here are consumed as facts, not as estimates: a `distinctCount` derived from the first N values understates cardinality, and a `nullCount` computed as `rowCount - sampleSize` counts every un-sampled row as a NULL. The memory backend shipped exactly that for a while — a systematic sample capped at 1000 values per column, correct at or below 1000 rows and wrong above it — which is why it now reports its size and nothing else.

Exact does not have to mean expensive. A count maintained by the write paths, or read off index metadata, qualifies; what does not qualify is any figure whose accuracy depends on how big the table happens to be. If the exact figure would cost a scan, do not compute it — that is `ANALYZE`'s job, and it already does it once for every column in a single pass.

**Decline while you cannot see the whole picture.** An implementation that answers from committed state only is wrong inside an open transaction, where it describes the table as it was before the transaction started. Return `undefined` in that situation, as `IsolatedTable` does while its overlay is dirty, rather than reporting a stale number. (Reporting only a row count is a milder version of the same problem, and survives it: `ANALYZE` prefers its own scan's count, which reflects what the connection can see.)

Returning **`undefined`** declines for the state the table is currently in, and `ANALYZE` scans exactly as it would for a module that never implemented the hook. That is for a wrapper whose cheap answer would be wrong for the read it is serving — the isolation layer declines while a transaction's overlay is dirty, since its underlying reports the committed base and would miss the connection's own uncommitted rows.

A row count with an **empty** `columnStats` is a supported partial answer, for a module that can size itself cheaply but keeps no value distribution: `ANALYZE` reads it as *"size answered, collect the rest yourself"*, still scans for the per-column numbers, and prefers the scan's row count (it counted every live row; a maintained count can drift). Nothing consults `getStatistics()` during *planning* — to get a live size into cost decisions between `ANALYZE`s, implement the module-level `getRowCount` hook (see [the surface inventory](module-capabilities.md#surface-inventory)).

### Persisting statistics across a reopen

Statistics collected by `ANALYZE` live on `TableSchema.statistics`, which is in-memory only — close the database and they are gone. A module with durable storage can implement the optional companion hook so the next open reads them back instead of planning blind until someone re-runs `ANALYZE`:

```typescript
class MyTable extends VirtualTable {
  async saveStatistics(stats: TableStatistics): Promise<void> {
    await this.backend.writeStats(this.tableName, stats);
  }
}
```

`ANALYZE` calls it once per table, right after it writes the statistics onto the schema. Three rules:

- **It is advisory.** A rejection is logged and swallowed — `ANALYZE` succeeding with statistics in memory but not on disk is strictly better than `ANALYZE` failing. Do not throw to signal "I could not store these"; just return.
- **Persisting less than you were given is fine.** `ColumnStatistics.histogram` can run to a few KB per column, so a module may drop what it cannot use and keep the scalar fields. The store module persists `distinctCount` / `nullCount` / `minValue` / `maxValue` for every column but keeps histograms only for columns it can actually seek on (a primary-key member or an index's leading column) — a dropped histogram costs a re-`ANALYZE` to recover and nothing else. Whatever you keep, keep it **keyed by column name**: a positional key silently matches a *different* column after a rename or drop.
- **Re-key your record when an ALTER frees a column name.** A name key is safer than a positional one but is not self-correcting: `rename column k to k2` — or `drop column k` — leaves your record naming `k`, and a later `add column k` reuses that name, so on reopen the stale entry describes a brand-new column. The engine cannot catch this for you (by then `k` names a column that genuinely exists), and it drops nothing of its own — a rename's entry is re-keyed in the in-memory catalog, not on your disk. So in your `alterTable`, move a renamed column's entry onto its new name and remove a dropped column's outright, then flush. The store module does exactly this from one dispatch-level call (`StoreTableBase.remapPersistedColumnStatistics`) rather than per ALTER arm, so a newly added arm has to face the question instead of skipping it silently.
- **Do not then report the saved snapshot from `getStatistics()`.** `ANALYZE` reads a non-empty `columnStats` as *"this module answered cheaply, skip the scan"*, so a module that echoes its own stored snapshot turns every `ANALYZE` into a no-op that re-saves numbers it never recomputed. A cached snapshot is not an answer to "analyze me". Get the loaded snapshot to the planner by stamping it onto the registered `TableSchema` at open instead (the store module does this from `primeStats`).

Statistics you persist are also **per-connection on the way back in**: a second connection over the same storage keeps whatever its own schema holds until it reopens or re-analyzes. That is the same visibility model a persisted row count already has.

A **wrapper** module (isolation, logging, sharding) must forward `getStatistics` *and* `saveStatistics` to the table it wraps — and forward them conditionally, since both are optional and an unconditional wrapper would answer on behalf of an underlying that declined. Forward only the half the underlying implements:

```typescript
if (underlying.saveStatistics) {
  this.saveStatistics = stats => underlying.saveStatistics!(stats);
}
```

