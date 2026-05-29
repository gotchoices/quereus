description: A duplicate-producing ("bag") materialized-view body now fails create/refresh with a purpose-built "must be a set" diagnostic that names the view and explains the v1 set-semantics contract, instead of leaking the hidden backing table via the raw `UNIQUE constraint failed: _mv_<name> PK`. Decision: option 1 (clear diagnostic + documented contract); no silent de-dup, no synthetic identity.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/materialized-views.md
----

## What shipped

A v1 materialized view is a **keyed derived relation**: its body must produce a
**set** under the backing-table key. The implementation added a caller-supplied
duplicate-key error factory to `MemoryTableManager.replaceBaseLayer`
(`onDuplicateKey?: () => QuereusError`) — the manager keeps its exact
collation/desc/composite-correct duplicate detection and stays generic; the MV
layer owns the user-facing wording via `materializedViewNotASetError(schema,
view)` (a `StatusCode.CONSTRAINT` error, so create's all-or-nothing rollback and
refresh semantics are unchanged).

Wired into the two full-rebuild fill paths:
- **create** — `emitCreateMaterializedView` (rolls the backing table back on a
  bag body so the MV is never half-registered).
- **manual refresh** + **incremental global/cost-fallback rebuild** —
  `rebuildBacking` → `replaceBaseLayer`.

`insertRow` (alter-table rekey path) and the `concurrent-scan.spec.ts` caller
(disjoint rows) intentionally keep the generic message.

## Validation

- Build clean; lint clean.
- Full quereus suite: **3785 passing, 9 pending**.
- `51-materialized-views.sqllogic` §9: bag-at-create fails, name freed on
  rollback, late-duplicate-at-refresh fails — all `must be a set`.
- `materialized-view-diagnostics.spec.ts`: the negative assertion (message
  contains `must be a set` + view name, does **not** contain `_mv_` / `PK.`)
  plus API-level rollback re-proof.

## Review findings

**Diff reviewed first, fresh, before the handoff.** Aspect angles checked: SPP,
DRY, modularity, error handling, type safety, resource cleanup, test coverage
(happy/edge/error/regression/interaction), and docs accuracy.

### Verified sound (no action)

- **Wiring is complete.** Enumerated every `replaceBaseLayer` caller
  (`find_references`): create + `rebuildBacking` pass the factory;
  `concurrent-scan.spec.ts` and `insertRow` correctly omit it. `insertRow` is
  the alter-table rekey copy path (`alter-table.ts`), not an MV fill — leaving
  it untouched is correct.
- **Error propagation / rollback.** Create's `catch` drops the backing table and
  re-throws the factory error unwrapped; refresh propagates it with no masking
  `catch`. `replaceBaseLayer` throws before the `this.baseLayer = newBase` swap,
  so a failed refresh leaves the old contents intact (atomic). The "name freed
  on rollback" behavior is proven at both the sqllogic and API level.
- **Type safety / imports.** `QuereusError`/`StatusCode` imported in helpers;
  factory typed `() => QuereusError`. Clean.
- **sqllogic harness semantics confirmed.** `-- error:` does case-insensitive
  *substring* matching against the immediately-preceding statement
  (`logic.spec.ts` `executeExpectingError`), so `-- error: must be a set` is a
  valid positive assertion. The negative ("does not name the backing table")
  assertion genuinely can't be expressed in sqllogic, so the focused spec is the
  right home — placement accepted.
- **Docs ↔ message in sync.** The quoted message in `docs/materialized-views.md`
  matches `materializedViewNotASetError` verbatim. No stale
  `materialized-view-bag-body-duplicates` slug references remain; the residual
  `UNIQUE constraint failed` mentions in the doc are intentional (old-vs-new
  contrast) and the `errors.md` ones are about regular tables.
- **Code quality.** Minimal, DRY (single factory shared by both paths),
  well-documented. The raw-message duplication between `insertRow` and
  `replaceBaseLayer`'s default branch is pre-existing and out of scope. No inline
  code fixes needed.

### MAJOR — filed `materialized-view-incremental-bag-silent-dedup` (fix/)

The handoff asserted "bag bodies are incremental-ineligible, so [the incremental]
path should not see one." **This is false**, and the docs shipped with that
claim. Confirmed by reproduction:

- `MaterializedViewManager.compile()` decides incremental eligibility from the
  **source's** PK, not the MV's output key. A row-preserving projection that
  drops the source key (`select status from orders`, source PK `id`, MV key
  `{status}`) is incremental-**eligible**.
- If such a body is duplicate-free at create (so the create-time
  `replaceBaseLayer` passes) and a later source insert introduces a duplicate,
  the per-binding `upsert` in `applyMaintenance` **silently collapses** the
  colliding rows to the MV key — it does **not** raise `must be a set`. So the
  full-rebuild path enforces "no silent de-dup" loudly while the per-binding
  incremental path silently de-duplicates: an inconsistency that directly
  contradicts this ticket's explicit decision.
- Probed delete behavior too: deleting one of two source rows mapping to the same
  MV key did **not** phantom-delete the survivor — so this is silent
  de-duplication, not data corruption. Severity is "contract/docs violation +
  path inconsistency," not "corruption."

Filed as a fix ticket with the full reproduction and two resolution options
(prefer: reject bag-capable bodies at incremental-registration via the
effective-key prover, matching create/refresh). The resolution may warrant a
design note since the bag-body decision was explicit.

### MINOR — fixed inline (docs)

Corrected `docs/materialized-views.md` where it overstated the contract in light
of the above:
- Incremental **Limitations** "Keyless / bag bodies" bullet — rewritten from the
  false "incremental-ineligible" claim to accurately describe per-binding
  eligibility and the silent-dedup gap, pointing to the new ticket.
- PK-inference "does not silently de-duplicate" sentence — scoped to the
  create/refresh full-rebuild path, with a cross-reference to the incremental
  exception.
- Roadmap "Bag-body contract — delivered" entry — same scoping + ticket pointer.

### Coverage notes (accepted as-is)

- Path 3 (incremental global rebuild) with a bag body remains untested by design
  (it inherits the message structurally); the genuinely interesting incremental
  case is the per-binding silent-dedup above, now tracked.
- First-collision-only reporting and the un-asserted tail of the message wording
  are unchanged-from-before and acceptable.
