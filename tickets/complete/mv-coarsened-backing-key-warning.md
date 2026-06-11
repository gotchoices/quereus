description: Complete — coarsened backing key + key-coarsening warning for materialized views (reviewed; ORDER BY key-widening hole found and fixed)
files:
  - packages/quereus/src/planner/analysis/coarsened-key.ts
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/runtime/emit/materialized-view.ts
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/src/planner/analysis/coverage-prover.ts
  - packages/quereus/src/planner/analysis/scalar-invertibility.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/test/coarsened-backing-key.spec.ts
  - packages/quereus/test/logic/51.5-materialized-views-coarsened-key.sqllogic
  - docs/materialized-views.md
  - docs/migration.md
----

# Coarsened backing key + key-coarsening warning — complete

The collation-weakening parallel-migration MV shape (`select handle collate
nocase as handle, email from Contact_v1` over a BINARY-keyed source) now
creates instead of bag-rejecting: when `keysOf` is empty,
`deriveCoarsenedBackingKey` (`planner/analysis/coarsened-key.ts`) recognizes a
row-preserving single-source chain whose source PK survives through
value-preserving passthrough lineage (bare column / `collate` / no-op `cast`)
and keys the backing on the coarsened lineage key K' under the **output**
collations. Contract: create-fill and REFRESH are loud on collisions ("must be
a set"); steady-state row-time maintenance merges colliding source rows
last-writer-wins; a coarsening K' emits the key-coarsening warning
(`runtime:emit:materialized-view:warn`) and stamps
`MaterializedViewSchema.coarsenedKey` (informational, recomputed on
create/import/refresh shape-rebuild, never serialized). The coverage prover
gained an explicit `collation-mismatch` gate on UC + PK projection coverage.
See docs/materialized-views.md § Coarsened backing keys and docs/migration.md
§ Convergence hazards.

## Review findings

Review read the implement diff first (`c2f2ced8`), then the handoff; the
implementer's flagged-attention areas were each chased to ground.

### Found and fixed in this pass

- **ORDER BY coarsened body silently widened the key (correctness hole, fixed).**
  `computeBackingPrimaryKey` leads the physical backing PK with the body's
  `order by` columns. For a *coarsening* lineage key that widened uniqueness
  past K': reproduced `create materialized view … order by email` over
  colliding seed (`'Bob'`,`'bob'`) creating **silently** — backing PK was
  `(email BINARY, handle NOCASE)`, both siblings coexisted, the `coarsenedKey`
  stamp claimed a merged identity that did not hold, and neither the loud fill
  nor the LWW merge applied. Fix: `deriveBackingShapeUnguarded` suppresses the
  ordering seed when the lineage key coarsens, so the physical PK is exactly
  K' (the only cost is the clustering optimization; `mv.ordering` is
  informational — verified no read-path consumer). A non-coarsening lineage
  key keeps the seed (true key ⇒ the seed stays uniqueness-preserving, as for
  `keysOf`-proved keys). Pinned in the spec (loud fill + K'-only PK + LWW under
  ORDER BY; seed retained for the refining case) and cross-module in sqllogic
  § 8; documented in § Coarsened backing keys.
- **Covering-output preference (minor, fixed).** `CollateNode` is
  unconditionally non-injective, so a body projecting the same PK column twice
  under different wrappers (`h collate nocase as h1, h collate binary as h2`)
  is keysOf-empty, and the derivation's first-covering-output pick chose the
  *coarsening* h1 — LWW semantics + spurious warning where h2 is a true key.
  Now a non-coarsening covering output is preferred (ties break to the first,
  for determinism); pinned by a spec test and noted in the doc.

### Checked, no issues

