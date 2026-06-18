description: Add a SQL function so a developer can query, from inside SQL, which shared tables the app still uses and which are now legacy candidates for cleanup.
prereq: basis-lifecycle-classification
files:
  - packages/quereus-sync/src/sql/basis-lifecycle-tvf.ts        # NEW — registerBasisLifecycleTvf(db, syncManager)
  - packages/quereus-sync/src/index.ts                          # export the new helper
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # getBasisTableLifecycle() — the data source (read-only here)
  - packages/quereus-sync/src/sync/manager.ts                   # SyncManager interface (getBasisTableLifecycle signature)
  - packages/quereus-sync/src/metadata/basis-lifecycle.ts       # BasisTableLifecycleRecord / EvictPolicy shapes
  - packages/quereus-sync/test/sync/basis-lifecycle-tvf.spec.ts # NEW — integration test (mocha + chai, real Database)
  - packages/quereus-sync/README.md                             # Core Exports list — document the helper
difficulty: medium
----

# In-SQL introspection of basis-table lifecycle (`quereus_basis_lifecycle()` TVF)

Surface the durable per-basis-table lifecycle records (shipped by
`basis-lifecycle-classification`) from inside SQL as a zero-argument
table-valued function, so a developer can list legacy / retirement-candidate
tables without writing host code:

```sql
select "table", state, "unmappedSince"
from quereus_basis_lifecycle()
where state = 'derivation-source-only'
order by "unmappedSince";
```

Today the same records are reachable only programmatically via
`SyncManager.getBasisTableLifecycle()` and the `onBasisTableLifecycle` event.
This is a pure convenience layer over the existing method — **no engine
change**.

## Resolved design

### Registration seam (the plan ticket's open question)

`@quereus/sync` exports a new host-called helper:

```ts
// packages/quereus-sync/src/sql/basis-lifecycle-tvf.ts
import type { Database } from '@quereus/quereus';
import { createTableValuedFunction } from '@quereus/quereus';
import type { SyncManager } from '../sync/manager.js';

/** Register the `quereus_basis_lifecycle()` introspection TVF against `db`,
 *  reading from `syncManager`. Opt-in: the host calls this after
 *  `createSyncModule(...)`. Safe to call once per Database. */
export function registerBasisLifecycleTvf(db: Database, syncManager: SyncManager): void { … }
```

The implementation builds a **plain (non-integrated) TVF** whose
async-generator `implementation` **closes over `syncManager`**, then calls
`db.registerFunction(schema)`.

Why this seam, and not the alternatives:

- **Closure over `syncManager` (chosen).** The TVF needs the `SyncManager`, and
  a closure captures it directly. The host already holds both `db` and
  `syncManager` right after `createSyncModule(...)`, so an explicit
  `registerBasisLifecycleTvf(db, syncManager)` opt-in is the smallest seam and
  requires no engine change. Mirrors the README's "exposed as an opt-in the host
  calls" guidance.
- **Integrated TVF (`createIntegratedTableValuedFunction`) — rejected.** An
  integrated TVF receives the `Database` as its first arg, not the
  `SyncManager`, and there is no `db → syncManager` bridge. `@quereus/sync` is
  not a vtab module, so there is nothing to hang the manager off `db`.
- **Auto-register inside `createSyncModule` — rejected.** `createSyncModule`
  does not take a `Database`; its `transactionSource` is typed
  `TransactionCommitSource` (not the full `Database`) and is absent for
  relay-only deployments. Keep registration a separate, explicit host call so
  no-db / relay deployments aren't forced to wire it.

`createTableValuedFunction`, `db.registerFunction`, and the `Database` /
`SqlValue` / `Row` types are all already public exports of `@quereus/quereus`
(the package is an existing dependency of `@quereus/sync`; see
`packages/quereus/src/index.ts` and `database.ts:registerFunction`). Zero-arg
TVFs are well-supported in the engine — see `schema()`, `assertion_info()`,
`schema_size()` (`numArgs: 0`).

### Function shape

