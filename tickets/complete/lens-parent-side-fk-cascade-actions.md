description: Runtime cascade walker propagating CASCADE / SET NULL / SET DEFAULT parent-side actions for a *logical* foreign key through the lens. A lens-backed logical parent delete/update cascades (deletes / nulls / defaults) the referencing logical child rows by issuing the propagating DML against the logical child *view* (so each cascade re-enters the lens write path), composing with the physical FK-action walker via structural elision. Shipped alongside a behavior-preserving extraction of shared catalog-only FK discovery into `schema/lens-fk-discovery.ts`.
files: packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/schema/lens-fk-discovery.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## What shipped

The action complement to the parent-side RESTRICT/NO-ACTION detection. A logical FK
lives only on the child slot's `enforced-fk` obligation (on no basis table), so the
physical `executeForeignKeyActions` (which scans declared `TableSchema.foreignKeys`)
never sees it. This ticket adds a **runtime cascade walker** — the logical dual of
`executeForeignKeyActions` — that issues the propagating DML against the logical child
*view* (`x.child`), re-entering the full lens write path (child's own checks, child-side
FK checks, set-level checks, and nested logical cascades all fire).

Three phases:

1. **Behavior-preserving extraction** (`schema/lens-fk-discovery.ts`, new): moved the
   catalog-only helpers (`logicalToBasisColumnMap`, `resolveLogicalReferencedColumns`,
   `pairKey`, `mappedFkBasisPairs`, `matchingBasisFks`) out of
   `planner/mutation/lens-enforcement.ts` so the runtime walker and planner collector
   share them. Added `findLogicalParentFkRefs` (cross-slot discovery) and
   `basisChildCarriesEquivalentFk` (the cascade elision predicate).
   `collectLensParentSideForeignKeyConstraints` refactored to consume
   `findLogicalParentFkRefs`.

2. **Runtime cascade walker** (`runtime/foreign-key-actions.ts`):
   `executeLensForeignKeyActions` gates on `foreign_keys`, reverse-maps the basis parent
   table → logical parent slot(s) via `resolveSlotBasisSource`, discovers referencing
   logical FKs, filters to `cascade`/`setNull`/`setDefault`, elides when the basis child
   already carries a structurally-equivalent FK, applies MATCH SIMPLE + the UPDATE
   referenced-column short-circuit, and issues the logical-child DML (`issueLensFkAction`).

3. **DML wiring** (`runtime/emit/dml-executor.ts`): a combined
   `executeForeignKeyActionsAndLens` (physical then lens) replaced all 6 bare
   `executeForeignKeyActions` call sites.

See `docs/lens.md` (Foreign key § Live (parent-side)) for the full behavioral contract.

## Review findings

Adversarial review of commit `828ddaac`. Read the full implement diff first, then the
current source, then ran lint + the full suite.

**Verdict: implementation is sound and ships as-is. One net-new design observation filed
to backlog; two tests added inline to close flagged gaps. No correctness bugs found.**

### Checked — and OK

- **Extraction is behavior-preserving (Phase 1).** Diffed the moved helpers
  byte-for-byte against their old bodies in `lens-enforcement.ts`; identical logic, only
  the home module + export visibility changed. The 74 pre-existing `lens-enforcement.spec`
  tests stay green, plus the refactored `collectLensParentSideForeignKeyConstraints`
  still passes its own suite. `isNonRowReducingProjection` / `basisFksSubsuming` correctly
  stayed in the planner (RESTRICT-side-only).
- **All 6 DML call sites swapped** (`find_references` confirms no remaining bare
  `executeForeignKeyActions` caller outside the wrapper itself, and no external-package
  caller). Primary delete/update, UPSERT-update, both REPLACE `replacedRow` deletes, and
  `processEvictions` all route through `executeForeignKeyActionsAndLens`.
- **Action gate is mutually exclusive** between the plan-time RESTRICT collector
  (`=== 'restrict'`) and the runtime walker (the three non-restrict actions) — no logical
  FK is both checked and cascaded; no double-handling.
- **Elision composes with the physical walker.** `basisChildCarriesEquivalentFk` shares
  the redundancy detector's `mappedFkBasisPairs` + `matchingBasisFks` core (minus the
  RESTRICT-only non-row-reducing gate); when the basis child carries the equivalent FK the
  physical walker propagates and the lens cascade is skipped (verified by the elision test
  asserting both the predicate `=== true` and the exactly-once end state).