- **Chain-walk allowlist soundness** (the implementer's top checklist item):
  every `ROW_PRESERVING_CHAIN` member (Project/Filter/Sort/Retrieve/Alias/
  AssertedKeys/physical access nodes) maps a source row to ≤1 output row; the
  list matches the coverage prover's established `PASS_THROUGH` vocabulary plus
  Filter; row caps, joins, set ops, aggregates, DISTINCT, window, TVFs all
  abstain (positive allowlist + single-relation check). Subquery-bearing
  Project/Filter either abstain on `getRelations().length !== 1` or fail the
  per-column ColumnReference trace — conservative either way.
- **Inverse-projection LWW delete path / BackingRowChange consumers** (second
  checklist item): the memory host reports *effective* changes — a colliding
  upsert reports `update {oldRow: sibling image}`, a delete-of-shared-key
  reports the actual row deleted — so cascade and change-log consumers see
  backing-level truth; merge-shaped updates need no special handling.
  `lookupCoveringConflicts` cannot be reached by a coarsened MV (covering
  linkage requires `proveCoverage`, which the fresh-attribute-id projection
  map *and* the new collation gate both fail), and candidates are re-validated
  under the source collation in both memory and store enforcement paths.
- **Prover collation gate collation sources**: `UniqueConstraintSchema.columns`
  is bare indices (enforcement collation = column collation), and
  `PrimaryKeyColumnDefinition.collation` is always copied from the column at
  construction and kept aligned by `ALTER COLUMN … SET COLLATE` (memory
  manager propagates into pkDef + index columns and re-keys strictly), so the
  gate's column-collation read is equivalent to the PK's effective collation.
  Exact-equality (not fineness-ordering) is correct here: a *finer* backing
  also cannot answer a coarser constraint's uniqueness question.
- **Passthrough-widening blast radius** (`resolveValuePreservingSourceCol`
  replacing the single-hop `resolveSourceCol` for ALL MV bodies): the wrappers
  copy the source value verbatim, so maintenance column-copies are exact; the
  lateral-TVF and join-residual arms still use the non-value-preserving
  `resolveTransitiveSourceCol` (prefix-scan collation invariant untouched);
  full equivalence/property suites pass.
- **deriveBackingShape / buildFullRebuildPlan agreement**: both call the same
  pure derivation over the same fully-optimized body; the floor uses the
  registered backing's PK for the replace-all diff, so re-plan divergence
  cannot mis-key. Refresh fast-path + adopt-gate parity covered by the
  round-trip test; `backingShapeMatches` compares the physical PK including
  collation, so the ordering-seed suppression is deterministic across re-plans.
- **ALTER SET COLLATE / rename interactions**: source collation changes mark
  dependents stale → refresh re-derives + restamps; rename propagation carries
  a stale stamp (cosmetic, documented on the field).
- Build clean, lint clean, full workspace `yarn test` green (5818 passing in
  quereus, +3 new regression tests), targeted store-mode run of the coarsened
  spec + sqllogic file green.

### Accepted as-is (with reasons)

- **REFRESH loud during a collision window** — confirmed as the right posture:
  refresh is a re-fill, and the migration doc's at-deploy contract is "loud on
  data that already collides"; a silently-merging refresh would hide exactly
  the state the developer must resolve. Pinned by sqllogic.
- **Warning rides the debug logger only** — the record stamp is the
  programmatic surface; SQL-level/tooling surfacing (introspection TVF column,
  declarative deploy report, refresh/adopt warning parity) is a real gap but a
  feature of its own → filed `backlog/mv-coarsened-key-introspection`.
- **Value-identical source edit does not re-assert a sibling's image** — the
  equal-image short-circuit (and the host's normative value-identical upsert
  skip) means a no-op edit of a colliding sibling leaves the other sibling's
  image in place. Consistent with the system-wide effective-change contract
  (a no-op write is not an "edit"); the documented recovery paths (real edit,
  REFRESH) are unaffected.
- **Conservative coarsening classification for custom collations** (a
  genuinely-finer custom collation would warn spuriously) — no such built-in
  exists; warn-not-reject makes a false positive harmless.
- **Collated GROUP BY keys still bag-reject** — correct here (grouping
  collapses rows ⇒ lineage key would be a false identity); the real fix is the
  pre-existing `collated-groupby-key-completeness` backlog ticket.
- **No direct test that the canonical shape registers on the inverse-projection
  arm vs the floor** — behavior (LWW, delete anomaly, recovery) is pinned
  identically for both arms by the spec + sqllogic, and the arm choice is a
  cost/maintenance-strategy concern, not a contract.

### New tickets

- `backlog/mv-coarsened-key-introspection` — SQL/tooling surface for the
  coarsened-key stamp (see above). Runtime collision telemetry remains
  separately tracked (`mv-collation-collision-telemetry`).