- Name: `quereus_basis_lifecycle`, `numArgs: 0`, `deterministic: false` (data
  changes across deploys).
- `implementation`: `async function* () { const recs = await
  syncManager.getBasisTableLifecycle(); for (const r of recs) yield [...]; }`.
  `getBasisTableLifecycle()` returns a fully-materialized
  `BasisTableLifecycleRecord[]` (it calls `basisLifecycle.list()`), so the
  generator awaits the whole snapshot **once** and then yields — iteration is
  over a stable array, immune to a concurrent deploy mutating records mid-scan.

### Columns (one row per `BasisTableLifecycleRecord`)

Column names are **camelCase matching the record fields**, consistent with the
plan ticket's example query. `schema` / `table` are also engine TVF column names
already (`table_info` has a `table` column), so quoting in `where` / `order by`
works as shown above.

| column | logical type | nullable | value from record |
|---|---|---|---|
| `schema` | TEXT | no | `r.schema` |
| `table` | TEXT | no | `r.table` |
| `state` | TEXT | no | `r.state` (`directly-mapped` \| `derivation-source-only` \| `unreferenced` \| `detached`) |
| `mappedBy` | TEXT | no | `JSON.stringify(r.mappedBy)` → e.g. `["app"]`; empty → `"[]"` (never null) |
| `derivationSource` | INTEGER | no | `r.derivationSource ? 1 : 0` |
| `inBasis` | INTEGER | no | `r.inBasis ? 1 : 0` |
| `mappedSince` | INTEGER | yes | `r.mappedSince ?? null` |
| `unmappedSince` | INTEGER | yes | `r.unmappedSince ?? null` |
| `detachedAt` | INTEGER | yes | `r.detachedAt ?? null` |
| `lastDirectlyMappedWriteAt` | INTEGER | yes | `r.lastDirectlyMappedWriteAt ?? null` (reserved; null until `basis-eviction-policy` populates) |
| `evictPolicy` | TEXT | yes | `r.evictPolicy == null ? null : String(r.evictPolicy)` — `'never'` \| `'immediate'` \| a numeric horizon rendered as its decimal string (reserved; null until populated) |

Column-set decisions vs. the plan ticket's enumerated list:

- **Added `detachedAt`** — the plan ticket listed the `mappedSince`/`unmappedSince`
  pair but omitted `detachedAt`; it is the timestamp of the `detached` state and
  directly relevant to "ready to retire" queries, so include it.
- **Excluded `indexNames`** — internal eviction bookkeeping (a `string[]` of
  secondary-index store names consumed only by the eviction sweep); no
  introspection value for a developer choosing tables to retire. Leave it off the
  SQL surface.

Booleans are emitted as `INTEGER` 0/1 (engine convention — `table_info` emits
`notnull`/`pk` the same way). Use `INTEGER_TYPE` / `TEXT_TYPE` from
`@quereus/quereus` builtin types for the `returnType` column specs, mirroring
`packages/quereus/src/func/builtins/schema.ts`.

**Row-tuple invariant:** the yielded `Row` array order must exactly match the
column order above, and every optional value uses `?? null` (a `Row` cannot hold
`undefined`).

## Edge cases & interactions

- **Empty store / no deploys yet:** `getBasisTableLifecycle()` returns `[]`; the
  TVF yields zero rows. `select count(*) from quereus_basis_lifecycle()` ⇒ 0, no
  throw.
- **Absent optional fields → `null`, not `undefined`:** `mappedSince`,
  `unmappedSince`, `detachedAt`, and both reserved fields are optional on the
  record; coalesce each with `?? null`.
- **`mappedBy` empty array** renders `"[]"` (JSON), never `null`.
- **`evictPolicy` union rendering:** `'never'` / `'immediate'` pass through;
  a numeric horizon (e.g. `86400000`) renders as `"86400000"`. Uniform TEXT
  column so the union collapses to one SQL type.
- **Reserved fields today:** `lastDirectlyMappedWriteAt` / `evictPolicy` are
  populated by `basis-eviction-policy`; until then they are typically absent ⇒
  null. The TVF must not assume their presence.
