description: A lens-synthesized commit-time set-level uniqueness CHECK (and, latently, any row-local CHECK / child-FK / parent-FK) was threaded onto EVERY base op of a decomposition UPDATE fan-out, so a member op whose target table lacks the constraint's referenced basis column failed to BUILD with `NEW.<col> isn't a column` — making the natural surrogate-keyed (logical-PK-not-on-every-member, no-basis-uniqueness) UPDATE path entirely unusable. Fixed with a uniform per-op resolvability gate at the threading site: a lens-synthesized constraint rides a base op iff every write-row column it references resolves on that op's target table.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # per-op gate at the threading site (~L188-202); writeRowColumns walker + constraintsForOp (~L865-1024)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # the four extraConstraints collectors (unchanged)
  - packages/quereus/test/lens-put-fanout.spec.ts                     # workaround removed + docKey-rekey routing regression
  - docs/lens.md                                                      # § Enforcement by constraint class — per-op routing paragraph
  - docs/view-updateability.md                                        # § Current limitations — cross-member CHECK/FK deferral residual
----

# Per-op resolvability gate for lens-synthesized constraints — COMPLETE

## What shipped

`buildViewMutation` threaded the SAME `extraConstraints` list (the four lens collectors: set-level
count CHECK, row-local CHECK, child-FK `EXISTS`, parent-FK `NOT EXISTS`) onto every base op of a
fan-out. On a decomposition UPDATE that fans out to a member op whose target table lacks a referenced
basis column, `buildConstraintChecks` could not resolve `NEW.<col>` and the whole UPDATE threw at
plan-build time — making the natural surrogate-keyed (logical PK not on every member, no basis
uniqueness) UPDATE path unusable.

The fix (the ticket's recommended approach A) adds a uniform per-op gate at the single
`extraConstraints` threading site:
- `writeRowColumns(expr)` — an AST walker collecting a constraint's write-row column refs: every
  `NEW.*` / `OLD.*`-qualified column anywhere (descending into subqueries for these), plus any bare
  unqualified column not inside a subquery.
- `constraintsForOp(op, …)` — keeps a constraint for an op iff every `writeRowColumns` entry resolves
  on `op.table.tableSchema.columns` (lowercased). Applied uniformly to all four classes.
- A debug `log()` fires when a constraint resolves on no base op of the fan-out (a key-unchanged UPDATE
  dropping its uniqueness scan; a cross-member CHECK/FK deferred).

Result: a set-level uniqueness CHECK rides only the op that owns (and can change) the key; a
key-unchanged member UPDATE drops it (sound — cannot create a duplicate); a cross-member row-local
CHECK / FK is deferred (matching the decomposition INSERT path); single-source spine is a no-op
(one base op carries all basis columns).

## Review findings

**Scope reviewed:** the full implement diff (3ec8903e) — the gate + walker in `view-mutation-builder.ts`,
the four collectors in `lens-enforcement.ts`, the FK/set-level synthesis shapes in
`foreign-key-builder.ts`, the prover's row-local classification in `lens-prover.ts`, the AST Expression
union in `ast.ts`, the test changes, and both docs. Run from every aspect angle: correctness/soundness,
walker completeness vs. every synthesized + user-authored constraint shape, type safety, the
single-source no-op claim, the multi-source-join interaction, and docs accuracy.

**Walker completeness (correctness) — checked, CLEAN for all reachable paths.** Cross-checked
`collectWriteRowColumns` against every shape the four collectors synthesize:
- *Set-level* (`synthesizeUniqueCountExpr`): `<= 1` over a count subquery; the correlated `NEW.bk` is
  collected from the subquery WHERE. ✓
- *Child-FK* (`synthesizeFKExistsExpr`): the MATCH-SIMPLE null-guard chain puts every `NEW.<child>` at
  top level (also collected from the subquery WHERE). ✓
- *Parent-FK* (`synthesizeFKNotExistsExpr` + `buildParentSideUpdateGuard`): `OLD.*`/`NEW.*` collected
  from the top-level null-safe guard and the `NOT EXISTS` WHERE. (Parent-FK only routes single-source,
  so the gate is a harmless no-op there.) ✓
- *Row-local CHECK* (user-authored, `rewriteToBasisTerms` → bare basis terms): bare top-level refs
  collected. Verified the parser emits a bare column as `{type:'column'}` (parser.ts:1882), not
  `identifier`, so the walker's `default`-drops (`literal`/`identifier`/`parameter`/`windowFunction`/
  `functionSource`) never swallow a column ref. `FunctionExpr` has only `args`/`distinct` (no FILTER
  sub-expr) — `function` case is complete. ✓

**Key soundness result — no new silent non-enforcement.** The walker's `NEW.*`/`OLD.*` collection
exactly mirrors what `buildConstraintChecks` must resolve on an op, so the gate can only convert a
*previously-crashing* config (a member op handed a constraint it couldn't build) into a deferral, or be
a no-op on a previously-working one. It never silently drops a constraint a base op was successfully
enforcing. The same gate also improves the multi-source-JOIN UPDATE path (a cross-side CHECK that
previously crashed now defers).

**Verification re-run (all green this pass):**
- `yarn workspace @quereus/quereus test --grep "surrogate-keyed optional-member UPDATE"` → 5/5.
- All lens tests (`--grep lens`) → 386 passing.
- Full `yarn workspace @quereus/quereus test` → **4921 passing, 9 pending, 0 failing** (matches handoff).
- `yarn workspace @quereus/quereus lint` → clean. `tsc --noEmit` → clean.
- Docs anchor checked: `view-updateability.md`'s `lens.md#enforcement-by-constraint-class` link resolves
  to the real `### Enforcement by constraint class` heading. Both docs accurately describe the shipped
  behavior (parent-FK single-source-only; the other three gated per op; the cross-member deferral
  residual).

