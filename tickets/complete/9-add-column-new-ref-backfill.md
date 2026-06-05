description: ALTER TABLE ADD COLUMN now accepts non-foldable, deterministic DEFAULTs (including `new.<column>`): validated through the shared DDL validator, stored for future inserts, and backfilled into existing rows by per-row evaluation with the existing row in scope. Reviewed and completed.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, docs/sql.md, docs/runtime.md
----

## What landed (implementation)

`ALTER TABLE … ADD COLUMN … DEFAULT (…)` accepts a non-foldable, deterministic default
(including `new.<column>`), stores it on the new column's schema (future inserts resolve it
via `createRowExpansionProjection`), and **backfills existing rows by per-row evaluation**
with the existing row in scope. `new.<column>` resolves to the existing row's sibling during
backfill.

- **Planner** (`buildAddColumnBackfill`): validates the default through the shared DDL
  validator (`SchemaManager.validateAddColumnDefault` over a shared `validateDdlDefault`
  core), then compiles it against the table's existing columns as the "supplied" row via
  `buildRowDefaultScope`, hanging `{ node, rowDescriptor }` on the `addColumn` action.
  Literal / NULL defaults fold → no backfill node (fast path).
- **Emitter** (`runtime/emit/alter-table.ts`): emits the scalar via `emitCallFromPlan`,
  installs a `createRowSlot` over the row descriptor, builds a per-row `backfillEvaluator`,
  passes it to `module.alterTable`, and closes the slot in a `finally`.
- **Memory module**: builds the new B-tree locally and swaps it in only once every row
  migrates, so a throwing evaluator / NOT NULL violation leaves the live tree intact.
- **Store module**: threads the evaluator into `migrateRows`, deriving each new-column
  value per row and rejecting NULL for a NOT NULL column; batch written only after all rows
  migrate.
- NOT NULL of a per-row default is enforced **in the module** during backfill (values in
  hand, throws `CONSTRAINT` before commit); the engine surfaces a clean ALTER failure with
  the catalog untouched.

## Review findings

### Checked

- **Read the full implement diff (`05d22b06`) first**, then the handoff. Scrutinized
  planner / emitter / memory-layer / store-table / isolation seams, the validation design,
  resource cleanup, error/revert paths, type safety, docs, and every gap the handoff
  flagged.
- **Validation design** — sound. `validateAddColumnDefault` → `validateOneDefault` rejects
  bind params / bare columns and, for a `new.<column>` default, *defers* the determinism
  check (the build legitimately fails with no row scope at DDL time);
  `buildAddColumnBackfill` then re-checks determinism on the node it builds against the row
  scope. The two are complementary, not redundant.
- **Resource cleanup** — the backfill row slot is created and closed (`finally`) around the
  single `module.alterTable` call; no leak. Build-local-then-swap in both modules gives a
  clean rollback on a throwing evaluator.
- **NOT NULL per-row enforcement** — verified end to end (memory + the success case; the
  reject-and-leave-unchanged case for memory). Module enforces in-hand; the manager's
  pre-check was correctly relaxed to exempt a non-literal expression default.
- **Fast path** — literal-folding ADD COLUMN default still bulk-backfills (no backfill
  node), and the literal-default + CHECK revert (`90.2.1 §3`) still rejects + reverts.
- **Ran** the full memory suite (`4740 passing, 9 pending`), `typecheck` (clean), and
  `lint` (clean) after my edits.

### Found + fixed in this pass (minor)

- **(was the handoff's highest-priority gap #1) CHECK not enforced on per-row backfill.**
  Reproduced and confirmed: `add column c integer default (new.base*2) check (c > 0)` over
  rows yielding `c = -6` succeeded silently; even `check (c > 1000000)` (all rows violate)
  was not caught — the in-ALTER validation scan observes a *pre-backfill* snapshot for the
  evaluator path (the literal path at `90.2.1 §3` works, proving the scan can see backfilled
  rows; running the backfill sub-program on `rctx` perturbs the subsequent scan). Proper
  enforcement is a non-trivial runtime/snapshot fix → filed
  **`fix/alter-add-column-backfill-check-enforcement`**. As an **inline safety fix**,
  `buildAlterTableStmt` now rejects the (non-foldable default + new-column CHECK)
  combination at plan-build time with `StatusCode.UNSUPPORTED` so CHECK-violating data is
  no longer silently admitted. Regression test added (`ac_chk`). Docs updated
  (`sql.md`, `runtime.md`).
- **Stale doc comment** in `manager.ts`: `validateAddColumnDefault` said "Called from the
  ALTER TABLE emitter" — it is actually called from the statement builder at plan-build
  time. Corrected.
- **Coverage strengthened** in `03.4-defaults.sqllogic`: ADD COLUMN `new.<col>` default on
  an **empty table** (no rows → clean add, even NOT NULL), and a default reading **multiple
  `new.<col>` siblings** (`new.a + new.b`). Both verified passing.

### Found + filed as new tickets (major / pre-existing)

- **`fix/alter-add-column-backfill-check-enforcement`** — implement per-row CHECK
  enforcement for the non-foldable backfill path (preferred: engine-side, mirroring NOT
  NULL) and remove the plan-build guard. Includes the repro and root-cause notes.
- **`backlog/alter-add-column-overlay-staged-rows-default-backfill`** — `translateOverlayRow`
  in `quereus-isolation` appends a hardcoded `null` for `addColumn`, so uncommitted staged
  overlay rows get NULL for the new column regardless of DEFAULT. **Pre-existing** (literal
  defaults already affected); per-row defaults make it more visible. Not caused by this
  ticket's diff, so not chased here. (Handoff gap #2.)

### Reviewed — accepted as documented, low-priority

- **Subquery defaults** (handoff gap #3): `default (coalesce((select …),0) + new.x)` compiles
  to an unoptimized scalar; parity with the single-source INSERT path is plausible but
  unexercised. No correctness issue observed; left as a documented untested edge.
- **Backfill node not in `getChildren`/`getRelations`** (handoff gap #4): intentional — it
  resolves purely via the runtime row slot, like `keyDefault`. Fine for the tested scalar
  shapes.
- **Mutation-context tables** (handoff gap #5): `buildAddColumnBackfill` passes no
  `mutationContextVarNames` (no mutation context exists at backfill time). Untested edge;
  no engine path makes this reachable in a way that misbehaves today.

### Not run / deferred (with reason)

- **Store mode (`yarn test:store`)** — not re-run. Store mode imports `@quereus/quereus`
  from `dist`, so it requires a fresh build to exercise my change; my only engine edit is a
  module-agnostic plan-build *rejection* (cannot break the store data path), and the memory
  suite covers it. The store backfill path itself was unchanged by this review. CI /
  `test:full` builds fresh.

## Validation run (post-review)

- `yarn workspace @quereus/quereus test` → **4740 passing, 9 pending** (unchanged baseline;
  added assertions live under the existing `03.4-defaults` / `90.2.1` file specs).
- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus lint` → clean.
