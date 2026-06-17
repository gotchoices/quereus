description: Verify the LevelDB backend rewrite that puts every table/index/catalog/stats of a database into one physical store (instead of a folder per table), giving it crash-safe single-commit writes.
prereq: store-atomic-batch-capability
files:
  - packages/quereus-plugin-leveldb/src/store.ts              # LevelDBStore: dual-mode (standalone root | sublevel)
  - packages/quereus-plugin-leveldb/src/provider.ts           # shared-root provider, sublevels, beginAtomicBatch, name encoding
  - packages/quereus-plugin-leveldb/src/plugin.ts             # syncCommits config wiring
  - packages/quereus-plugin-leveldb/package.json              # abstract-level dep, syncCommits setting
  - packages/quereus-plugin-leveldb/README.md                 # shared-root layout, hard cutover, syncCommits
  - packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts # NEW: shared-root atomic commit + MISUSE
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts # rewritten: engine-row asserts (no fs dirs)
  - packages/quereus-plugin-leveldb/test/store.spec.ts        # unchanged: validates standalone LevelDBStore.open
difficulty: hard
----

# Review: LevelDB shared-root layout + atomic batch

## What changed (and why)

The LevelDB backend previously opened a **separate `ClassicLevel` per table/index**
(`basePath/{schema}/{table}`, `…/{table}_idx_{name}`). Separate physical databases
cannot share a write batch, so the `beginAtomicBatch` capability from the prereq
(`store-atomic-batch-capability`) was impossible to implement there. This rewrite
moves to **one physical LevelDB at `basePath`** with **one sublevel per logical
store**, then implements `beginAtomicBatch` over the root's chained, cross-sublevel
batch — delivering the crash-safe single commit on the durable backend.

