description: `new.<column>` DEFAULT extended to the shared-key view-write envelope (anchor key + member defaults) and to ALTER COLUMN SET DEFAULT. ADD COLUMN was split to the follow-up `add-column-new-ref-backfill`. Reviewed and accepted; no blocking findings.
files: packages/quereus/src/planner/building/default-scope.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/46-mutation-context.sqllogic, docs/sql.md, docs/runtime.md, docs/view-updateability.md
----

## What landed

Extended the `new.<column>` DEFAULT surface from single-source INSERT + CREATE TABLE to two
of the three remaining default paths:

- **Shared row-scoped default scope** — new `planner/building/default-scope.ts`
  `buildRowDefaultScope(...)`, registering supplied columns as `new.<col>` (+ bare, skipping
  bare when a mutation-context var shadows). The single-source INSERT path
  (`createRowExpansionProjection`) was refactored onto it (no behavior change).
- **Shared-key view-write envelope** — `buildKeyDefault` now builds the anchor key default
  against a row scope exposing supplied view columns as `new.<col>`; it mints **fresh**
  attributes and returns a `RowDescriptor` the emitter installs as a per-row row slot over each
  source row (before `__shared_key` is appended). Member-table defaults were already free (each
  member insert re-plans through `createRowExpansionProjection`).
- **ALTER COLUMN SET DEFAULT** — `SchemaManager.validateDefaultDeterminism` refactored into
  `validateOneDefault` + `makeDdlValidationContext`; new public `validateAlterColumnDefault`
  routes a SET DEFAULT through the identical CREATE-TABLE checks (bind params / bare columns /
  non-determinism rejected at ALTER time; `new.<col>` accepted, build deferred to INSERT). DROP
  DEFAULT skips validation. Wired into `runAlterColumn` **before** the module mutation (so a
  rejection never leaves partial state).
- **Docs** — `docs/sql.md`, `docs/runtime.md`, `docs/view-updateability.md` updated.

**Deliberate split:** ALTER TABLE ADD COLUMN was carved into `implement/9-add-column-new-ref-backfill`
(prereq on this slug). `runAddColumn` is unchanged here (still rejects non-literal defaults), so all
pre-existing ADD COLUMN tests pass untouched.

## Review findings

### What was checked
- **Implement diff** read first, fresh, before the handoff (commit `201d658a`): all 13 changed
  source/test/doc files, plus the files it *should* have touched (`runAddColumn`, the runtime row-slot
  / `createRowSlot` mechanism, the determinism validator, `ViewMutationNode` child plumbing,
  `buildEnvelopeSource`).
- **Correctness of the fresh-attr row-slot mechanism.** Confirmed the source row the emitter
  `slot.set()`s has exactly `suppliedColumns.length` columns (`assertSourceArity`), and the
  `keyDefaultRowDescriptor` maps each fresh attr id → its `suppliedColumns` position — so
  `resolveAttribute(row[columnIndex])` is in-bounds and positionally aligned. The key default is
  minted **before** `[...row, minted]`, so the slot exposes the pre-append row. Fresh attr ids are
  globally unique (`nextAttrId`), so no collision with the subquery's own scan slots inside the same
  key default (hence no `reactivate()` needed). `keySlot.close()` in `finally` — clean teardown.
- **Optimizer stability** (the handoff's main flagged risk). `keyDefault` is exposed via
  `getChildren()` (so rules may recurse into its subquery) but excluded from `getRelations()` (so the
  attribute-provenance walk never tries to find a producing relation for its `new.<col>` refs — the
  same externally-provided-context pattern mutation-context / `__vmupd_keys` use). `withChildren`
  round-trips `keyDefault` and preserves `keyDefaultRowDescriptor`. Verified end-to-end through the
  full optimize→emit→execute pipeline by the new `93.4` block (j), which includes an (uncorrelated)
  subquery sibling in the key default.
- **Validation ordering at ALTER** — `validateAlterColumnDefault` runs before `module.alterTable`, so
  a rejection leaves the catalog untouched. DROP DEFAULT (`setDefault === null`) correctly skips.
- **ADD COLUMN boundary** — `runAddColumn` still rejects any non-`tryFoldLiteral` default; the split
  is clean and atomic.
- **Docs** — read all three doc diffs against the new reality; accurate (the runtime.md
  "ALTER paths don't route through validators" note correctly flipped for SET DEFAULT, still-pending
  for ADD COLUMN).
- **Tests** — `yarn workspace @quereus/quereus lint` clean; full suite **4652 passing, 0 failing, 9
  pending**; the three touched logic files pass under a targeted `test-runner.mjs --grep` run. Verified
  the `-- error:` sqllogic directive genuinely substring-matches the raised error
  (`logic.spec.ts:601`), so the negative cases (`isn't a column`, `bare column`, `non-deterministic`)
  are real assertions, not silent no-ops.

### Bugs found
None. No correctness, resource-cleanup, type-safety, or regression defect surfaced. No inline fixes
were required and no new fix/plan ticket is warranted (the one major slice — ADD COLUMN backfill — was
already split during implement into `9-add-column-new-ref-backfill`).

### Minor observations (documented, not fixed — by-design / pre-existing / cosmetic)
- **Unconditional row descriptor + per-envelope row slot even when the key default has no
  `new.<col>`.** `buildKeyDefault` always mints `suppliedColumns.length` fresh attrs and a
  `RowDescriptor`, and the emitter always installs a row slot when a key default is present — dead
  machinery for the common surrogate-key case (`uuid7()`, `max()+ordinal`). Cost is one `Map.set`/
  `close` per envelope plus a per-row field write; the refs are never read, the attr ids never
  collide. **Not fixed:** suppressing it would require an attr-reference walk of the built node for
  negligible gain and non-trivial added complexity in a review pass — net risk > benefit.
- **CREATE-vs-ALTER determinism divergence for a self-referencing-subquery SET DEFAULT.** At CREATE
  the table isn't registered yet so the build fails → deferred → determinism *not* checked; at ALTER
  the table exists so it builds → `checkDeterministic` runs. The two only diverge if the subquery is
  *non-deterministic* (exotic). Documented as a known gap; acceptable.
- **Cross-member `new.<col>` in a member default** (reading a sibling owned by a *different* member of
  the decomposition) won't resolve — a member default only sees its own member's supplied columns via
  its envelope projection. A genuine semantic boundary, arguably correct, untested. A future doc
  clarification, not a bug.
- **Exotic/correlated key-default shapes** (e.g. a subquery correlating on `new.<col>`) are untested;
  the common uncorrelated-subquery + arithmetic shape is verified. Residual risk noted, not blocking.
- **Pre-existing** `view-updateability.md` wording "(or already-defaulted) siblings are visible"
  slightly overstates visibility vs the supplied-only reality. In unchanged doc text — out of scope
  here.

### Follow-up
- `implement/9-add-column-new-ref-backfill` (already filed during implement) carries the remaining
  ADD COLUMN slice: allow + validate + store + per-row backfill via a new module seam. Reviewed its
  spec — coherent, correct prereq (`default-new-ref-envelope-and-alter`, sequence 9 ≥ 8), reuses
  `buildRowDefaultScope` / `validateAlterColumnDefault`.

## Validation

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 4652 passing, 0 failing, 9 pending.
- Targeted: `node test-runner.mjs --grep "File: (03.4-defaults|93.4-view-mutation|46-mutation-context)\.sqllogic"` — 3 passing.
