description: Hardened two unguarded assumptions in the decomposition put fan-out's column classification — gap (a) a `no-base-lineage` reject when an identity column's lineage resolves a base column but no member backs its base relation (a lineage-resolution miss that previously degraded a writable column to read-only), and gap (b) an `unsupported-decomposition-member` reject for a self-decomposition (two members over one physical base relation, ambiguous column→member routing). Both states are unreachable through shipped advertisement shapes; the guards make the implicit dependencies explicit and are exercised by constructed reachable test vehicles.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/view-updateability.md
----

## What shipped

- `analyzeDecomposition` builds `memberByTableId` with `filter()` (was `find()`) and
  raises a new `unsupported-decomposition-member` diagnostic when >1 member resolves to
  the same base `(schema, table)` (self-decomposition). Single-source chokepoint for
  DELETE/UPDATE/INSERT (called from both `propagateDecomposition` and
  `analyzeDecompositionInsert`).
- `classifyColumn` now takes `view` (threaded through `routeInsertColumn`,
  `routeAssignment`, `assertAnchorScoped`) and raises `no-base-lineage` when an identity
  base column's lineage resolves but `memberByTableId` misses it — instead of falling
  through to the name-only `member.columns` match that silently returned read-only
  `computed-mapping`.
- New `MutationDiagnosticReason: 'unsupported-decomposition-member'`.
- 4 new tests in `describe('lens decomposition put: column-classification robustness')`.

## Review findings

Adversarial pass over commit `1d29ab89`. Read the source diff fresh before the handoff.

### Checked

- **Correctness — gap (a) guard.** Fires only when a column is an identity base column
  (`baseColumn` + `baseTableId` defined, `inverse === undefined`) AND `memberByTableId`
  misses it. A non-identity mapping never enters the gate body (it carries an `inverse`,
  or resolves to `computed` with no `baseColumn`), so the legitimate `computed-mapping`
  read-only route is untouched — confirmed by the 4 pre-existing
  `non-identity columnar mappings (computed-mapping route)` regression tests still
  passing. No false positives for normal advertisements (every member's base table-ref
  populates the map by exact schema+table). **Sound.**
- **Correctness — gap (b) guard.** Fires only when ≥2 members declare the same
  `(schema, table)`; distinct-table decompositions never collide, so no false positives.
  The guard sits on the mutation-only `analyzeDecomposition` path, so reads are
  unaffected — verified by the passing `(b) reads through the synthesized self-join`
  test. **Sound.**
- **Path coverage.** Both guards are shared chokepoints; verified `analyzeDecomposition`
  is called at both `propagateDecomposition` (DELETE/UPDATE) and
  `analyzeDecompositionInsert` (INSERT), and `classifyColumn` from all three routing
  sites. Tests exercise UPDATE only; the chokepoint argument (DELETE/INSERT raise
  through the same code) is correct, so DELETE/INSERT belt-and-suspenders cases were
  judged unnecessary — agreed, no ticket.
- **Type safety.** No `any`; `displayName`/`baseColumn`/`baseTableId` all exist on
  `BackwardColumn` (backward-body.ts). The added `view` parameter is plumbed cleanly.
- **Error handling / cleanup.** Both guards raise structured `ViewMutationError`s at
  build time (no execution, hence the atomicity assertions hold trivially); nothing is
  swallowed. SPP/DRY/modularity: small, single-purpose, well-commented additions.
- **Diagnostic reason reuse.** Gap (a) reuses `no-base-lineage` — precedent exists at
  the existing anchor-not-among-members guard (decomposition.ts:106). Gap (b) adds a new
  reason in the `unsupported-decomposition-*` family. Acceptable.
- **Tests + lint + typecheck.** `lint` clean, `typecheck` clean, full
  `@quereus/quereus` suite **4415 passing, 9 pending, 0 failing** (matches handoff); the
  spec file is 38 passing.

### Found and fixed (minor, inline)

- **Doc enumeration was stale.** The handoff stated the decomposition diagnostics "are
  not enumerated in a canonical docs table." Inaccurate: `docs/view-updateability.md`
  line 1081 is the canonical architectural enumeration of decomposition diagnostics
  (`unsupported-decomposition-predicate`/`-update`/`-key`, `no-default`), and it omitted
  the two new guards. Added a "robustness guards" clause there naming
  `unsupported-decomposition-member` and the gap-(a) `no-base-lineage` reject. (The
  property-test narrative at lines 1226-1227 was correctly left untouched — those guards
  do not belong to the `quereus.lens.decomp.*` tag family.)

### Reviewed, no action (with reasons)

- **Gap (a) test-vehicle coupling (the handoff's flagged judgment call).** The
  empty-`relation.schema` vehicle reaches the guard via the build loop's exact
  `(schema, table)` match while other consumers apply a `|| basis.schemaName` fallback.
  The guard itself stays correct regardless of this; only the *integration* vehicle is
  fragile (a future build-loop schema normalization would evaporate it). Not a code
  defect — the guard is the deliverable, the vehicle is a means to test it. No ticket;
  if a future change normalizes the build-loop schema, that change should pair a
  unit-level `DecompShape` exercise of the guard.
- **`apply schema` accepts the self-decomposition (deploy-time vs write-time).** The
  write-time guard catches it cleanly and the read is sound (1:1 PK join), so there is
  no data-integrity exposure — a deploy-time rejection would be pure belt-and-suspenders.
  Out of scope; YAGNI. No ticket.
- **Gap (b) detection scope.** Only duplicated base relations that surface as join
  `TableReferenceNode`s trip the guard; EAV-pivot duplicates (correlated subqueries)
  don't produce the `memberByTableId` ambiguity by construction, so they are correctly
  out of scope. Boundary confirmed.
- **Gap (b) message with >2 members** would read "X and Y and Z both resolve" via
  `join(' and ')`. Cosmetic only and unreachable in practice (3 members over one base
  table). Not worth a fix.

**Major findings: none.** No new tickets filed.

## Related (tracked separately, not in scope)

- WHERE-filter on a computed *anchor* column reported as a "non-anchor member" remains
  in `fix/misleading-non-anchor-diagnostic-on-computed-anchor-column`.
