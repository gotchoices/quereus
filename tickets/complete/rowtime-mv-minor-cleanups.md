description: COMPLETE — Five row-time-MV cleanups reviewed. Four are pure type-safety / DRY / diagnostic refactors; one (compilePredicate truthiness now delegating to the engine's canonical isTruthy) is the lone behavioral change. Review confirmed all five correct; build + lint + full test suites green. No major findings; minor notes documented below, additional bare-value test coverage spun out to backlog (rowtime-mv-predicate-truthy-extra-tests).
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-internal.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
----

# rowtime-mv-minor-cleanups — COMPLETE

Reviewed implement commit `7947b2a4`. Five changes across six source files plus one
test-file addition. Conclusion: **the implementation is correct and ships as-is.** No
major findings; no inline fixes required (see "DRY re-check" below — the one DRY concern
that surfaced mid-review turned out to be a tooling artifact, not a real defect).

## What was reviewed

- The full implement diff (`git show 7947b2a4`), read with fresh eyes before the handoff.
- `predicate.ts` in full (268 lines) and `util/comparison.ts` `isTruthy` (L394-417) —
  the behavioral change and its dependency, line by line.
- All five type/DRY/diagnostic edit sites (manager.ts, database.ts,
  database-internal.ts, dml-executor.ts, database-materialized-views.ts) — every
  `BackingRowChange` construction site, the de-cast `getBackingConnection`, the widened
  `MaterializedViewManagerContext`, the window-function reject, and the hoisted
  `tableKey`.
- `yarn build` (all packages), `yarn workspace @quereus/quereus run lint`, and
  `yarn test` (all workspaces) — re-run, all green.

## Review findings

### Item 5 — `compilePredicate` truthiness (the BEHAVIORAL change): CORRECT

The single truthiness helper is:
```ts
function predicateTruthy(v: SqlValue): boolean | null {
  return v === null ? null : isTruthy(v);   // predicate.ts:17-19
}
```
NULL → `null` (unknown); every other value → the engine's canonical `isTruthy`
(numeric-string coercion: `'abc'`→0→false, `'0'`→false, blobs→false,
`util/comparison.ts:394-417`). This is exactly the engine/Filter semantics, so partial
index / partial UNIQUE / row-time-MV predicates that are a *bare* scalar now scope rows
identically to the runtime path. Verified the three-valued (Kleene) logic against the
truth tables, reading the actual source:

- **AND** (`predicate.ts:201-210`): `a===false → false; b===false → false;
  a===null||b===null → null; else true`. Confirms `false AND null = false`,
  `null AND false = false`, `true AND null = null`, `null AND null = null`. ✓
- **OR** (`211-220`): `a===true → true; b===true → true; a===null||b===null → null;
  else false`. Confirms `null OR true = true`, `false OR null = null`,
  `true OR false = true`. ✓
- **NOT** (`161-165`): `t===null ? null : !t`. `NOT null = null`, `NOT true = false`,
  `NOT false = true`. ✓
- **Top-level `evaluate`** (`57`): `predicateTruthy(evaluator(row))` → `boolean | null`;
  the `CompiledPredicate` contract (doc at `22-26`) is "only `true` includes the row;
  `false` and unknown both exclude". The `boolean | null` return is **not new** — the
  three-valued IN (`134-145`) and comparison NULL handling (`makeCompare`, `260-266`)
  predate this change, and the handoff confirms "Kleene semantics preserved". So no new
  burden was placed on callers; only the *truthiness mapping of bare non-null scalars*
  changed. **Confirmed from the diff**: the old `evaluate`/`NOT`/`AND`/`OR` already
  returned `boolean | null` via inline `=== false/0/0n/''` checks; the change swaps that
  inline rule for `predicateTruthy` — the *return contract is identical*, only the scalar
  mapping differs. **All four `evaluate()` callers were checked and correctly gate on
  `=== true` / `!== true`** (so `null` = excluded): `vtab/memory/index.ts:55`
  (`=== true`), `manager.ts:962` and `manager.ts:1136` (`!== true`), and
  `database-materialized-views.ts:431` (`=== true`). The full memory (3948 passing) +
  store (3944 passing) suites passing further corroborates this.
- **Leaf operators unaffected** (re-verified, not assumed): `= == <> != < <= > >=` via
  `makeCompare` return proper three-valued booleans; `IS`/`IS NOT` (`235-251`) do total
  equality returning a concrete boolean (correct even for two non-null operands —
  they use `compareSqlValues` directly, *not* `makeCompare`); `IS NULL`/`IS NOT NULL`
  (`157-160`) and `IN` (`117-146`) return proper booleans/null. None route through the
  new helper, which is correct because they already produce well-formed three-valued
  results, and `predicateTruthy(true/false/null)` is the identity on those.

**DRY re-check (important).** Mid-review, a stale code-search index plus a char-encoded
shell read suggested the file contained *three* overlapping truthy helpers
(`predicateTruthy` / `predicateTruthyValue` / `evalNodeValue`) — a DRY violation. This
was a **tooling artifact, not reality**: the canonical file read and a literal count both
confirm `predicateTruthyValue` and `evalNodeValue` **do not exist** — there is exactly
one helper, `predicateTruthy`, and each sub-expression compiles to a single `Evaluator`
that `predicateTruthy` converts at the boolean boundaries (AND/OR/NOT/top-level). The
design is clean and already DRY. **No fix needed.**

### Items 1–4 — type-safety / DRY / diagnostic refactors: CORRECT

1. **`BackingRowChange` discriminated union** (`manager.ts:86-89`) — definition matches
   the intended shape. Every construction site conforms without a cast: `delete` sets
   `oldRow` only, `insert` sets `newRow` only, `update` sets both —
   `applyMaintenanceToLayer` (delete-key / upsert arms), the internal-eviction call, the
   six DML hook sites in `dml-executor.ts`, and the store eviction call. The union is
   strictly tighter than the old optional-field interface, so `yarn build` passing across
   all packages is the proof. `applyInverseProjection`
   (`database-materialized-views.ts`) narrows on `change.op` with **zero** `newRow!` /
   `oldRow!` non-null asserts (literal count = 0). ✓
2. **`tableKey` hoist** (`dml-executor.ts`) — exactly three `const tableKey`
   declarations (L460/595/732, one per `processInsertRow`/`processUpdateRow`/
   `processDeleteRow`), each building `` `${tableSchema.schemaName}.${tableSchema.name}` ``;
   the full inline-rebuild template appears **only** at those three lines (no leftover
   rebuilds at hook sites), and there is no duplicate declaration in any function (the
   previously-duplicated insert-path one is gone). ✓
3. **Cosmetic casts** (`database-materialized-views.ts`) — `getBackingConnection` calls
   `this.ctx.getConnectionsForTable(...)` / `this.ctx.registerConnection(...)` directly;
   both methods are declared on the widened `MaterializedViewManagerContext` interface
   (L88-89) and exist on `Database`. Exactly **one** `as unknown as Database` remains
   (L539), feeding `optimizer.optimizeForAnalysis` / `EmissionContext` / `RuntimeContext`
   — all of which require a concrete `Database`. This is the documented, pre-existing,
   out-of-scope cast (handoff gap #2); leaving it is correct. ✓
4. **Window-function reject** (`buildMaintenancePlan`, L575) —
   `if (containsNodeType(analyzed, PlanNodeType.Window)) reject('its body uses a window
   function');` is present. Upgrades the diagnostic only (window outputs were already
   structurally ineligible); accepts/rejects nothing new. ✓

### Minor notes (documented, not blocking)

- **`return () => value as SqlValue;` (`predicate.ts:76`)** — an unchecked narrowing cast
  on a literal value (after the async/promise guard above it). Pre-existing pattern, not
  introduced or touched by this ticket's behavioral change; acceptable. Left as-is.
- **Test coverage** — the new `§ 8` of `10.5.1-partial-indexes.sqllogic` pins the
  *top-level* bare-value path (bare text col in a partial UNIQUE `where`). It does **not**
  exercise a bare value routed through the changed `predicateTruthy` calls *inside* `NOT`
  (`compileUnary`) or `AND`/`OR` (`compileBinary`), nor a **blob** bare value
  (`isTruthy(blob)=false`, `comparison.ts:414`, a distinct untested branch).
  Behaviorally these traverse the same verified `isTruthy` delegation, so this is hardening
  rather than a correctness gap — spun out to backlog as
  `rowtime-mv-predicate-truthy-extra-tests` rather than added blind (see below).

### Categories with nothing to report

- **Resource cleanup / async correctness**: predicate evaluators are pure synchronous row
  reads (no handles, no awaits); the MV maintenance path was untouched by this ticket
  beyond the type rename. Nothing to clean up. Empty by construction.
- **Error handling**: `compilePredicate`'s unsupported-form throws (QuereusError at
  index-creation time) are unchanged and correct. No swallowed exceptions introduced.
- **Major findings**: none. No fix/plan tickets filed for defects.

## Validation (all green)

- `yarn build` — exit 0, all packages, no `error TS` (compiler is the proof for the
  discriminated-union construction sites).
- `yarn workspace @quereus/quereus run lint` — exit 0, no findings.
- `yarn test` — exit 0 across all workspaces (quereus memory logic suite green;
  shared-ui/others green). Matches handoff's 3948 passing / 9 pending / 0 failing for the
  quereus memory suite, now including the new `§ 8`.

## No `.pre-existing-error.md`

No unrelated/pre-existing failures surfaced.

## Reviewer environment note

This session's Bash/PowerShell stdout echo and the code-search semantic index were
intermittently unreliable (truncated/stale on repo source content). Review conclusions
rest on channels that were reliable: the `Read` tool (full, accurate file content),
literal symbol counts cross-checked against `Read`, two independent sub-agent deep-reads
of all six files, and `build`/`lint`/`test` exit codes. The one finding that depended on
an unreliable channel (the spurious "duplicate truthy helpers" DRY concern) was
re-checked against the canonical `Read` and retracted. Because focused test re-runs could
not be reliably reproduced near the end of the session, the optional additional test
coverage was filed to backlog rather than added unverified.

## End
