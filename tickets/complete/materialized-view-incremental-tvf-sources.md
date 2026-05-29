description: Maintain `on-commit-incremental` materialized views whose body fans a base row out through a *lateral table-valued function* (`base t cross join lateral json_each(t.arr) je`) incrementally via a base-PK **prefix delete** (`delete-by-prefix`) + re-insert, gated on prefix isolation + the TVF's `relationalAdvertisement` proving the fan-out is a set on the backing PK. Where unprovable, classify to a full rebuild — never a wrong result.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/materialized-view-lateral-tvf.spec.ts, docs/materialized-views.md, docs/incremental-maintenance.md, docs/optimizer.md
----

> **⚠ Superseded (2026-05-29) — feature removed.** Materialized views are being consolidated to a single **row-time** model by `materialized-view-rowtime-only-consolidation` (plan): the `manual` and `on-commit-incremental` refresh policies and the post-commit divergence / self-heal subsystem are removed. The work archived here is retained as historical record only.

## What landed

A lateral-TVF fan-out body maintains **incrementally** via a bounded base-PK
prefix delete + re-insert instead of a full rebuild on every source change.
Correctness rests on two compile-time facts (prefix isolation + fan-out
set-ness); if either is unprovable the body keeps the always-correct
full-rebuild fallback. See the upstream implement handoff for the design; this
ticket is the review record.

Implementation summary (verified against the diff in commit `3aa92526`, which —
note — was authored under the message `ticket(plan): materialized-view-rowtime-write-through`
because the implement work for this slug was bundled into that commit):

- **`delete-by-prefix` maintenance op** (`vtab/memory/layer/manager.ts`): new
  `MaintenanceOp` variant + private `deleteByPrefix(prefix, prefixLength)` that
  seeks the primary btree to the prefix and forward-scans the contiguous run.
- **compile() detection + gate** (`core/database-materialized-views.ts`):
  `detectLateralTvf`, `computePrefixDeleteOrder` (fact 1), and
  `tvfBackingPortionIsSuperkey` (fact 2 — consumes `relationalAdvertisement`'s
  `keys`/`isSet`). `ResidualArtifacts.prefixDelete`; `apply()` emits
  `delete-by-prefix` + upserts; cascade producers mark the backing globally
  changed (dependents rebuild).
- **`ast-stringify.ts`**: emits `LATERAL` so MV bodies round-trip (hard
  prerequisite — without it the re-parsed body cannot resolve the correlation).
- Tests in `52-materialized-views-incremental.sqllogic` §32–36 and
  `materialized-view-lateral-tvf.spec.ts`; docs updated across three files.

## Review findings

Adversarial pass over the implement diff (read first, before the handoff) from
every aspect angle. Verdict: **sound and correct**; one performance/robustness
issue fixed inline, the rest confirmed or documented as acceptable.

### Checked — correctness / soundness (no defect)
- **`delete-by-prefix` seek positioning.** Confirmed against the composite-key
  comparator (`vtab/memory/utils/primary-key.ts`): the length-diff branch
  (`return arrA.length - arrB.length`) sorts a shorter probe strictly *before*
  all full keys sharing its prefix, with **no** non-matching keys between the
  seek crack and the run's start. So the matching rows are exactly the
  contiguous block beginning at the seek position. This is the same property
  `scanLayer`'s prefix-range scan relies on.
- **`prefixDelete` ⇒ `deleteKeyOrder === null` invariant.** The gate requires
  the backing PK to end with ≥1 TVF column (`baseKeyOrder.length ===
  physicalPkOutCols.length ⇒ null`), and a TVF column has no base provenance, so
  `computeDeleteKeyOrder` necessarily returns `null` whenever `prefixDelete` is
  set. The `apply()` per-tuple loop takes the `prefixDelete` branch first, so the
  `deleteKeyOrder!` non-null assertion in the `else` is never reached even in the
  degenerate both-set case. No latent crash.
- **Set-ness gate ignoring non-base/non-TVF backing-PK columns is sound.**
  `tvfBackingPortionIsSuperkey` collects only PK columns that resolve to a TVF
  output column; a constant/expression column after the prefix is ignored.
  Checking a *subset* of the backing PK's discriminating columns for the superkey
  property is conservative — if the subset is already a superkey, the full PK
  (superset) is too. Cannot produce a false "is a set".
