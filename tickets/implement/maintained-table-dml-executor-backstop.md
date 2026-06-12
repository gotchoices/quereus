description: Engine-level READONLY backstop for maintained tables — reject any mutation plan whose DML executor targets a derivation-bearing table, update the backing-host "read-only to user DML" contract wording to the engine-owned story, and pin the remaining test gaps (aggregate-body DML reject, direct DML after detach).
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # the seam: add emit-time guard after `const tableSchema = plan.table.tableSchema` (~line 121)
  - packages/quereus/src/schema/derivation.ts                  # isMaintainedTable — the structural key (guard helper may live here or in dml-executor)
  - packages/quereus/src/vtab/backing-host.ts                  # header § "Read-only to user DML" — reword to engine-owned enforcement
  - docs/materialized-views.md                                 # § DDL bullet ("must reject user DML (READONLY)", ~line 84) + § Write boundary
  - packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic   # add aggregate-body DML reject pin
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic    # add direct-DML-after-detach pin (if absent)
  - packages/quereus/test/mv-cross-schema-dispatch.spec.ts     # reference pattern for spec-level pins (do not regress)
----

# Maintained-table READONLY backstop at the DML executor

Successor to the plan ticket `backing-tables-readonly-enforcement`. The
landscape that ticket described no longer exists: the unified maintained-table
model (`maintained-table-unified-model`, complete) retired `_mv_` backing
tables, and user DML naming a maintained table is now **write-through by
design** — the three DML builders dispatch it through `buildViewMutation`
(name check + resolved-schema backstop), and non-updatable bodies get a clean
plan-time diagnostic. "Read-only" semantics now apply only to the table's
**storage**: nothing but the privileged surfaces may write a maintained
table's rows.

## Settled design — engine-level seam, no per-module guards

**Decision: enforcement is engine-level, two layers, both keyed structurally
on `derivation` presence (`isMaintainedTable`), never on names.**

1. **Plan-time dispatch** (already landed in 6.1, including the
   resolved-schema backstop from its review) — routes user DML to
   write-through or a named diagnostic.
2. **Emit-time backstop in the runtime DML executor** (THIS ticket) — the
   defense-in-depth layer the plan ticket asked for.

Why the DML executor is sufficient and complete:

- `DmlExecutorNode` is constructed only by the three DML builders
  (`planner/building/{insert,update,delete}.ts`), and the **only**
  `vtab.update()` call sites in the runtime live in
  `runtime/emit/dml-executor.ts` (verified: no other emitter touches
  `UpdateArgs`). Every engine-originated storage write funnels through this
  one seam, in every module configuration — memory, bare store,
  isolation-wrapped store — and for any future host, for free.
- FK cascade actions re-enter through `db.prepare(sql)`
  (`runtime/foreign-key-actions.ts`), so they hit the plan-time dispatch like
  any other statement.
- The bug class to guard is exactly the one the 6.1 review found and fixed
  (the schema-path dispatch hole): a plan-time mis-dispatch produces a
  direct-write plan whose execution **silently diverges** derived contents.
  The backstop converts that whole class into a loud READONLY error.

Why per-module guards are **rejected** (do not add them):

- Module-held schemas cannot key the check: `buildBackingTableSchema` hands
  the module a derivation-less `TableSchema` (the derivation is attached to
  the catalog record afterward via `attachDerivation`), and attach/detach
  (`alter table … set/drop maintained`) are deliberately **catalog-only
  flips** that never notify the module. A module-side structural check would
  miss attaches and false-positive after detaches; fixing that means new
  schema-sync plumbing in three modules for a redundant check.
- The privileged surfaces (`BackingHost.applyMaintenance` /
  `replaceContents`, attach reconcile `'replace-all'`, store rehydrate-refill,
  isolation flush `trustedWrite`) bypass `update()` by construction — they
  never pass through the DML executor, so the backstop cannot interfere.
- Direct programmatic vtab writes by an embedder are the same trust level as
  holding the backing-host surface itself — out of engine scope; document in
  `backing-host.ts`.
- The memory module's existing `isReadOnly` flag means "fully immutable"
  (ALTER and `replaceBaseLayer` guards throw on it). Do **NOT** stamp it on
  maintained tables — that was the trap the original ticket identified; it
  stays untouched and unrelated.

