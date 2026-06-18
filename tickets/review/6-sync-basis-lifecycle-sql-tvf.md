description: Review a new SQL function that lets a developer list, from inside SQL, which shared tables an app still uses and which are now legacy candidates for cleanup.
files:
  - packages/quereus-sync/src/sql/basis-lifecycle-tvf.ts          # NEW — registerBasisLifecycleTvf(db, syncManager) + the TVF
  - packages/quereus-sync/src/index.ts                            # exports registerBasisLifecycleTvf
  - packages/quereus-sync/test/sync/basis-lifecycle-tvf.spec.ts   # NEW — 8 integration cases against a real Database
  - packages/quereus-sync/README.md                              # Core Exports entry
  - docs/migration.md                                            # § 2 Converge — SQL-query mention
difficulty: medium
----

# Review: in-SQL introspection of basis-table lifecycle (`quereus_basis_lifecycle()` TVF)

## What shipped

A zero-argument table-valued function, `quereus_basis_lifecycle()`, surfacing the
durable per-basis-table lifecycle records (the `basis-lifecycle-classification`
work) from inside SQL. It is a **pure convenience layer** over the existing
`SyncManager.getBasisTableLifecycle()` — no engine change.

```sql
select "table", state, "unmappedSince"
from quereus_basis_lifecycle()
where state = 'derivation-source-only'
order by "unmappedSince";
```

### Registration seam (as resolved in the plan)

`@quereus/sync` exports a host-called helper:

```ts
export function registerBasisLifecycleTvf(db: Database, syncManager: SyncManager): void
```

It builds a **plain** (non-integrated) TVF via `createTableValuedFunction` whose
async-generator `implementation` **closes over `syncManager`**, then calls
`db.registerFunction(schema)`. Opt-in: the host calls it once after
`createSyncModule(...)`. No auto-registration (relay-only / no-db deployments need
no SQL surface).

### Function shape

- `name: 'quereus_basis_lifecycle'`, `numArgs: 0`, `deterministic: false`.
- The generator awaits the **whole** record snapshot once
  (`getBasisTableLifecycle()` → `BasisLifecycleStore.list()`), then yields — so a
  concurrent deploy cannot corrupt an in-flight scan.
- 11 columns, camelCase matching the record fields, in this fixed order:
  `schema, table, state, mappedBy, derivationSource, inBasis, mappedSince,
  unmappedSince, detachedAt, lastDirectlyMappedWriteAt, evictPolicy`.
  - Booleans (`derivationSource`, `inBasis`) → INTEGER 0/1 (engine convention).
  - `mappedBy` → JSON array string (`'["app"]'`, empty ⇒ `'[]'`, never null).
  - Optional timestamps → `?? null` (a `Row` cannot hold `undefined`).
  - `evictPolicy` union (`'never'` | `'immediate'` | numeric ms) → its string form.
  - `indexNames` deliberately excluded (internal eviction bookkeeping, no
    introspection value).

## How to validate

- `yarn workspace @quereus/sync test` — full suite is **398 passing** (390 prior +
  8 new), ~6s. The new spec is `test/sync/basis-lifecycle-tvf.spec.ts`.
- Typecheck both configs (catches signature drift):
  `cd packages/quereus-sync && yarn tsc --noEmit && yarn tsc -p tsconfig.test.json --noEmit` — both clean.
- The spec registers the TVF against a **real** `new Database()` and queries via
  `db.eval(sql)` (rows come back as objects keyed by column name), while driving
  classification through `SyncManagerImpl.recordLensDeployment(...)` with the same
  fake `makeDb` / `makeSnapshot` builders the recorder spec uses. The two ends are
  independent — they meet only at the KV-durable records.

### Cases covered (the test floor)

- **Empty:** `select count(*) ...` ⇒ 0 before any deploy; `select *` ⇒ 0 rows.
- **One directly-mapped table:** every column asserted — `state='directly-mapped'`,
  `mappedBy='["app"]'`, `inBasis=1`, `derivationSource=0`, `mappedSince` a number,
  `unmappedSince`/`detachedAt`/`lastDirectlyMappedWriteAt`/`evictPolicy` all null.
- **Boolean encoding:** `derivationSource`/`inBasis` come back as numeric 0/1.
- **Filter + projection:** after flipping the deploy v1→v2, `where state =
  'derivation-source-only'` returns exactly `Contact_v1`.
- **`mappedBy` JSON:** parses as a JSON array; dropped mapper ⇒ `'[]'`.
- **Detached row:** flip-then-detach drives v1 to `detached`; `inBasis=0`,
  `unmappedSince` and `detachedAt` both surface as **numbers** (non-null INTEGER path).
- **Restart durability:** a fresh `Database` + `SyncManager` over the **same** KV
  store reflects the prior session's classification with no deploy.
- **Double registration:** a second `registerBasisLifecycleTvf` call doesn't throw
  and still resolves one row (engine `addFunction` is a keyed overwrite — confirmed
  in `schema.ts:addFunction`, documented in the helper JSDoc).

### Note on display-case

Records preserve **original-case** table names (`Contact_v1`), not the lowercased
KV key — verified the hard way (first test run caught it). Queries quote `"table"`
because it is a reserved word; the other camelCase identifiers resolve unquoted.

## Known gaps — treat the tests as a floor, not a ceiling

1. **`evictPolicy` non-null rendering is UNTESTED.** Every test record leaves
   `evictPolicy` null (it is populated only by `basis-eviction-policy` machinery /
   a `quereus.sync.evict` reserved tag on a real tagged deploy — there is no host
   API to inject it through the fake `makeDb` path). So the `String(...)` union
   collapse for `'never'` / `'immediate'` / a numeric horizon is implemented per
   spec but **never exercised**. To close: deploy a real basis table carrying the
   `quereus.sync.evict` tag, or write a record directly via `BasisLifecycleStore.put`
   and assert the rendered string.
2. **`lastDirectlyMappedWriteAt` non-null path similarly untested** — same reason
   (bumped by the change applicator, not reachable from these fakes). Only its null
   branch is covered.
3. **No full real-engine `apply schema` round-trip in this spec.** Classification is
   driven by the recorder's unit-level fakes; the recorder spec
   (`basis-lifecycle-recorder.spec.ts`) separately covers a real end-to-end deploy,
   and the TVF is agnostic to how records were written — but if a reviewer wants
   belt-and-suspenders realism, an end-to-end case (real deploy → TVF query) would add it.
4. **Return type advertises no key / `isSet: false`** (matches `schema()`), unlike
   the `*_info` builtins that advertise e.g. `[[schema, table]]`. Records are unique
   per `(schema, table)`, so advertising that key could help the optimizer. Left off
   intentionally to mirror `schema()`; flag if the project wants the stronger
   advertisement.
5. **Arity error** (`quereus_basis_lifecycle(1)`) is an engine-level concern against
   `numArgs: 0`, out of this ticket's scope and untested here.

## No pre-existing failures

No `.pre-existing-error.md` written — the full sync suite was green before and after
(the error lines in the run log are deliberately test-induced by other specs:
`sync-manager.spec.ts` failing-KV cases, oversized-transaction warnings, etc.).
