description: Unified materialized-view rehydration under `SchemaManager.importCatalog` — the create-MV materialize core was extracted into a shared `materializeView` helper called from both the create emitter and a new silent `importMaterializedView`, and the store's phase-3 `db.exec` loop was replaced with `importCatalog`. Reviewed; two defense-in-depth gates added on the import path.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # MaterializeViewDefinition + materializeView (shared core); review added arity gate here
  - packages/quereus/src/runtime/emit/materialized-view.ts           # create emitter rewired onto the helper
  - packages/quereus/src/schema/manager.ts                           # importMaterializedView (review added DML-body gate); importDDL/importCatalog arms; result gains materializedViews
  - packages/quereus-store/src/common/store-module.ts                # rehydrate phase 3 now importCatalog
  - packages/quereus-store/src/common/key-builder.ts                 # decodeMaterializedViewCatalogKey removed (dead)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # MV-import engine tests; review added DML-body + arity tests
  - packages/quereus-store/test/view-mv-persistence.spec.ts          # ineligible-body rehydrate-error test
  - docs/schema.md                                                   # importCatalog contract + Rehydrate phasing
  - packages/quereus-store/README.md                                 # rehydrate description + export table
----

# Complete: MV rehydration unified under importCatalog

## What landed (implement stage)

- `materializeView(db, def)` extracted into `materialized-view-helpers.ts` —
  the create emitter's core (derive backing shape → create + fill memory
  backing → register MV record + row-time maintenance, with identical
  rollback-on-throw) shared by `emitCreateMaterializedView` and the new
  `SchemaManager.importMaterializedView`. Fires `table_added` for the backing;
  never `materialized_view_added` (caller decides — create notifies, import is
  silent).
- `importCatalog` gained a `createMaterializedView` arm and a
  `materializedViews: string[]` result field. MV import plans the body eagerly
  (order-dependent by design); the store's phase-3 loop now calls
  `importCatalog` per entry, keeping tables → views → MVs phasing, per-entry
  error collection, and the fixpoint retry for MV-over-MV ordering.
- Dead `decodeMaterializedViewCatalogKey` removed (names now come from the
  import result). Docs updated (`docs/schema.md`, store README).

## Review findings

**Checked** (full implement diff read fresh before the handoff summary):

- **Extraction fidelity** — `materializeView` is a line-faithful move of the
  emitter core; existence/collision checks, `_ensureTransaction`, and the
  `materialized_view_added` notify correctly stayed in the emitter. Error
  surfaces and rollback behavior unchanged on the create path.
- **Fixpoint-loop contract** — verified `importCatalog` *rethrows* per-entry
  errors (manager.ts catch logs then `throw e`), which the store's phase-3
  retry loop depends on; a swallow there would have silently dropped MVs.
  Loop termination is sound (each round either shrinks `pending` or breaks).
- **Body-hash / DDL consistency** — the import path constructs `sql`
  (`createMaterializedViewToString(stmt)`), `bodySql` (`astToString(stmt.select)`),
  and `tags` (`Object.freeze({...stmt.tags})`) *identically* to
  `buildCreateMaterializedViewStmt`, so `bodyHash` is stable across
  create → persist → reopen (the differ and refresh no-churn depend on this).
- **Result-name shape change** — `RehydrationResult.materializedViews` entries
  are now DDL-cased `schema.name` (vs. the old lowercased catalog-key decode).
  Checked consumers: tests assert the new shape; the docstring documents the
  arrays as additive (external consumers like quoomb-web read only `.errors`).
- **No-transaction import path** — the one semantic delta from the old
  `db.exec` route. `replaceBaseLayer` self-latches and `collectBodyRows` uses
  the no-transaction `_iterateRowsRaw`; all store round-trip tests (MV bodies
  reading LevelDB-backed tables, depth-3 MV chains across fixpoint rounds)
  pass. Accepted; not exhaustively proven for arbitrary third-party vtabs.
- **Layering** — the new runtime edge `schema/manager → runtime/emit/
  materialized-view-helpers` introduces no eval-time cycle: every other import
  of `schema/manager.js` outside `core/` is type-only, and manager already
  runtime-imports planner code (`planner/building/expression`), so the
  direction has precedent. Acceptable; the downstream
  `mv-backing-module-pluggability` ticket is the natural place if the helper
  ever needs a more neutral home.
- **Docs** — `docs/schema.md` (importCatalog contract, Rehydrate phasing) and
  `packages/quereus-store/README.md` (rehydrate description, export table sans
  the removed decode helper) read and confirmed accurate against the code.
- **Dead-code removal** — `decodeMaterializedViewCatalogKey` fully gone
  (source, package export, README table); no stale references remain.

**Found and fixed in this pass (minor):**

1. **DML-body gate lost on the import path.** The MV grammar accepts any
   `QueryExpr` with RETURNING (parser line ~2765), so
   `create materialized view mv as delete from base returning *` parses. The
   old `db.exec` rehydrate route rejected it in `planViewBody` *before*
   execution; the new import path would have **executed the mutation** during
   rehydrate (via `collectBodyRows`) before the eligibility gate threw.
   Un-creatable via SQL, but a corrupt/hand-edited catalog entry could carry
   it. Fixed: `importMaterializedView` rejects `insert`/`update`/`delete`
   bodies before materializing. Test added asserting the source rows survive
   the rejected import.
2. **Declared-column arity check lost on the import path.** The builder
   validates `mv(a, b, c)` arity against the body; import skipped it (a
   mismatched corrupt entry would have mis-rehydrated with `?? colN`
   fallbacks). Fixed: arity gate added in `materializeView` (create path
   unreachable — builder errors first). First placement inside
   `deriveBackingShape` was **wrong** and caught by the logic suite: the
   *refresh* path legitimately reaches an arity mismatch after
   `alter table add column` and has its own "drop and recreate" diagnostic —
   the gate was moved up to `materializeView`, which refresh does not call.
   Test added.

**No major findings** — no new tickets spawned. The fixpoint-vs-topo-sort
decision is correct (resolved `sourceTables` are plan-time, not serialized;
the O(n²)-worst-case re-fill cost is identical to the old `db.exec` route).
The event-churn change (no `materialized_view_added` on import) is intended
and the second-reopen byte-identity test still holds. A hand-planted
`using <unsupported>()` clause now silently rehydrates as memory instead of
erroring — accepted: `generateMaterializedViewDDL` deliberately never persists
a `using` clause (documented as informational), so self-written catalogs
cannot carry one.

## Validation

- `yarn build` (all packages): clean. `yarn lint` (quereus): clean.
- `yarn test` (full workspace): all passing — including the two new
  review-stage tests (DML-body rejection, arity mismatch) and the
  implement-stage suites (silent MV import + maintenance, MV-over-MV import,
  ineligible-body rollback, "must be a set" rollback; store reopen rebuild,
  tags, durable drop, refresh no-churn, mixed classification, depth-3 chain,
  idempotent second reopen, memory-source error, ineligible-body per-entry
  rehydration error).
- `yarn test:store` (logic tests on LevelDB): 5546 passing.
