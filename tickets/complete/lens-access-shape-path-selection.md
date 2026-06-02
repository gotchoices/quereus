description: Lens access-shape read-path consumer — the planner routes an exotic outer-query predicate over an inlined lens view through an advertised auxiliary structure (nd-tree / vector / full-text) as an auxiliary-seek ⋈ logical-key semi-join, instead of a residual filter over the full decomposition scan. Reviewed: one correctness bug found + fixed inline (cross-column fragment produced a broken plan); build + lint + full suite green (4287 passing); 14 access tests (13 implement + 1 regression).
files: packages/quereus/src/planner/nodes/lens-auxiliary-access-node.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/runtime/emit/lens-auxiliary-access.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/planner/building/lens-auxiliary-access.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/rules/access/lens-access-form-matcher.ts, packages/quereus/src/planner/rules/access/rule-lens-auxiliary-access.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/test/vtab/test-nd-tree-module.ts, packages/quereus/test/lens-access-form-matcher.spec.ts, packages/quereus/test/lens-access-routing.spec.ts, docs/lens.md, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts
----

# Lens access-shape read-path consumer (complete)

Read-path sibling of `lens-module-mapping-advertisement`. When a query predicate over a
lens logical table matches a form advertised on an `auxiliary-access` structure, the planner
now routes the read through that structure (auxiliary seek ⋈ logical-key semi-join) rather
than scanning the primary decomposition and filtering. Architecture, data flow, and v1
boundaries are documented in `docs/lens.md` § *Auxiliary-access read-path routing* and were
verified accurate during review.

## Review findings

**Scope of review.** Read the full implement diff (`c898b8ee`) before the handoff summary, then
audited from SPP / DRY / soundness / type-safety / error-handling / test-coverage angles, with
particular attention to the four review-focus items the implementer flagged. Re-ran build, lint,
and the full quereus suite.

### Found + fixed inline (minor)

- **Cross-column routed fragment produced a broken plan (correctness bug).** The rewrite
  re-points *only* the matched access column at the auxiliary's backing column and pushes the
  whole fragment below the semi-join onto the aux scan. A legal predicate that also references a
  *second* logical column — e.g. `nd_contains(coord, other)` where `other` is a logical column the
  auxiliary does not carry — left that second column dangling on the aux side, so the query failed
  at runtime with `QuereusError: No row context found for column other` (confirmed with a repro)
  instead of returning rows. The form-matcher's recognizer only checks the function name + presence
  of *an* access column; it never verified the fragment was confined to that one column. (Same class
  would mis-handle a multi-column form, since only one column is rewritten.)
  - **Fix:** added `fragmentConfinedToAccessColumn(fragment, accessAttrId)` in
    `rule-lens-auxiliary-access.ts` and filter matched paths through it before `chooseMatch`, so a
    fragment referencing any logical column other than its access column **degrades to scan** (the
    same graceful-degrade contract as an unrecognized form) rather than emitting an invalid plan.
  - **Test:** `lens-access-routing.spec.ts` — "degrade: a routed-form fragment referencing a second
    logical column falls back to the scan" (asserts both no-routing via the plan-table oracle and a
    correct residual-filter result).
  - **Docs:** added this degrade case to the `docs/lens.md` graceful-degrade list.

### Checked — accepted as designed (no change)

- **Soundness / totality assumption** (review-focus #1). The semi-join is row-equivalent to the
  residual-filter scan only if the auxiliary is a faithful, total index of the logical data. This is
  the inherent "an auxiliary is an index" / D4 contract; documenting-as-module-contract is the right
  v1 call (the motivating nd-tree / covering-MV structures are write-through and total by
  construction). A runtime totality guard is correctly out of scope for v1.
- **Semi-join × downstream join physical selection / no manual cost stamp** (review-focus #2). The
  routed subtree relies on the existing join-physical-selection + access-path machinery. Semi-joins
  already flow through that machinery (subquery decorrelation produces them) and the full suite —
  including the property-based planner tests — stays green, so no pathological downstream selection
  surfaced. Accepted; no manual cost stamping needed for v1.
- **Comparison-form routing deferred** (review-focus #3). `equality`/`range` matches are surfaced by
  the matcher (unit-tested) but intentionally not routed — the primary body's own predicate-pushdown
  already answers them, so routing would add a needless join. Confirmed intended scope.
- **Marker / pushdown ordering — no barrier** (review-focus #4). Verified the mechanism directly:
  `PassManager.applyPassRules` (`framework/pass.ts:520`) iterates `pass.rules` in **registration
  order** (the `priority` field is *ignored* in the pass path — only the separate global
  `RuleRegistry` honors it), and the lens rule's `addRuleToPass` call precedes predicate-pushdown's.
  `findMarker` walks `Alias`/`AssertedKeys` pass-throughs, and pushdown does not know the marker node
  type so it cannot slide a Filter below it. The aliased-view e2e test exercises this. No barrier
  needed. (Note: the rule's `priority: 17` is dead metadata in this path and even sits out of order
  vs its registration neighbors — cosmetic only; left as-is to match the surrounding convention of
  stamping a priority on every `addRuleToPass` rule.)
- **`splitConjuncts` identity invariant.** Verified `splitConjuncts` returns the *same* leaf node
  instances (it collects references into the input tree), so the rule's `conjuncts.filter(c => c !==
  predicateFragment)` residual construction and `conjuncts.indexOf(...)` deterministic ordering are
  sound — both the rule and the matcher split the *same* normalized tree.
- **Process-global recognizer registry.** Built-in + fixture recognizers persist process-wide;
  duplicate recognizers are deduped by the `if (hit) break` in `matchAccessForms` (first match wins),
  and no other test defines both a matching scalar function and a `contains`-form auxiliary, so cross-
  test leakage is benign. Accepted.
- **Multi-lens-view / non-adjacent-Filter queries** don't route (the predicate sits above a Join /
  Project the marker-walk does not cross) — safe degrade, acceptable v1 limitation.
- **Composite-PK join-back** is built positionally and AND-combined; logic is correct (not separately
  tested, but the single-column path and the build-time alignment checks cover the machinery).

### Documented v2 boundaries (unchanged, correctly scoped out)

Surrogate-only auxiliaries degrade to scan; one routed predicate per query; exact-form (lossy/
refinement-required forms are v2); no multi-auxiliary cost tournament; `checkAnsweringStructures`
not yet taught to credit a routable auxiliary. All match the plan's D-decisions.

### Validation

- `yarn workspace @quereus/quereus run build` — tsc clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — **4287 passing, 0 failing, 9 pending**.
- `test:store` not run — planner/read-path only, no store path touched.
- No pre-existing failures observed.
