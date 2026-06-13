description: Review parent-side referential enforcement wired into the maintained-table maintenance write path — a maintenance delete/key-update of a maintained table that is an FK PARENT now fires RESTRICT / CASCADE / SET NULL / SET DEFAULT instead of silently orphaning child rows. Engine reused as-is; new entry point + tests + docs.
files:
  - packages/quereus/src/core/database-materialized-views.ts        # enforceParentSideReferentialActions + 2 call sites (maintainRowTime, flushDeferredRebuilds); import of the engine
  - packages/quereus/src/runtime/foreign-key-actions.ts             # the reused engine (UNCHANGED): assertTransitiveRestrictsForParentMutation + executeForeignKeyActionsAndLens
  - packages/quereus/src/core/database-external-changes.ts          # the precedent caller the new hook mirrors byte-for-byte (UNCHANGED)
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts      # NEW — 15-case matrix
  - docs/materialized-views.md                                      # NEW § "Parent-side referential enforcement (M as an FK target)"; updated out-of-scope note
  - docs/incremental-maintenance.md                                 # write-through ordering note
  - tickets/backlog/maintained-parent-fk-reverse-index.md           # parked perf optimization
difficulty: medium
----

# Parent-side referential enforcement for maintained-table maintenance writes — REVIEW

## What landed

A maintained table `M` can be the **parent** (FK target) of an FK declared on an ordinary
table `C` (`create table C (… references M(col) …)`). Previously, when a source write drove
maintenance to **delete** or **key-update** the referenced `M` row, the backing delta was
applied straight to `M`'s transactional layer with **no parent-side FK enforcement** — silently
orphaning `C` and bypassing the declared RESTRICT / referential action.

This wires the **existing, already-shared** parent-side referential-action engine
(`runtime/foreign-key-actions.ts`) into the maintenance write path as a **third entry point**
(the DML executor and `database-external-changes.ts` are the other two). **No engine changes.**

### Implementation (the whole diff in `database-materialized-views.ts`)

- New private method `MaterializedViewManager.enforceParentSideReferentialActions(plan, changes)`:
  - cheap `foreign_keys`-pragma early-return (engine also early-returns; this skips the
    `getTable` + loop entirely when the pragma is off);
  - resolves `parent = getTable(plan.backingSchema, plan.backingTableName)` — the **same**
    object `validateDerivedChanges` resolves; `.name` equals `M`'s, so an FK on `C`
    (`references M`) matches the engine's referencing-FK scan;
  - per `BackingRowChange`: skip `insert`; for `delete`/`update` run
    `assertTransitiveRestrictsForParentMutation` (RESTRICT walk) **then**
    `executeForeignKeyActionsAndLens` (CASCADE / SET NULL / SET DEFAULT), `lensRouted = false`,
    RESTRICT walked POST-application — **byte-for-byte the `database-external-changes.ts` call
    shape** (the two non-executor callers must not drift).
- Called at **both** backing-write sites, after `validateDerivedChanges`, before the
  MV-over-MV cascade / leaf fast-path:
  - `maintainRowTime` (bounded-delta arms) — fires whether or not `M` has MV consumers;
  - `flushDeferredRebuilds` (full-rebuild floor) — inside the statement-atomicity savepoint,
    so a RESTRICT failure / cascade error unwinds the whole statement at the flush boundary.
- Import of the two engine functions; that is the only other source change.

Because the hook operates on the `BackingRowChange[]` that `applyMaintenancePlan` /
`applyFullRebuild` return, it is **arm-agnostic** — it enforces uniformly across all five
maintenance arms without per-arm code.

## How to validate

`yarn workspace @quereus/quereus test` — green (6057 passing, 0 failing). Lint clean.
New spec: `test/runtime/maintained-parent-fk.spec.ts` (15 cases). Targeted run:

```
yarn workspace @quereus/quereus run test:single packages/quereus/test/runtime/maintained-parent-fk.spec.ts
```

### Use cases covered by the new spec

- **Inverse-projection arm** (`select id, v from src`): RESTRICT blocks + rolls back the
  source write (error names `M`: `DELETE on 'm' violates RESTRICT from 'c'`); CASCADE removes
  children; SET NULL nulls the FK column; SET DEFAULT resets to the column default (pointed at
  a surviving parent row); **ON UPDATE CASCADE** key-update via a referenced **non-PK UNIQUE**
  column (the only shape where maintenance reports a single backing `update` rather than
  delete+insert — see "Subtleties" below); **ON UPDATE RESTRICT** key-update blocked.