- **SET DEFAULT column indexing** (`childTable.columns[ref.fk.columns[i]].defaultValue`)
  is FK-aligned and matches the physical `executeSingleFKAction`; the logical default AST
  is used (not the basis default), correct for a view-targeted write.
- **Cycle termination by data exhaustion** matches the physical SQL-issuing path —
  `executeSingleFKAction` also recurses via `_execWithinTransaction` with a fresh
  `visited` set per nested statement, so the physical walker relies on data exhaustion for
  SQL-issued cascades too. No new non-termination class introduced (mixed-cycle test pins
  one terminating shape).
- **Resource cleanup / error handling:** the walker issues parametrized DML (never
  inlined values) via `_execWithinTransaction`; a cascade-update that violates the logical
  child's own check ABORTs and rolls back the whole statement (test confirms parent +
  child both unchanged). Pragma gate (`foreign_keys = false`) leaves children orphaned, as
  intended.
- **Per-row scan cost** is O(slots × FKs) and the reverse-map + `findLogicalParentFkRefs`
  each walk all schemas' slots (an O(slots²) shape per row). Confirmed accurate; same
  order as the RESTRICT collector. Accept for v1 (documented in the implement handoff).

### Found & fixed inline (minor)

- **Flagged-untested wiring + composite path now covered.** Added 3 tests to
  `lens-enforcement.spec.ts`:
  - `insert or replace` on a lens parent cascades the displaced row's children — exercises
    the `replacedRow` delete site in `processInsertRow` (one of the 4 wired-but-untested
    sites the implementer flagged); confirms standard SQLite REPLACE-cascade semantics
    through the lens.
  - composite (multi-column) CASCADE DELETE — exercises the multi-column WHERE the
    single-column tests never hit; only the children matching the full composite key are
    removed.
  - composite CASCADE UPDATE — both child FK columns follow a composite parent re-key.
  All three pass; suite went 4312 → 4315.

### Found & filed (major / design question)

- **Cascade fires on basis-direct DML; RESTRICT does not** — filed
  `tickets/backlog/lens-parent-side-fk-cascade-on-basis-direct-write.md`. The walker keys
  on basis-table identity and fires after *any* basis write, so a basis-direct
  `delete from y.parent` (bypassing the lens) propagates the logical CASCADE — while the
  logical RESTRICT (a plan-time, lens-path-scoped check) does not reject the same
  basis-direct write. An unintentional hybrid; the consistent behavior (universal logical
  integrity vs. lens-as-contract-boundary) needs a human design decision and a doc note.
  Low severity for the intended through-the-lens path (cascade fires exactly once there).

### Not addressed (out of scope / already tracked — stated explicitly)

- **Divergent basis-vs-lens action** over equivalent columns — already filed
  (`lens-parent-side-fk-divergent-basis-action`, backlog); the action-agnostic elision
  lets the basis action govern. Consistent with this implementation; no change.
- **Two logical parents over one basis table** — untested; reverse-map fires both
  cascades. Believed correct (both lose the row). Left untested — an unusual configuration
  and writing a faithful repro requires two independent lens views sharing a basis spine;
  the existing reverse-map logic has no special-casing that would make N>1 behave
  differently from N=1, so the risk is low. Worth a follow-up test if the config becomes
  real.
- **SET DEFAULT with a NULL default through the lens** — handled identically to the
  physical walker (`= null`); left untested (same code shape as the physical path which is
  covered).
- **UPSERT-update / `processEvictions` cascade sites** — wired through the same wrapper;
  the REPLACE `replacedRow` site is now tested (above), which exercises the same
  `executeForeignKeyActionsAndLens('delete', …)` shape. The eviction/upsert sites share
  that shape and were left without a dedicated test (the wiring, not per-site logic, is
  what differs).

### Validation

- `yarn workspace @quereus/quereus run build` (tsc) → exit 0.
- `yarn eslint 'src/**/*.ts' 'test/**/*.ts'` → exit 0.
- Full suite (`node test-runner.mjs`) → **4315 passing, 9 pending, 0 failing**.
- No `.pre-existing-error.md` written — no unrelated failures encountered.
