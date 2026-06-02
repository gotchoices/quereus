description: Single-source view-mutation UPDATE path now consumes the threaded plan-node `inverse`, so an inverse-profile column (`b + 1 as bp`) is writable through `update` and the dynamic single-source spine matches the static `column_info`/`view_info` `is_updatable = 'YES'` and the multi-source join path. `update v set bp = 9` stores `t.b = 8`; an `opaque` column stays `no-inverse`; INSERT stays inverse-blind.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic, docs/view-updateability.md
----

## What landed

The single-source view-mutation spine consumes the threaded `inverse` on the **UPDATE
write path**, closing the static↔dynamic divergence for the `inverse` (arithmetic
`b ± k` / `k ± x`) invertibility profile:

- `analyzeView` builds an `inverseSites: Map<lowercased view-column → { baseColumn, inverse, domain? }>`
  by reading the already-planned `bodyPlan.physical.updateLineage` and resolving each
  view column's site through the shared `resolveBaseSite`. A column is recorded only when
  `site.writable && !site.nullExtended && site.inverse && site.baseColumn`.
- `rewriteViewUpdate` intercepts an inverse-column SET target before `requireBaseColumn`:
  it base-term-lowers the RHS (`substitute` + `descend`), then wraps it with
  `inv.inverse(loweredValue)` and targets `inv.baseColumn` — mirroring the multi-source
  `decomposeUpdate` (`out.inverse(baseValue)`, inverse applied after base-term substitution).
- The identity-only readers (`deriveViewColumns` / `classifyProjectionExpr` /
  `viewColumnsFromUpdateLineage` / `identityBaseColumn`) were deliberately NOT widened —
  their parity is pinned by `property.spec.ts`. INSERT still routes through the
  identity-only `viewColumns`, so an inverse column stays `computed`/non-insertable.
- Materialized-view write-through inherits this automatically (MV write-through *is* the
  single-source spine).

Behavior: `update v set bp = 9` → `set b = 9 - 1` (stores `t.b = 8`, reads back `bp = 9`);
`update v set bp = id + 100` → `set b = (id + 100) - 1`; an `opaque` column (`b * 2`,
`substr(s,1,1)`) stays `no-inverse`; INSERT of the inverse column rejects.

## Review findings

**Scope reviewed:** the full implement diff (`8eb9d915`) read first with fresh eyes — the
two source files (`single-source.ts`, `update-lineage.ts`), the invertibility registry
(`scalar-invertibility.ts`), the multi-source parity (`multi-source.ts decomposeUpdate`),
the plan-node lineage threading (`project-node.ts`, access/alias/retrieve nodes), the
static catalog surface (`func/builtins/schema.ts baseSiteOf`), and all four test files +
the doc. Probed angles: correctness of the inverse application order, RHS-referencing-self
(`bp = bp + 1` round-trips correctly), NULL handling, INSERT/DELETE/RETURNING paths,
index-alignment robustness, the duplicate-base-column corner, type safety of the cast,
DRY, and resource/perf. Lint (`eslint`) clean; full suite `yarn workspace @quereus/quereus
test` → **4410 passing, 0 failing, 9 pending**. Findings empirically confirmed with a
throwaway spec (since removed).

**Verified correct (no action):**
- Inverse application order matches multi-source (`inverse` wraps the base-term-lowered
  RHS last). `bp = id + 100` → `(id + 100) - 1`; `bp = bp + 1` lowers `bp` via `columnMap`
  to `(b+1)` then inverts → stores `b = b + 1` (correct round-trip).
- The inverse-site keys are disjoint from identity-base columns (identity → `inverse`
  undefined → not recorded; non-identity invertible → `computed` in `deriveViewColumns`),
  so no SET target is double-routed.
- Index alignment `viewColumns[i] ↔ attrs[i]` is safe: projection order = select-list
  order in both readers; an explicit `create view v(x,y)` only renames positionally; a
  misalignment degrades to a safe identity/`no-inverse` fallback, never a mis-attributed
  inverse. The implementer's suggested explicit arity assertion is a nice-to-have, not a
  bug — not added.
- INSERT inverse-blindness, the `opaque`/`no-inverse` rejection, the parity test, and the
  MV write-through re-derivation all behave as the handoff claims.
- `domain` threading is dormant (no shipped profile produces one) — correctly deferred,
  mirroring multi-source.

**MAJOR — filed as new tickets (not fixed inline; each needs its own design/tests):**

1. `fix/single-source-passthrough-column-static-dynamic-divergence` — the **same**
   static↔dynamic divergence this ticket closed for `inverse` columns is still open for
   the `passthrough` profile (`b collate nocase as bc`, no-op `cast(b as <same-type>) as
   bc`). These trace to a `base` site with `inverse === undefined`, so `baseSiteOf` reports
   `is_updatable = 'YES'` / `base_column = b`, but the single-source UPDATE rejects the
   write `no-inverse` (the `inverseSites` gate requires a truthy `inverse`; `deriveViewColumns`
   classifies the non-bare-column expr `computed`). The multi-source spine *does* route
   these writable, so single-source vs multi-source also disagree. Confirmed repro in the
   ticket. Pre-existing relative to the inverse work, but squarely the divergence class the
   parent ticket framed itself around — so "divergence closed" is less complete than it reads.

2. `fix/view-update-conflicting-base-column-assignments-silent-last-wins` — `update v set
   b = 5, bp = 100` on `select id, b, b + 1 as bp` lowers to `set b = 5, b = 99` and stores
   `b = 99` (silent last-wins; `b = 5` dropped, order-dependent). Confirmed repro. A
   pre-existing class (reachable via duplicate identity/rename projections), which the
   inverse feature widens; the implementer flagged it as an open reviewer decision. Filed
   to settle the semantics (reject vs. document) and enforce on both spines.

**MINOR (fixed inline):** none — no inline fixes were required.

**Docs:** `docs/view-updateability.md` § Scalar Invertibility ("Where inverse profiles are
consumed") and the `identityBaseColumn` doc-comment were updated by the implementer and
read accurate for the `inverse` profile as shipped. (They will need a follow-up touch when
the passthrough divergence above is closed — noted in that ticket.)
