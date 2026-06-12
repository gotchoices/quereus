description: The MV refill-path data-loss-on-unrebuildable-body bug is ALREADY FIXED in production code (the declared-arity check was hoisted above the adopt/refill branch by `maintained-table-unified-model`), but the refill path has no regression test guarding it — the only arity test steers through the adopt path. Add a refill-path twin so a future per-branch reordering can't silently reintroduce the drop-before-check data loss.
prereq:
files:
  - packages/quereus/src/schema/manager.ts                          # importMaterializedView: assertDeclaredColumnArity (line ~2767) hoisted ABOVE the adopt/refill branch + drop (line ~2804)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # assertDeclaredColumnArity (the shared pre-drop arity guard) + materializeView (refill core, re-asserts internally)
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # existing adopt-path arity test at "a declared-column arity mismatch under trust…"; refill-shape test at "a source shape change between sessions…"
  - docs/materialized-views.md                                      # § Cross-module atomicity (already states the preserve-before-drop property path-independently, line ~116)
difficulty: easy
----

## Status: production fix already landed — this ticket is a regression-test gap only

The fix-stage investigation reproduced the scenario and found the durable-data-loss
bug **already closed** by the prereq's sibling work `maintained-table-unified-model`
(commit `a203b3dc`). That refactor hoisted the declared-column arity guard:

```
importMaterializedView (packages/quereus/src/schema/manager.ts):
  const shape = deriveBackingShape(...)        // ~2764  throws-before-drop if body can't plan
  assertDeclaredColumnArity(def, shape)        // ~2767  throws-before-drop on arity mismatch
  ...
  if (preExisting) {
    if (trustBackings && tryAdoptPreExistingBacking(...)) return   // adopt path
    await this.dropTable(...)                  // ~2804  DROP — now strictly AFTER both guards
  }
  await materializeView(this.db, def, shape)   // ~2813  refill (re-asserts arity internally)
```

Because `assertDeclaredColumnArity` now runs **above** the adopt/refill branch, the
refill path (a crash-driven or stale-at-close MV) gets the same preserve-before-drop
property the adopt path always had: an unmaterializable body (`select *` widened past
an explicit `mv(a, b)` list) errors per-entry with the durable backing left registered
as a plain table, instead of dropping the rows first. A repro confirmed this: per-entry
error raised, backing still registered, planted sentinel row preserved.

The ticket's second named case — "a structural backing-shape mismatch the body can't
satisfy" — does **not** apply to the refill path: refill drops the old store and
rebuilds the backing from the body's *own* freshly-derived shape (`materializeView` →
`deriveBackingShape`), so there is no frozen structural shape for the body to fail
against. `backingShapeMatches` is purely an adopt-gate concern. The only *provable*
(pre-body-execution) refill failures are plan-failure and arity-mismatch, both already
guarded above the drop. Post-drop failures inside `materializeView` (runtime body
error, duplicate-key "must be a set", row-time eligibility gate) require *running* the
body and are out of scope — the ticket explicitly scopes to a body that **provably**
cannot materialize.

Docs (`docs/materialized-views.md` § Cross-module atomicity, ~line 116) already state
the property path-independently ("the entry can never materialize, so it errors
per-entry with the backing preserved instead of dropping first") — no doc change needed.

## The gap

`packages/quereus-store/test/mv-rehydrate-adopt.spec.ts` covers the arity mismatch only
through the **adopt** path — its test "a declared-column arity mismatch under trust
errors per-entry without dropping the backing" deliberately re-arms a `[]`
clean-shutdown marker to force trust/adopt and isolate `tryAdoptPreExistingBacking`'s
guard (see that test's own comment). There is **no twin** exercising the **refill**
path, so the hoisted-guard property is unguarded: a future refactor that moves the
arity check back inside `materializeView` (i.e. after the drop) would reintroduce
silent durable data loss on the refill path with every existing test still green.

## Expected behavior to lock in

Forcing the refill path (the stale-at-close marker names the MV; the `[]` marker is
NOT re-armed) with a declared-arity mismatch must:
- record exactly one per-entry rehydration error (`/2 declared columns but body produces 3/i`),
- leave NO maintained-table record (`getMaintainedTable('main','mv')` undefined),
- leave the backing registered as a plain table (`getTable('main','mv')` defined),
- preserve a sentinel row planted directly in the physical `main.mv` store (NOT dropped first).

## TODO

- Add a refill-path regression test to `packages/quereus-store/test/mv-rehydrate-adopt.spec.ts`,
  a twin of the existing adopt-path arity test (~line 221). Reuse the same harness
  (`open` / `reopen` / `plantSentinel` / `buildDataKey`). Shape it on the adopt-path
  test but DROP the `catalog.put(buildMetaCatalogKey(CLEAN_SHUTDOWN_META_NAME), '[]')`
  re-arm step so the MV stays in the stale-at-close set and takes the refill branch.
  Sequence: session 1 `create materialized view mv (a, b) using store as select * from src`
  (src 2 cols) → `closeAll`; session 2 reopen → `alter table src add column w integer default 7`
  (marks mv stale-at-close) → `closeAll` → `plantSentinel('main.mv', [99, 990])`; session 3
  reopen → assert the four expectations above. Name/comment it so it is clearly the
  REFILL twin of the adopt-path arity test, and note in a comment that it guards the
  arity guard's placement ABOVE the adopt/refill branch in `importMaterializedView`.
- Run `yarn workspace @quereus/quereus-store test` (or the package's `test` script) and
  confirm the new test passes alongside the existing adopt/refill suite. Run
  `yarn workspace @quereus/quereus-store typecheck`.
