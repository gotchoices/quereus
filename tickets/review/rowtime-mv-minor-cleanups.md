description: Review four minor type-safety / DRY cleanups around row-time MV maintenance (discriminated-union change payload, hoisted tableKey, cosmetic casts, explicit window reject) plus one genuinely behavioral fix — making compilePredicate's truthiness delegate to the engine's canonical isTruthy. Build + lint + full memory + full store suites all green. The predicate change is the only behavioral one and is the primary review focus.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-internal.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
----

# rowtime-mv-minor-cleanups — review handoff

Five changes across six source files. Four are pure type-safety / DRY / cosmetic
(no behavior change); one — the predicate-truthiness fix — **is** a behavior change
with blast radius beyond row-time. Reviewer: spend your time on item 5.

## What shipped

### 1. `BackingRowChange` is now a discriminated union (`vtab/memory/layer/manager.ts`)
Was `interface { op: 'insert'|'update'|'delete'; oldRow?: Row; newRow?: Row }`. Now:

```ts
export type BackingRowChange =
  | { op: 'insert'; oldRow?: undefined; newRow: Row }
  | { op: 'delete'; oldRow: Row;        newRow?: undefined }
  | { op: 'update'; oldRow: Row;        newRow: Row };
```

`applyInverseProjection` (`core/database-materialized-views.ts`) now narrows on
`change.op` and reads `change.newRow` / `change.oldRow` directly — the four
`change.newRow!` / `change.oldRow!` non-null asserts are **gone**. A mis-paired hook
site is now a compile error. The optional `oldRow?: undefined` / `newRow?: undefined`
on the off-arms keep the members distinguishable and let un-narrowed reads see
`undefined` rather than a type error.

The single named type is referenced from the three sites that previously inlined the
literal: `Database._maintainRowTimeCoveringStructures` (`database.ts`), the
`DatabaseInternal` interface (`database-internal.ts`), and `maintainRowTimeStructures`
(`dml-executor.ts`). This is the unification the `3.6-...-mv-over-mv-cascade` review
ticket (item #3) explicitly deferred to this ticket ("same shape by design").

**Verify:** every construction site conforms without a cast — `applyMaintenanceToLayer`
(manager.ts), the DML hook calls (dml-executor.ts), the internal-eviction call
(manager.ts ~L1095), and the store eviction call (`quereus-store/store-table.ts`
~L1026). All compile clean; the union is strictly tighter than the old interface, so
the compiler is the proof here.

### 2. Hoisted `tableKey` in `dml-executor.ts`
`` `${tableSchema.schemaName}.${tableSchema.name}` `` was rebuilt inline at 8 hook
sites. Each of `processInsertRow` / `processUpdateRow` / `processDeleteRow` now computes
`const tableKey` once near the top; the 8 inline rebuilds collapse to `tableKey`. (The
insert path already had a `tableKey` mid-function — its now-duplicate later declaration
was removed.) Pure refactor, no behavior change.

### 3. Cosmetic casts (`core/database-materialized-views.ts`)
- Dropped the redundant `... as Row` in `applyInverseProjection`'s `project` (the
  `.map(...)` already yields `SqlValue[]`, and `Row = SqlValue[]`).
- Added `getConnectionsForTable` / `registerConnection` to
  `MaterializedViewManagerContext` and removed the `this.ctx as unknown as Database`
  double-cast from `getBackingConnection` (it now calls `this.ctx.*` directly). `Database`
  structurally satisfies the widened interface (both are public methods); the manager is
  constructed as `new MaterializedViewManager(this)`.

### 4. Explicit window-function reject (`buildMaintenancePlan`)
Added `if (containsNodeType(analyzed, PlanNodeType.Window)) reject('its body uses a
window function');` alongside the aggregate/join/DISTINCT/… rejects. Window functions
were already caught structurally (a window output column resolves to neither a
passthrough source column nor a single-row-evaluable expression), so this only upgrades
the diagnostic — it does not accept/reject anything that wasn't already (in)eligible.