- **Full-rebuild floor arm** (multi-source non-join body, white-box-asserted `'full-rebuild'`):
  RESTRICT fails the statement at the flush boundary; CASCADE removes children at flush.
- **MV-over-MV intermediate parent** (src → m1 → m2, FK references the middle m1): RESTRICT on
  m1 blocks a root source write; CASCADE on m1 fires while the chain still converges m2.
- **Converging feedback loop** (`M` parent of `C`, `C` a source of `M`, FK added via
  `alter table … add constraint … on delete cascade` to break the create cycle): a maintenance
  delete cascades into the source and re-drives maintenance, terminating with a clean empty
  terminal state (not a backstop error).
- **Negatives**: `pragma foreign_keys = off` ⇒ no enforcement (child left orphaned, as a plain
  delete would); NULL referenced value ⇒ no spurious action (MATCH SIMPLE); equal-image
  maintenance update (touching only an unprojected column) ⇒ no backing delta ⇒ no enforcement.
- **Both child and parent**: an `M` that declares its own child-side FK *and* is referenced by
  `C` — validates its new image (child-side) AND enforces parent-side actions on its removed
  image, independently.

## Subtleties worth a reviewer's eye

- **Key-move decomposition.** When the referenced column **is** `M`'s backing PK, a maintenance
  key-update decomposes into `delete(old)` + `insert(new)` at the backing level (see
  `applyInverseProjection`), so parent-side enforcement sees a **delete** (fires ON DELETE),
  not an update. ON UPDATE actions only fire when the referenced column is a **non-PK** column
  that moves at an unchanged backing key (single `update` change). The spec's ON UPDATE cases
  deliberately reference a non-PK UNIQUE column for this reason. This matches an ordinary
  `update M set <pk> = …` (also a delete+insert under key-based addressing) — but a reviewer
  should confirm this is the intended/desired semantics for the PK-move case, since it means an
  `on update cascade` FK referencing `M`'s **PK** would observe a delete (and thus an
  `on delete` action / RESTRICT) rather than a cascade-of-the-new-key. Not exercised by a test.
- **Ordering / RESTRICT-post-application.** The backing delta is already in the pending layer
  when enforce runs; the RESTRICT walk keys off the child rows (still present, cascade not yet
  run). Identical to the external-changes seam. Verify the parent-side subtree and the
  MV-over-MV cascade subtree are genuinely orthogonal (each MV level enforces its own
  table-as-parent during its own recursion — no double-fire).

## Honest gaps (treat tests as a floor)

- **Arms not directly tested as a parent**: only `inverse-projection` and `full-rebuild` are
  exercised as FK parents. `residual-recompute` (aggregate), `prefix-delete` (lateral-TVF), and
  `join-residual` (1:1 join) are covered **only structurally** (the hook is arm-agnostic, after
  `applyMaintenancePlan`). A test where an aggregate/join-residual `M`'s maintenance empties a
  group/row that a child references would close this. Low risk (same code path), but untested.
- **PK-move ON UPDATE** (above) is reasoned-about, not tested.
- **Cross-schema FK** (an FK in schema `s2` referencing `M` in `main`) is not exercised here;
  the engine handles `fk.referencedSchema`, but no maintenance-path test pins it.
- **`yarn test:store` NOT run** — memory backend only. SET DEFAULT carries the engine's
  documented rowid-chained-backend caveat; the store path may differ for SET DEFAULT (and for
  the residual arms' live re-reads). Worth a store-backend pass on at least the RESTRICT /
  CASCADE / SET DEFAULT cases.
- **Deep cascade chains / cascade-error-mid-flush** rely on the engine's existing
  `visited`-set + `assertCascadeDepth` / `assertFlushRounds` backstops; only the simple
  converging loop is tested, not a pathological structural cycle (which should fire the
  backstop). No adversarial cycle test added.
- **Perf**: the per-change enforcement does an `O(catalog)` referencing-FK scan even when
  nothing references `M` (parity with `delete from M`, but pure waste on bulk maintenance over
  an unreferenced parent). Parked as `tickets/backlog/maintained-parent-fk-reverse-index.md`.
