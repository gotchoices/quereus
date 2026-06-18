description: A new SQL function lets a developer list, from inside SQL, which shared tables an app still uses and which are now legacy candidates for cleanup.
files:
  - packages/quereus-sync/src/sql/basis-lifecycle-tvf.ts          # registerBasisLifecycleTvf(db, syncManager) + the TVF
  - packages/quereus-sync/src/index.ts                            # exports registerBasisLifecycleTvf
  - packages/quereus-sync/test/sync/basis-lifecycle-tvf.spec.ts   # 9 integration cases against a real Database
  - packages/quereus-sync/README.md                              # Core Exports entry
  - docs/migration.md                                            # § 2 Converge — SQL-query mention
difficulty: medium
----

# Complete: in-SQL introspection of basis-table lifecycle (`quereus_basis_lifecycle()` TVF)

## What shipped

A zero-argument table-valued function, `quereus_basis_lifecycle()`, that surfaces the
durable per-basis-table lifecycle records from inside SQL — a pure read-only
convenience over `SyncManager.getBasisTableLifecycle()`, opted in by the host with
`registerBasisLifecycleTvf(db, syncManager)`. No engine change.

```sql
select "table", state, "unmappedSince"
from quereus_basis_lifecycle()
where state = 'derivation-source-only'
order by "unmappedSince";
```

The TVF builds a plain (non-integrated) `createTableValuedFunction` whose
async-generator closes over the `SyncManager`, snapshots the whole record array once
(`getBasisTableLifecycle()` → `BasisLifecycleStore.list()`), then yields — immune to a
concurrent deploy mutating records mid-scan. 11 camelCase columns matching the record
fields; booleans → INTEGER 0/1; `mappedBy` → JSON array string; optional timestamps
`?? null`; the `evictPolicy` union → its string form; `indexNames` excluded.

## Review findings

Reviewed the implement-stage diff (`3029d885`) with fresh eyes against the source it
touches (`basis-lifecycle-tvf.ts`, `index.ts`, the metadata record + store in
`basis-lifecycle.ts`, the `SyncManager` interface, and the existing builtin-TVF
patterns `json_each` / `generate_series`), then the handoff.

### Checked — clean

- **Correctness.** Column order in `rowFromRecord` matches `returnType.columns`
  exactly (11 fields, verified positionally). The `evictPolicy == null` guard
  correctly distinguishes an absent policy from a numeric `0` horizon (so `String(0)`
  → `"0"` is reachable, `null` only for genuinely absent). Snapshot-then-yield is the
  right concurrency posture for a record set mutated by deploys.
- **Type safety.** No `any`; the `col` helper's inferred shape satisfies
  `RelationType.columns` (test + prod tsconfigs both clean). `Row` holds the
  null/number/string values produced.
- **Error handling / resource cleanup.** A KV read failure mid-scan propagates out of
  the generator and surfaces as a query error (correct — a read fault should not be
  swallowed). The TVF materializes a bounded array (basis-table count) and holds no
  open cursor/handle.
- **DRY / modularity / naming.** `col` and `rowFromRecord` are small and
  single-purpose; the `quereus_`-prefixed name follows convention; the opt-in
  registration seam matches the package's host-driven helper style
  (`createStoreAdapter`).
- **Docs.** README "Core Exports" entry and `docs/migration.md` § 2 Converge both
  accurately describe `registerBasisLifecycleTvf(db, syncManager)` and the example
  query, consistent with the shipped signature and column names.
- **Build / validation.** `yarn workspace @quereus/sync test` green; both
  `tsc --noEmit` and `tsc -p tsconfig.test.json --noEmit` clean. (`@quereus/sync` has
  no lint script — per AGENTS.md only `packages/quereus` does — so tsc + tests are the
  applicable gates.)

### Found and fixed inline (minor)

- **Untested non-null rendering paths (handoff gaps #1, #2).** Every recorder-driven
  test left `evictPolicy` and `lastDirectlyMappedWriteAt` null, so the `String(...)`
  `EvictPolicy` union collapse (`'never'` / `'immediate'` / numeric-ms → decimal
  string) and the non-null INTEGER timestamp branch were implemented but never
  exercised. Added a focused case (`renders non-null evictPolicy +
  lastDirectlyMappedWriteAt`) that injects records straight into the shared KV store
  via `BasisLifecycleStore.put` and asserts all three union variants plus a non-null /
  null timestamp pair. Suite: **392 passing** (was 391; +1 new TVF case → 9 in that
  spec).

### Found — intentionally deferred, no ticket (minor / out of scope)

- **No key advertisement on the return type (handoff gap #4).** Records are unique per
  `(schema, table)`, so advertising that key could marginally help the optimizer. Over
  a result set bounded by the basis-table count the payoff is negligible, and leaving
  it off mirrors `schema()`. Not worth a ticket; revisit only if a consumer joins
  against the TVF at scale.
- **No full real-engine `apply schema` round-trip in this spec (handoff gap #3).** The
  TVF is agnostic to *how* records were written; the recorder spec
  (`basis-lifecycle-recorder.spec.ts`) separately covers a real end-to-end deploy, and
  this spec covers the projection. Adequately covered between the two.
- **Arity error (handoff gap #5).** `quereus_basis_lifecycle(1)` against `numArgs: 0`
  is an engine-level concern, out of this ticket's scope.

### No new tickets

No major findings — nothing required spawning a fix/plan/backlog ticket.

### No pre-existing failures

No `.pre-existing-error.md` written. The full `@quereus/sync` suite was green before
and after; the `[Sync] …` error lines in the run log are deliberately test-induced by
other specs (`sync-manager.spec.ts` failing-KV cases, oversized-transaction warnings,
out-of-band hash-drift warnings).

## How to re-validate

- `yarn workspace @quereus/sync test` — 392 passing, ~6s.
- `cd packages/quereus-sync && yarn tsc --noEmit && yarn tsc -p tsconfig.test.json --noEmit` — both clean.
