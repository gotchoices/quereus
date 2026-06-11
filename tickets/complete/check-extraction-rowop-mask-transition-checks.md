description: Row-invariant gate on CHECK fact extraction (operation mask ⊇ insert|update, no `old.` refs, not deferred); assertion-hoist synthetic checks carry the default mask. Reviewed and complete.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts          # isRowInvariantCheck + containsOldRowImageRef, gate at top of extraction loop
  - packages/quereus/src/planner/analysis/predicate-shape.ts           # columnIndexFromExpr docblock: deliberate new./self-qualifier tolerance
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts     # synthetic checks: operations 0 → DEFAULT_ROWOP_MASK
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts          # "row-invariant gate" describe block (14 tests)
  - packages/quereus/test/logic/40.2-check-extras.sqllogic             # "Row-invariant gate" section: 4 wrong-result repros + 4 controls (new.-fold pin added in review)
  - docs/optimizer.md                                                  # § Check-derived contributions — row-invariant gate paragraph
----

# Complete: row-invariant gate on CHECK fact extraction

## What landed

`extractCheckConstraints` previously minted unconditional value facts (FDs,
EC pairs, constant bindings, domain constraints) from every entry in
`tableSchema.checkConstraints`, ignoring the operation mask and `old.`
row-image references — letting `ruleFilterContradiction` fold WHERE
predicates to empty against rows the engine never enforced the check on
(confirmed wrong results).

A per-check row-invariant gate (`isRowInvariantCheck`) now runs at the top
of the extraction loop. A check contributes facts only when ALL hold:

1. **Mask ⊇ INSERT|UPDATE** — mirrors enforcement's `shouldCheckConstraint`
   filtering; DELETE membership irrelevant (a delete stores no row image).
2. **Not deferred** (`deferrable`/`initiallyDeferred`) — defensive; the
   parser rejects DEFERRABLE on CHECK.
3. **No `old.`-qualified `ColumnExpr`** anywhere in the expression
   (`containsOldRowImageRef`, reflective walk via `walkAstNodes`).
   `new.<col>` stays allowed: NEW is the stored row image, so NEW-qualified
   refs are same-row facts.

Assertion-hoist synthetic checks changed from `operations: 0` (which the
gate would silently drop) to `DEFAULT_ROWOP_MASK`. All consumers
(`TableReferenceNode.computePhysical`, lens-prover `enumerableDomain`,
assertion-hoist direct call) ride the shared gate. docs/optimizer.md
§ Check-derived contributions documents the gate ahead of the shape table.

## Review findings

### What was checked

- **Diff first, fresh eyes** (commit `a2a94d23`): gate placement (after the
  `!check.expr` guard, before the non-determinism screen), mask arithmetic,
  helper docblocks, assertion-hoist mask change, predicate-shape docblock,
  docs paragraph, both test files.
- **Auto-deferral hole probe**: checks containing subqueries are
  auto-deferred at plan time (`needsDeferred` in constraint-builder.ts:190)
  and that flag is NOT stored on `RowConstraintSchema`, so the gate's
  deferred leg cannot see it. Confirmed this is not a hole: any
  auto-deferred check necessarily contains a subquery/exists node, and the
  pre-existing `containsNonDeterministicCall` screen (check-extraction.ts:557)
  kills any check containing one, wholesale and reflectively. The deferred
  leg is genuinely defensive-only, as the implementer claimed.
- **Row-image qualifier completeness**: the enforcement scope
  (constraint-builder.ts:94-143) registers only `new.<col>`, `old.<col>`,
  and unqualified columns — no third marker the screen could miss. If
  `old.a` ever parsed as a schema-qualified `IdentifierExpr` instead of a
  `ColumnExpr`, `columnIndexFromExpr` rejects it (returns undefined), so no
  fact could be minted either way.
- **DELETE-leg subtlety**: for an insert|update|delete mask, unqualified
  columns resolve to OLD on the delete path. Sound — the delete leg only
  constrains which rows may leave; the insert/update legs still guarantee
  the invariant over every stored NEW image. Gate's acceptance of that mask
  is correct (and pinned by a unit test).
- **All consumers traced**: reference.ts computePhysical (additionally
  gated by `permitsGrandfatheredCheckViolators`), lens-prover
  `enumerableDomain` (lens logical constraints carry parsed masks verbatim
  via `buildLogicalConstraints` — confirmed at lens.ts:254-267),
  assertion-hoist. WeakMap cache unaffected (new schema objects on ALTER).
- **Parser claim verified**: DEFERRABLE is parsed only inside FK clauses;
  parser.ts:4696 comment confirms CHECK cannot take it.
- **Pre-gate repro re-verified** (gap the handoff admitted skipping):
  temporarily reverted check-extraction.ts to the pre-implement version and
  ran the 40.2 logic file — the insert-only repro fails with "Row count
  mismatch. Expected 1, got 0" (wrong result reproduced), so the sqllogic
  pins genuinely guard the gate. File restored; suite re-run green.
- **Docs**: optimizer.md is the only doc referencing check extraction
  (grep across docs/); the new paragraph accurately covers all three legs,
  the `new.` tolerance, and the assertion-hoist mask.
- **Validation**: `typecheck` clean, `lint` clean, full `yarn test` green
  across all workspaces (quereus 5850 passing / 9 pending, zero failures).

### Findings and dispositions

- **Minor — fixed inline**: the handoff noted the `new.`-facts-still-fold
  claim was pinned only at the unit level. Added an end-to-end sqllogic
  control (`t_riv_newfold`: `check (new.v > 0)` folds `where v <= 0` to
  empty) to 40.2-check-extras.sqllogic.
- **Major (pre-existing, latent) — filed backlog ticket
  `lens-prover-check-extraction-grandfathered-violators-gate`**: lens-prover
  consumes check-derived domains without the
  `permitsGrandfatheredCheckViolators` capability gate reference.ts applies.
  Unreachable today (no shipped module declares the capability; only a test
  double), but unsound for plugin modules that do. Not introduced by this
  ticket.
- **Enhancement — filed backlog ticket
  `check-extraction-per-conjunct-old-screen`**: the whole-check `old.` kill
  is coarser than necessary; under SQL ternary logic, screening per
  AND-conjunct is provably sound and would preserve invariant conjuncts of
  mixed transition/invariant checks. Low priority.
- **No bugs found in the implemented gate itself** — mask logic, screen
  coverage, consumer wiring, and tests all check out; conservative edges
  (table literally named `old`, whole-check kill) err in the sound
  direction and are documented in the code.

### Explicitly empty categories

- No correctness, type-safety, resource-cleanup, or error-handling defects:
  the change is a pure pre-filter over an existing pure function — no
  resources, no async, no new error paths; types are exact (`RowOpFlag`
  bit-ops on `RowOpMask`, no `any`).
- No performance concerns: the gate short-circuits before AST walks for
  mask/deferred rejections; the `old.`-walk is once per check and the
  result is WeakMap-cached per schema.
- No DRY/structure issues: reuses `walkAstNodes` rather than a new walker;
  the gate lives beside its only caller.

## Validation (final state, including review additions)

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- Full `yarn test` (all workspaces) — green: quereus 5850 passing /
  9 pending, zero failures anywhere.
- 40.2-check-extras.sqllogic verified to fail without the gate (revert
  experiment) and pass with it, including the new `new.`-fold control.
- `yarn test:store` not run (AGENTS.md: store-specific issues only).