### 5. **[BEHAVIORAL]** `compilePredicate` truthiness delegates to `isTruthy` (`vtab/memory/utils/predicate.ts`)
Was: a non-null value is truthy unless it is `false | 0 | 0n | ''`. This diverged from
the engine's canonical `isTruthy` (`util/comparison.ts`), which does numeric-string
coercion: `'abc' → 0 → false`, `'0' → false`, blobs → false. A new `predicateTruthy(v)`
helper returns `null` for NULL (unknown) and otherwise `isTruthy(v)`; it now backs the
top-level `evaluate`, the unary `NOT`, and the three-valued `AND` / `OR` short-circuits
(which also DRYs four copies of the old falsy check). Three-valued (Kleene) semantics
are preserved — see the inline `AND`/`OR` comments.

**Effect:** a partial index / partial UNIQUE / materialized-view predicate that is a
*bare* string / blob value (e.g. `where flagcol` where `flagcol` is text) now scopes
rows exactly as the Filter / runtime path does. Comparison predicates (`x > 5`,
`status = 'active'`, `… is null`, `… in (…)`) are **unaffected** — they already returned
proper booleans. This is `compilePredicate`, which is shared by **memory partial
indexes, memory + store partial UNIQUE, and row-time MV partial WHERE**, so the
correctness improvement lands across all three (the ticket flagged it as "affects more
than row-time").

## How to validate (all run, all green)
- `yarn build` — clean across all packages (no `error TS`).
- `yarn workspace @quereus/quereus run lint` — exit 0, no findings.
- `yarn test` — full memory suite: **3948 passing, 9 pending, 0 failing** (now +the new
  partial-index section, verified below).
- `yarn test:store` — full LevelDB-backed logic suite: **3944 passing, 13 pending,
  0 failing**. Run because the store module shares `compilePredicate`; this exercises the
  behavioral change on the store partial-index/UNIQUE path.
- Single-file iteration for the predicate change (both backends green):
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "10.5.1-partial"`
  and the same prefixed with `QUEREUS_TEST_STORE=true`.

## Tests added (the floor — extend, don't trust as ceiling)
- **`test/logic/10.5.1-partial-indexes.sqllogic` § 8 (new)** — pins the corrected
  bare-value truthiness via an observable partial UNIQUE: `create unique index … where
  flag` (bare text column). Two rows with `flag='abc'` (non-numeric → predicate FALSE →
  out of scope) share a code → **allowed** (would have been a UNIQUE error under the old
  rule); two rows with `flag='1'` (numeric-truthy → in scope) share a code → **rejected**.
  Passes in memory and store mode.

## Honest gaps / review focus
1. **Item 5 is the one behavioral change — scrutinize it.** I am confident the new
   behavior is *correct* (it matches `isTruthy` / SQLite numeric truthiness), and no
   existing test relied on the old behavior (every partial predicate in the suite is a
   comparison; I grepped). The new § 8 is the only test that exercises a *bare-value*
   predicate. Consider whether more bare-value forms deserve coverage: a bare value
   inside `not (…)`, a bare value as an `and`/`or` operand, and a **blob** bare value
   (`isTruthy` returns false for blobs; untested here). Also worth a sanity check: confirm
   no production schema/test elsewhere intentionally used `where <text-col>` expecting the
   old "any non-empty string is truthy" scoping — the full-suite green strongly implies
   not, but it is a semantics change in a shared util.
2. **`buildMaintenancePlan` still has `const db = this.ctx as unknown as Database`.** Only
   the `getBackingConnection` cast was removable via the two new context methods. This one
   stays because `db` is handed to `optimizer.optimizeForAnalysis(plan, db)` and
   `compileSourceRowEvaluator(db, …)`, both of which need a real `Database` (the latter
   builds an `EmissionContext` and `RuntimeContext`). Fully decoupling that would mean
   widening the context with plan-optimization + runtime-emission surface — out of scope
   for a "cosmetic cast" cleanup, and called out in the original ticket as a pre-existing
   pattern.
3. **Performance note deliberately NOT addressed (per ticket).** `getBackingConnection`
   still scans all active connections per maintained row when no per-statement cache is
   supplied (the cold enforcement/eviction callers). The ticket explicitly left a
   per-transaction plan cache out (staleness risk across txn boundaries). No change here.
4. **No new test for items 1–4** — they are type-only / DRY / diagnostic refactors with no
   behavior change, covered as regression by the existing MV row-time suites (`53`/`54`),
   the MV diagnostics spec, and the partial-index/UNIQUE suites. The compiler is the proof
   for the discriminated union; the green suite is the proof for the `tableKey` hoist.

## No `.pre-existing-error.md` written
No unrelated/pre-existing failures surfaced during validation.