- **Restart durability:** records come from KV (`basisLifecycle.list()`), so a
  fresh `Database` + new `SyncManager` over the same KV store reflects the prior
  deploy's classification with no deploy in the new session.
- **Concurrent deploy during iteration:** the generator snapshots the full array
  before yielding (see "Function shape"); a `recordLensDeployment` landing
  mid-iteration cannot corrupt the in-flight scan.
- **Double registration / name collision:** `registerBasisLifecycleTvf` should be
  called once per `Database`. Verify the behavior of a second call (engine
  `registerFunction` → `addFunction`; confirm it warns/replaces rather than
  corrupting state) and document it in the helper's JSDoc. The
  `quereus_`-prefixed name avoids collision with user tables/functions.
- **Async TVF:** the implementation awaits before yielding — confirm the
  runtime drives an `async function*` TVF registered via `registerFunction` (it
  returns `MaybePromise<AsyncIterable<Row>>`; an async generator satisfies it).
- **Arity:** calling with stray args is an engine-level arity error against
  `numArgs: 0`; not this ticket's concern.

## Tests

New `packages/quereus-sync/test/sync/basis-lifecycle-tvf.spec.ts` (mocha + chai,
matching the existing sync specs). Use a **real** `new Database()` from
`@quereus/quereus` (precedent: `store-adapter-seam.spec.ts` — `db.eval(sql)`
returns `AsyncIterable<Row>`; collect with `for await`). Drive classification
via `SyncManagerImpl.recordLensDeployment(...)` exactly as
`basis-lifecycle-recorder.spec.ts` does (`makeDb` / `makeSnapshot` helpers).

Key cases and expected outputs:

- **Empty:** before any deploy, `select count(*) from quereus_basis_lifecycle()`
  ⇒ 0 rows.
- **One directly-mapped table:** after a first deploy mapping `store.contact_v1`,
  one row with `state = 'directly-mapped'`, `mappedBy = '["app"]'`,
  `inBasis = 1`, `mappedSince` non-null, `unmappedSince` null, both reserved
  columns null.
- **Filter / projection:** after flipping the deploy to v2 (so v1 becomes
  `derivation-source-only`),
  `select "table" from quereus_basis_lifecycle() where state =
  'derivation-source-only'` returns exactly the retired table.
- **Boolean encoding:** `derivationSource` / `inBasis` come back as integer 0/1.
- **Restart durability:** register the TVF against a second `Database` +
  `SyncManager` built over the **same** KV store; rows reflect the prior
  classification (mirror the recorder spec's "records survive a restart" test).
- **`mappedBy` JSON:** value parses as a JSON array; empty-mapper case ⇒ `'[]'`.

## Docs

- Add `registerBasisLifecycleTvf(db, syncManager)` to the **Core Exports** list
  in `packages/quereus-sync/README.md`, with the one-line usage (call after
  `createSyncModule`).
- If `docs/migration.md` has an operator-introspection section, add the
  `select … from quereus_basis_lifecycle()` example there; keep it DRY (link,
  don't duplicate the column table).

## TODO

- Create `packages/quereus-sync/src/sql/basis-lifecycle-tvf.ts` exporting
  `registerBasisLifecycleTvf(db, syncManager)` — builds the TVF via
  `createTableValuedFunction` (closure over `syncManager`), `returnType` with the
  11 columns above, async-generator impl yielding one ordered `Row` per record,
  then `db.registerFunction(schema)`.
- Export `registerBasisLifecycleTvf` from `packages/quereus-sync/src/index.ts`.
- Add `packages/quereus-sync/test/sync/basis-lifecycle-tvf.spec.ts` covering the
  cases above against a real `Database`.
- Update `packages/quereus-sync/README.md` Core Exports (and `docs/migration.md`
  if it has an introspection section).
- Run `yarn workspace @quereus/sync test` and the quereus lint/build; ensure no
  signature drift. Stream long output with `2>&1 | tee /tmp/sync-test.log; tail`.
