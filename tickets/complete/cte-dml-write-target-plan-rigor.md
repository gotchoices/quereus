description: Test-only plan-rigor additions for the CTE-name / inline-subquery DML write targets — a structural plan-shape parity spec (named view ≡ CTE ≡ inline ViewMutationNode subtree, offset-canonicalized, with a self-stability completeness guard) plus extended dependency/invalidation pins (ephemeral DML records NO `view` dep but DOES depend on the real base table). Reviewed and accepted; no production code changed.
prereq:
files:
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts            # NEW — 6 tests (plan-shape parity + self-stability guard)
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts  # EXTENDED — +6 tests (ephemeral no-view-dep + base-table dep + invalidation)
  - packages/quereus/test/plan/_helpers.ts                           # serializePlanForGolden / safeJsonStringify $map surface (reused, unchanged)
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # the !view.ephemeral recordDependency skip (L58) under test (unchanged)
  - packages/quereus/src/planner/nodes/plan-node.ts                  # UpdateSite kind 'base'.table = producing node id (L283-287); the id leak the canonicalizer erases
  - packages/quereus/src/util/serialization.ts                       # Map → {$map,size} rendering the canonicalizer parses (unchanged)
  - docs/view-updateability.md                                       # §§ Update Site Model / CTE-name / Inline subquery / Round-Trip Laws — already accurate
difficulty: medium
----

# CTE-name / inline-subquery DML write target: structural plan rigor — COMPLETE

## Summary

Test-only ticket. The behavior already shipped; this closed two coverage gaps left by the
original implement+review passes (which verified only observable base-table STATE parity in
`test/logic/93.4-view-mutation.sqllogic`).

- **Phase 1** (`cte-dml-plan-shape.spec.ts`, NEW, 6 tests): pins that all three single-source
  DML write-target forms — named view, CTE name, inline subquery — lower to a structurally
  identical `ViewMutationNode` subtree over the same base table, modulo per-plan id offsets.
  Includes a write-first self-stability guard that is the completeness authority for the id
  canonicalizer, anti-vacuity, and a divergent-predicate non-equality control.
- **Phase 2** (`view-dependency-invalidation.spec.ts`, EXTENDED, +6 tests): pins that an
  ephemeral CTE/inline DML target records `[]` `view` deps but a `table` dep on the real base
  (named-view contrast control records exactly one `view` dep), and that `alter view <name>`
  does NOT invalidate a CTE-target plan while `alter table <base>` DOES — wired live through
  real schema-change events, plus a behavioral pin that the CTE shadows a later same-named view.

## Review findings

Adversarial pass over commit `39b54b7f` (the implement diff), read before the handoff. Lens
sweep: SPP / DRY / modular / scalable / maintainable / performant / resource cleanup / error
handling / type safety, plus happy-path / edge / error / regression / interaction coverage.

### What was checked

- **Implement diff read fresh**, both spec files in full, before consulting the handoff.
- **Canonicalizer completeness** (`canonicalizePlanIds`) — the load-bearing risk. Confirmed the
  self-stability guard genuinely protects it: it plans the named form at two real counter
  offsets WITHOUT `withDeterministicPlanIds`, asserts the raw snapshots differ (offset moved →
  non-vacuous) and the canonicalized snapshots match. Traced the failure mode: if either regex
  ( `$map`-key attribute ids, or numeric `"table"` node ids) failed to match a token present in
  the plan, that token would survive the offset and break the guard's `===`. The guard passing
  therefore proves the regexes cover every id-bearing token in this plan shape. The handoff's
  claim that no `ColumnReferenceNode.attributeId` survives (predicate folds into the IndexSeek
  seek key, assignment is a literal) is consistent with the guard still being load-bearing via
  the `updateLineage` `$map`.
- **Serializer surface assumptions** — verified against `src/util/serialization.ts`: a `Map`
  renders as `{$map:[[k,v]...],size}` with values bypassing `normalizeSnapshot` (the Map is
  passed through untouched), so the `base` `UpdateSite`'s insertion-order first key really is
  `"kind"` (plan-node.ts L283-287), which the `$map`-key regex `,\s*\{\s*"kind":` keys off.
  Confirmed `inverse` (a function) is dropped by `JSON.stringify`, and the numeric-vs-quoted
  `"table"` distinction (node id vs logical name) holds — the anti-vacuity test asserts the
  quoted `"table": "b"` form, the canonicalizer rewrites only the numeric form.