Cached-plan staleness across attach/detach is already handled:
`materialized_view_added/removed/modified` invalidate `'table'` statement-cache
dependencies (landed in `maintained-table-attach-detach-verbs`, pinned by
`maintained-table-attach-detach.spec.ts`), so no stale emitted program
survives a catalog flip. The backstop is the second net if that ever
regresses.

## The guard

In `emitDmlExecutor`, immediately after
`const tableSchema = plan.table.tableSchema;`: if
`isMaintainedTable(tableSchema)`, throw `QuereusError` with
`StatusCode.READONLY` and a message that names the schema-qualified table and
states its contents are derived, e.g.:

```
table 'main.mv' is a maintained table — its contents are derived and may not
be written directly (user DML routes through write-through; this plan
bypassed the dispatch — engine bug)
```

Emit-time, not per-row: zero runtime cost, and it matches plan-time semantics
(emission happens at prepare; invalidation re-plans on flips). Extract the
check into a small exported function (in `dml-executor.ts` or next to
`isMaintainedTable` in `derivation.ts`) so a spec test can exercise it
directly with a derivation-bearing schema — the backstop is deliberately
unreachable from SQL, so end-to-end forcing is not required; the exported
guard test plus the wiring (one call site) is the honest pin.

## Edge cases & interactions

- **Write-through plans must not trip the guard**: the view-mutation rewrite
  re-plans against the BASE table, so `plan.table.tableSchema` is the base —
  the full 53.1 suite passing in both memory and store modes is the net.
- **Privileged paths must keep working untouched**: create-fill /
  attach-to-empty reconcile, `set maintained` re-attach reconcile, REFRESH
  (`replaceContents`), row-time maintenance (`applyMaintenance`), store
  rehydrate-refill, isolation flush `trustedWrite` — none route through the
  DML executor; 51 / 51.7 / 53.x green in `yarn test` AND `yarn test:store`
  proves it.
- **Aggregate (non-updatable) body**: DML against an aggregate-bodied
  maintained table must fail with the clean plan-time mutation diagnostic
  naming the table — currently an untested gap (53.1 pins predicate-
  contradiction / non-invertible / nested-MV rejects, no aggregate pin). Add
  the pin; assert the actual message when writing it. If the diagnostic calls
  the target a "view", adjust the wording to say materialized view /
  maintained table — minor, in scope.
- **Detach sheds enforcement structurally**: after
  `alter table t drop maintained`, `t` is a plain table and direct DML must
  succeed (and after a re-attach, route write-through again). Pin in 51.7 if
  not already pinned.
- **Nested MV writes** (view-over-MV, MV-over-MV): already rejected at plan
  time in `planner/mutation/single-source.ts` — unchanged; do not duplicate.
- **FK cascade targeting a maintained child**: re-enters via SQL → dispatch
  applies. Declared-constraint semantics on maintained tables remain
  `maintained-table-declared-constraint-semantics` (backlog) — out of scope.
- **Cross-schema / schema-path resolution**: the dispatch backstop on the
  resolved schema is pinned by `mv-cross-schema-dispatch.spec.ts` — must not
  regress; the new guard sits behind it.
- **Never key on names**: no `_mv_` or name-pattern logic anywhere —
  `derivation` presence only.

## Docs

- `vtab/backing-host.ts` header § "Read-only to user DML": reword from "a
  backing table must reject user DML (READONLY)" (module-owed, stale) to the
  engine-owned story: the planner routes user DML through write-through; the
  runtime DML executor rejects any mutation plan targeting a maintained table
  (READONLY backstop); the privileged surface bypasses both by construction;
  direct programmatic vtab writes are the embedder's responsibility.
- `docs/materialized-views.md`: same bullet (§ DDL/backing-host, ~line 84)
  plus a sentence in § Write boundary naming the backstop.

## TODO

- Add the emit-time guard in `emitDmlExecutor` (exported helper +
  one call site), READONLY, message naming the schema-qualified table.
- Reword `backing-host.ts` header and `docs/materialized-views.md` to the
  engine-owned enforcement story.
- Spec test for the guard helper: derivation-bearing schema → READONLY naming
  the table; plain schema → no throw.
- sqllogic: aggregate-bodied maintained-table DML reject pin (53.1), in both
  memory and store suites; adjust diagnostic wording if it misnames the
  target.
- sqllogic: direct-DML-after-detach pin (51.7) if absent.
- `yarn lint`, `yarn build`, `yarn test`, and `yarn test:store` green (the
  store suite is warranted here: the privileged store paths — rehydrate,
  reconcile — are exactly what the guard must not break).