- **`MaintenanceOp.kind` exhaustiveness.** All three switch/branch sites handle
  `delete-by-prefix`: `applyMaintenance` (implements it), `applyMaintenanceToLayer`
  (deliberate `INTERNAL` throw — row-time covering structures are 1:1 and can
  never be a lateral-TVF body, so unreachable), and the capture loop in
  `applyMaintenanceAndCapture` (handled before the loop; `continue` inside). No
  missing-case bug.
- **`detectLateralTvf` gating** (single TVF, operands correlate *only* to base,
  non-correlated/constant TVF rejected) and the `tableRefByRelKey.size === 1`
  precondition (a TVF is a `TableFunctionCallNode`, not a `TableReferenceNode`,
  so it never inflates the source count) — both correct.
- **Advertisement honesty.** `json_each` advertises `keys: [[{index:4}]]`
  (the unique element `id`) and `isSet: true` — honest; the sqllogic §32/§36
  tests' reliance on the `id`-key route is sound. The `split_parts` spec test
  exercises the `isSet`-only route. Trusting the advertisement is the documented
  soundness hinge and matches the rest of the optimizer.
- **`astToString` LATERAL change** — independently read; placement
  (`<join> join lateral <right>`) is correct SQL, and the wider blast radius
  (every lateral-join round-trip, incl. asof-scan lateral) is covered by the
  full suite passing.

### Found + fixed inline (minor)
- **`deleteByPrefix` scanned to the end of the tree on an empty match run.** The
  original `entered`-flag loop only broke *after* entering the matching run, so a
  prefix that matches nothing — which happens on **every INSERT of a new base
  row** (the fan-out doesn't exist yet but the op still fires) and any
  no-prior-fan-out case — forward-scanned from the seek position to the end of
  the backing tree (O(rows-after-insertion-point), i.e. O(n²) for a mid-range
  bulk insert). Since the seek lands exactly at the run's lower boundary and the
  run is contiguous, the *first* mismatch ends it. Replaced the `entered` flag
  with a first-mismatch `break`, matching the `scanLayer` prefix-range pattern
  the method's own doc comment claims to mirror. Observably identical results
  (the oracle test already inserts a new base row and stayed green); strictly a
  termination/perf fix. `manager.ts:1396-1417`.

### Documented gaps — checked, judged acceptable (no new ticket)
- **Collated leading-PK seek is reasoned-correct but not directly tested.** All
  prefix tests use INTEGER base PKs. The btree comparator and the per-column
  match (`compareSqlValues(..., collation)`) both source collation from the same
  `pkDefinition`, so a NOCASE leading column orders and matches consistently and
  the run stays contiguous. Desc leading columns are gated out at compile time
  (`backingPkDefinition[j]?.desc === true ⇒ break ⇒ rebuild`), so the runtime
  only ever sees ascending prefixes — the desc-seek concern is moot by
  construction. Not a defect; a targeted collated-PK test would be a nice-to-have.
- **Cascade producer + prefix-delete is untested but always-correct by
  construction.** The `ops.some(op => op.kind === 'delete-by-prefix')` branch in
  `applyMaintenanceAndCapture` marks the backing globally changed → dependents
  full-rebuild (the most conservative correct option). The cascade machinery
  itself is well-tested elsewhere; no behavioral risk, only a coverage gap. Not
  filed.

### Out of scope (deferred, all always-correct via rebuild)
Multiple base sources each feeding TVFs; a TVF correlated to >1 source;
nested/chained TVFs; non-correlated/constant-operand TVFs; the store module
(`applyMaintenance` is memory-manager-only). The general optimizer fix
(`keysOf` surfacing the keyed cross-product key, removing the MV-local
advertisement consumption) remains filed as backlog
`optimizer-keyed-cross-product-join-keys`.

### Validation
- `yarn lint` (packages/quereus): ✓ clean (exit 0).
- Full `packages/quereus` suite via `node test-runner.mjs`: **3813 passing /
  9 pending / 0 failing** (with the inline fix applied).
- Focused: `--grep "lateral TVF fan-out"` → 3 passing; the MV/cascade/sqllogic
  grep subset → 26 passing. No pre-existing failures observed.

## Docs
`docs/materialized-views.md` (§ Incremental refresh + Apply contract + cascade
limitation), `docs/incremental-maintenance.md` (`delete-by-prefix` op + gate +
cascade capture), and `docs/optimizer.md` (advertisement consumed by MV
maintenance) were all updated by the implement stage and read as accurate; the
inline fix made the code *more* faithful to the documented "mirrors
`scanLayer`'s prefix-range early-termination" description.