Layout (sublevel name = existing logical store name, so naming rules are unchanged
from the caller's view):

| Logical store | Sublevel name |
|---|---|
| Table data | `{schema}.{table}` (`buildDataStoreName`) |
| Secondary index | `{schema}.{table}_idx_{name}` (`buildIndexStoreName`) |
| Unified stats | `__stats__` (`STATS_STORE_NAME`) |
| Catalog | `__catalog__` (`CATALOG_STORE_NAME`) |

This is a **hard cutover with no on-disk migration** (per AGENTS.md "Don't worry
about backwards compatibility yet"); old per-directory data is not read. Documented
in the plugin README.

## Key design decisions (review these)

1. **`LevelDBStore` is dual-mode.** `LevelDBStore.open({path})` still opens a
   *standalone* `ClassicLevel` (a public API used by `sync-coordinator` and
   `quereus-sync` for single KV databases — NOT removed). The provider uses
   `LevelDBStore.overSublevel(sublevel)`. The store wraps a `ViewLevel`
   (`AbstractLevel`), so `close()` = `level.close()` is correct for **both** modes:
   standalone closes the physical DB; a sublevel close drops the handle while the
   shared root stays open (the provider owns the root).

2. **Sublevel name encoding.** abstract-level requires every byte of a sublevel
   name to be in `(34, 127)`. Logical store names are identifiers that can contain
   spaces / punctuation / non-ASCII (e.g. a quoted table `"Table With Spaces"`),
   so `encodeSublevelName` percent-encodes any out-of-range byte. It is
   deterministic and injective (distinct logical names → distinct sublevel names),
   which is all the name-keyed caching and the StoreModule collision checks need;
   the encoded name is never decoded back. Applied centrally in `openSublevel`.
   **Review focus:** is percent-encoding injective and safe for all identifier
   bytes? (escape introducer `%` is itself escaped; `!`/`"`/space all escape).

3. **Externally-closed handle eviction.** `StoreTable.releaseIndexStore` (called by
   `dropIndex` before `deleteIndexStore`) closes the *very handle the provider
   cached*. `getOrCreateStore` now checks `isClosed()` and evicts+reopens a stale
   closed entry. **Review focus:** any other path that closes a provider-cached
   handle out-of-band? (audited: `disconnect()` does not close the data store.)

4. **Delete = `sublevel.clear()`.** `deleteIndexStore`/`deleteTableStores` clear the
   keyspace via a fresh sublevel and drop the cached handle. Exact-by-name index
   handling is preserved (uses the schema's `indexNames`, never a `_idx_` prefix
   scan). Sublevel prefix isolation (separator `!` sorts before identifier bytes)
   means clearing `main.t` cannot touch a sibling sublevel `main.t_idx_x`.
   **Review focus:** confirm the separator-isolation reasoning; confirm
   multi-store clear (data + each index) need not be atomic (matches prior fs
   behavior — the authoritative catalog delete is what matters).

5. **Atomic rename.** `renameTableStores` relocates keys old→new sublevel in ONE
   chained batch (`put → new`, `del → old`), with an up-front destination-empty
   collision guard and old-handle eviction. **This is O(n) in row count** (it reads
   all keys into one in-memory chained batch) where the old fs-rename was O(1) — see
   Gaps. Atomicity: the single `write({sync})` is all-or-nothing across data + every
   index.

6. **`beginAtomicBatch` + commit durability.** Returns an `AtomicBatch` over the
   root's chained batch; each op targets its sublevel via `{sublevel}`. `write()`
   passes `{ sync: syncCommits }` (**default true**) so a committed transaction is
   fsync'd and survives power loss — the crash-safe guarantee this ticket exists to
   provide. `syncCommits` is a new provider option / plugin setting; set false to
   trade durability for commit latency. **Review focus:** is `sync:true` the right
   default? (decided yes — durability is the point; documented tradeoff.) Empty
   batch `write()` closes the chained batch instead of a no-op commit.

## Validation performed

- `packages/quereus-plugin-leveldb` unit tests: **26 passing** (`store.spec` standalone
  KV + iteration + batch + sync hint; `sibling-collision` rewritten to engine-row
  asserts; new `atomic-batch` covering multi-store atomic commit, delete+put atomicity,
  clear() discard, empty write, undefined-before-root, and MISUSE for foreign / other-
  provider handles).
- `src` + `test` type-check: clean (note: the package's default `typecheck`/`build`
  only covers `src/**`; I ran a temporary tsconfig including `test/**` — clean).
- Plugin `build` (tsc): clean.
- **Store-mode regression gate** (`yarn test:store`, the primary gate): run WITHOUT
  `--bail` → **6324 passing, 14 pending, 1 failing**. The single failure is
  `51.7-maintained-table-attach-detach.sqllogic`, which is **pre-existing and
  backend-agnostic** — see Gaps + `tickets/.pre-existing-error.md`.
- Memory-mode sanity (`yarn test` for `@quereus/quereus`): 6330 passing, 0 failing.
- `sync-coordinator` (consumes standalone `LevelDBStore.open`): 121 passing.

## Known gaps / things to scrutinize (treat tests as a floor)

- **Pre-existing store-mode failure (`51.7`).** After `alter table … drop maintained`,
  a structural ALTER (`add column`) re-introduces the maintained `derivation` on the
  rebuilt schema, so the next ALTER rejects the table as a materialized view. Proven
  backend-agnostic: it reproduces identically with an **in-memory** `KVStoreProvider`
  and with LevelDB, both under `createIsolatedStoreModule`. The bug is in the
  StoreModule/isolation/engine MV path (`packages/quereus-store`,
  `packages/quereus-isolation`, `runtime/emit/alter-table.ts`,
  `materialized-view-helpers.ts`) — none touched by this ticket. It only surfaces now
  because the shared-root rewrite fixed two genuinely-new failures that previously
  bailed earlier (sublevel-name byte-range for `"Table With Spaces"`; closed-handle
  reuse in `dropIndex`). Flagged in `tickets/.pre-existing-error.md` for the triage
  pass. NOTE: at implement time, several `packages/quereus/src/*` MV files showed
  uncommitted edits from a **concurrent** process — a fix may already be in flight;
  triage should re-check before filing.
- **No real crash test.** The durability/atomicity guarantee is validated for
  *correctness* (multi-store ops land atomically; one `write()`), not by simulating a
  power loss. A fault-injection / kill-mid-commit test would be stronger but isn't
  unit-testable here.
- **Rename is O(n).** Large-table `ALTER … RENAME TO` now rewrites every key through a
  single in-memory chained batch (the old fs-rename was O(1)). Fine for tests; could be
  memory-heavy for very large tables. Inherent to sublevels (a prefix can't be renamed
  in place). Consider a streamed/chunked rewrite if it becomes a problem.
- **`getStore` `options.path` override dropped.** The old per-directory layout honored a
  per-table path override; with one shared root there is no per-table path, so it is
  silently ignored. The engine never passed it (verified), but an external direct caller
  relying on it would now be ignored rather than errored.
- **`sublevelHasAnyKey` / destination guard.** The rename collision guard opens each
  destination sublevel and checks emptiness; confirm this is robust when a destination
  equals a currently-open sibling store (covered by the rewritten sibling-collision
  RENAME test + the StoreModule schema-level guard that fires first).
- **Name-encoding longevity.** Percent-encoding lengthens prefixes for exotic names
  (minor). Verify no assumption elsewhere that a sublevel name equals the raw store name
  (only the provider's internal maps use the raw name; the physical sublevel uses the
  encoded form — they never need to match).