- **Dependency recording** — confirmed `!view.ephemeral` skip at view-mutation-builder.ts L58
  is exactly what the `[]`-view-dep / base-`table`-dep assertions exercise; the named-view
  contrast control makes the empty results non-vacuous.
- **Invalidation wiring** — confirmed the `=== p1` control precedes each `!== p1`, so a
  never-caching compile cannot pass; events fire through real `alter view … set tags`
  (`view_modified`, no-match) and `alter table … add column` (`table_*`, match). The shadowing
  follow-up (`run` then read `cte_base`) is a real behavioral pin, not identity-only.
- **Docs** — read `docs/view-updateability.md`. Every doc section the test comments cross-ref
  resolves (§ Update Site Model L38, § Common Table Expressions L668, § Inline subquery target
  L702, § Round-Trip Laws L1030). The docs already state the ephemeral no-dependency contract
  (L698) and the byte-identical single-source base-op plan parity (L707/L716). No doc drift —
  nothing to update, since no production behavior changed.
- **Test isolation** — the new Phase-1 spec deliberately omits `withDeterministicPlanIds` and
  only consumes ids monotonically via `getPlan` (never resets the static counters), so it
  cannot perturb the golden specs that reset-and-restore-to-high-water-mark. No shared-state
  regression.

### What was found

- **No correctness defects.** Both regexes, the DFS subtree extractor (cycle-guarded `seen`
  set, single `ViewMutation` so pop-order is irrelevant), the separate attribute-id / node-id
  namespaces (kept apart to avoid conflation), and the live invalidation wiring are all sound.
- **Minor / acceptable observations, not fixed (would not improve confidence materially):**
  - The divergence control (`where id = 2`) diverges only in the seek-key predicate region, not
    in the `updateLineage`/`table` region. It establishes the comparison is non-vacuous overall;
    it does not independently prove a lineage-region structural difference would surface. Left
    as-is — the parity assertion compares the whole subtree and the guard + 93.4 STATE parity
    bound the residual risk.
  - The "inline form rejects INSERT" claim is documented in a comment but not asserted by a
    parse-error test in this spec (the spec's theme is plan-shape parity, and the rejection is
    covered behaviorally elsewhere). Not worth an arm here.
  - The `$map`-key regex is tuned to the `base` `UpdateSite` shape (first key `"kind"`). This is
    documented in the spec and guarded for the `base` kind; other lineage kinds (`null-extended`,
    `computed`, `authored`, multi-source `__vmupd_keys`) are out of scope by design (join-bodied
    CTE/inline targets lower through a different substrate). A future reviewer broadening
    coverage may need to extend the regexes — and the self-stability guard would catch a residual
    leak if they don't.

### Disposition

- **Minor findings fixed inline:** none required — the three observations above are acceptable
  scoping decisions, not defects.
- **Major findings filed as new tickets:** none. The deferred coverage (multi-source CTE/inline
  plan-shape parity; non-`base` UpdateSite-kind canonicalization) is genuinely a different
  substrate and was a deliberate, documented scope boundary of a single-source rigor ticket — it
  is not a gap this change introduced, so no follow-up ticket is warranted.

### Validation performed

- `cte-dml-plan-shape.spec.ts` + `view-dependency-invalidation.spec.ts` → **25 passing** (6 + 19).
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) → **exit 0**.
- `yarn test` (full monorepo) → quereus **6231 passing, 9 pending**; all other packages green; no
  failures anywhere; no `.pre-existing-error.md` filed.

## Out of scope (correctly deferred)

- Multi-source (join-bodied) CTE/inline plan-shape parity — different substrate.
- Non-`base` `UpdateSite`-kind canonicalization (`null-extended`/`computed`/`authored`/multi-source).
- Inline-subquery INSERT (rejected at parse) — only named↔CTE INSERT parity is pinned.

## End
