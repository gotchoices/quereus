description: Review the two `classifyColumn` lineage-routing robustness guards added to the decomposition put fan-out — a defensive `no-base-lineage` reject when an identity column's lineage resolves but no member owns its base table-ref (gap a), and an `unsupported-decomposition-member` reject for a self-decomposition (two members over one physical base relation, gap b). Both harden currently-unreachable states; the bulk of the work was constructing reachable test vehicles for them.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/lens-put-fanout.spec.ts
----

## What changed

Two unguarded assumptions in `classifyColumn` / `analyzeDecomposition`
(`planner/mutation/decomposition.ts`) now reject defensively instead of classifying
silently. Both states are unreachable through shipped advertisement shapes today; the
guards make the implicit dependencies explicit so a future change cannot silently
regress them.

### Gap (a) — identity-mapping lineage miss no longer degrades to read-only

`classifyColumn`'s first gate resolves an identity base column off the threaded
`updateLineage` (`col.baseColumn` + `col.baseTableId`, `inverse === undefined`) and
looks the member up in `shape.memberByTableId`. Previously, when that lookup **missed**
(member `undefined`), control fell through to the `member.columns` fallback, which
matches by **logical-column name only** and returns `computed-mapping` (read-only) — so
a *writable* identity column whose lineage failed to resolve a member silently became
read-only, masking the lineage bug as a benign "read-only column".

Now the qualified-but-no-member branch raises a structured `no-base-lineage` diagnostic
("…resolves to identity base column '…', but no decomposition member backs its base
relation (lineage-resolution miss); a writable column must not silently degrade to
read-only"). The legitimate `computed-mapping` route is **unchanged**: a non-identity
mapping never reaches the first gate's body (an invertible transform carries an
`inverse`; a non-invertible composite resolves to `computed` with no `baseColumn`), so
it still falls through to `computed-mapping`. The four existing
`non-identity columnar mappings (computed-mapping route)` tests still pass, which is the
key regression guard for this change.

`classifyColumn` now takes `view` (threaded through all three call sites:
`routeInsertColumn`, `routeAssignment`, `assertAnchorScoped`) purely so the diagnostic
can name the logical table. It now throws on a genuine miss — acceptable because a miss
is always an error for every caller.

### Gap (b) — self-decomposition rejected locally

`analyzeDecomposition` builds `memberByTableId` by matching each planned-body
`TableReferenceNode`'s `(schema, table)` to a member. Two members over the **same**
physical base relation (a self-decomposition) both match every such ref, so the map
resolution is ambiguous (silently picks one member). The build loop now uses
`filter()` instead of `find()` and raises a new `unsupported-decomposition-member`
diagnostic ("…members 'X' and 'Y' both resolve to the same base relation '…' (a
self-decomposition); the put fan-out cannot disambiguate which member backs a column")
when a body ref is claimed by more than one member.

New `MutationDiagnosticReason`: `unsupported-decomposition-member` (added to the
`unsupported-decomposition-*` family in `mutation-diagnostic.ts`).

## Validation performed

- `yarn workspace @quereus/quereus typecheck` — clean.
- `yarn workspace @quereus/quereus lint` — clean.
- `packages/quereus/test/lens-put-fanout.spec.ts` — 38 passing (4 new + the existing
  non-identity regression guards).
- Full quereus suite (`yarn workspace @quereus/quereus test`) — **4415 passing, 9
  pending, 0 failing**.

### New tests (describe `lens decomposition put: column-classification robustness`)

- **(a) read with empty member schema** — a single-member advertisement declaring
  `relation.schema: ''` reads correctly (`resolveBasisRelation` resolves '' → basis
  'main', so the body compiles against `main.G_core`).