**Findings filed (major → backlog, not fixed inline):** one ticket,
`lens-decomp-constraint-gate-residuals`, covering two edge residuals — neither reachable by any current
test, and the first fails loud (build error), not silently:
1. *Walker bare-ref-in-subquery fragility.* The walker assumes the `enforced-row-local` class is
   subquery-free, but the prover (`classifyCheckConstraint`) does NOT enforce that — and Quereus supports
   subquery-bearing CHECKs (auto-deferred). A row-local CHECK with a *correlated* subquery referencing a
   write-row column only **bare, inside** the subquery would be under-collected, re-opening the original
   `NEW.<col> isn't a column` build failure on a decomposition for that exotic shape. Suggested fix:
   approach B (attach mapped basis column names as metadata in `collectLensRowLocalConstraints`,
   sidestepping the AST heuristic). Filed rather than fixed inline because the proper fix touches the
   synthesis seam and needs a dedicated fixture.
2. *Cross-member deferral has no behavioral test.* The CHECK/FK deferral-vs-enforcement split is verified
   only by reasoning + the debug `log`; only the set-level key-routing arm is pinned by a test. Filed a
   request to add a cross-member-deferred + single-member-enforced behavioral test (needs a logical
   CHECK/FK fixture spanning members — non-trivial, so a separate ticket rather than a rushed inline
   fixture under this pass).

**Minor findings fixed inline:** none — no minor issues found; the implementation is clean, DRY (single
threading site, single shared walker across all four classes), small-single-purpose helpers, well
type-checked, and the debug `log` keeps any non-enforcement traceable.

**Empty categories (explicit):** No correctness bug, no resource-cleanup issue (pure plan-build, no
handles), no error-handling gap (the gate fails closed toward build-error, never toward silent
acceptance), and no docs drift were found in the shipped change. The only residuals are the two
edge-of-gate items above, both dispositioned to backlog.

## Net

The fix is sound, well-tested for every reachable path, and correctly documented. Two narrow,
loud-failing-or-untested residuals at the gate's edges are carried forward as
`lens-decomp-constraint-gate-residuals` (backlog).