- **(a) identity-column update surfaces `no-base-lineage`** — `update x.G set a = 99`
  (no WHERE, so the assignment routes straight through `routeAssignment` →
  `classifyColumn`) asserts the message matches `/lineage-resolution miss/i` and
  **does not** match `/computed \(non-invertible\)/i` (i.e. does not masquerade as the
  read-only fall-through). Atomicity asserted.
- **(b) read through the self-join** — two members over `main.S` (join on the shared
  key `id`, 1:1 on the PK) reads `{id, x, y}` correctly.
- **(b) write rejects the self-decomposition** — `update x.S set x = 99 where id = 1`
  raises `/self-decomposition|both resolve to the same base relation/i`; base table
  untouched.

## Honest gaps / what the reviewer should scrutinize

- **Gap (a)'s test vehicle is coupled to a build-loop quirk.** The empty-`relation.schema`
  advertisement reaches the `memberByTableId` miss *because* `analyzeDecomposition`'s
  build loop matches `(schema, table)` **exactly** while `resolveBasisRelation` (and
  most other consumers: `deriveSurrogateMemberKeys`, `validateOverrideAdvertisementConflict`)
  apply a `|| basis.schemaName` fallback. I deliberately did **not** add that fallback to
  the build loop — the ticket asked for the defensive reject, not to make empty-schema
  *work*. Tradeoff: if a future change normalizes the build-loop schema (a reasonable
  robustness improvement in its own right), empty-schema would become writable and this
  test's vehicle would evaporate, since the genuine miss is otherwise unreachable. The
  `classifyColumn` guard itself stays correct regardless; only the *vehicle* is coupled.
  A reviewer who prefers normalizing the build loop should pair it with an alternative
  way to exercise the guard (e.g. a unit-level `DecompShape` with an empty
  `memberByTableId`), or accept that the guard becomes purely defensive (untested-by-
  integration). Flagging this as the main judgment call.
- **`apply schema` accepts the self-decomposition.** The gap-(b) advertisement deploys
  cleanly — the prover / existence-anchor IND injection do **not** reject two members
  over one base table at deploy time (the write-time guard is what catches it, as the
  ticket intended: "enforced locally rather than relying on the upstream self-join
  rejection"). A reviewer may want to consider whether a deploy-time rejection is also
  warranted (belt-and-suspenders); out of scope here, but the asymmetry is worth a look.
- **Gap (b) detection scope.** The reject fires only when the duplicated base relation
  actually appears as a join `TableReferenceNode` (the `memberByTableId` ambiguity the
  ticket targets). A duplicate that never becomes a join ref — e.g. two EAV pivots over
  one table, or a columnar + EAV member over one table — would not trip it. Those shapes
  do not produce the `memberByTableId` ambiguity (EAV pivots are correlated subqueries,
  not join members), so they are out of scope, but the boundary is worth confirming.
- **Path coverage.** Both guards sit on shared chokepoints (`classifyColumn` for gap a;
  `analyzeDecomposition`, called first in both `propagateDecomposition` and
  `analyzeDecompositionInsert`, for gap b), so DELETE / INSERT raise through the same
  code as the tested UPDATE. I only added explicit **UPDATE** assertions for each. A
  reviewer wanting belt-and-suspenders could add DELETE/INSERT cases; I judged the
  shared chokepoint sufficient rather than redundant.
- **No doc change.** The decomposition diagnostics are not enumerated in a canonical
  docs table (the reason union lives in `mutation-diagnostic.ts` with inline comments,
  kept in sync). `docs/view-updateability.md` references deferred shapes only inside a
  property-test narrative for a *different* test family (`decomposition fan-out` via
  `quereus.lens.decomp.*` tags), which these guards do not belong to. Left untouched
  deliberately; confirm you agree these defensive guards don't warrant a design-doc note.

## Related (already tracked separately, not in scope)

- The third diagnostic-accuracy item (WHERE-filter on a computed *anchor* column
  reported as a "non-anchor member") remains in
  `fix/misleading-non-anchor-diagnostic-on-computed-anchor-column`.
