description: Implemented the provenance-ranked, symmetric comparison-collation lattice (explicit COLLATE > declared column collation > defaulted collation > BINARY), replacing right-operand precedence. ScalarType gained collationSource; comparison-collation.ts is now the single resolver behind every plan-time mirror and runtime emitter; same-rank explicit/declared conflicts error at prepare time. Review the implementation.
files:
  - packages/quereus/src/common/datatype.ts                                # CollationSource type + ScalarType.collationSource
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # full rewrite — THE resolver (lattice, IN merge, propagation merge, throwing wrappers)
  - packages/quereus/src/planner/nodes/scalar.ts                           # BinaryOp validation+merge, CASE merge, Collate→'explicit', UnaryOp/Cast pass-through, BetweenNode cached generateType + per-bound validation
  - packages/quereus/src/planner/nodes/subquery.ts                         # InNode cached generateType + validation
  - packages/quereus/src/planner/building/expression.ts                    # eager getType() forcing for comparisons / IN / BETWEEN
  - packages/quereus/src/planner/type-utils.ts                             # columnSchemaToScalarType → 'declared'/'default' from collationExplicit
  - packages/quereus/src/planner/nodes/reference.ts                        # TableReferenceNode attrs now via columnSchemaToScalarType (DRY)
  - packages/quereus/src/planner/building/alter-table.ts                   # 3 sites — two via columnSchemaToScalarType, SET-COLLATE site 'declared'
  - packages/quereus/src/planner/analysis/change-scope.ts                  # PortableScalarType round-trips collationSource
  - packages/quereus/src/runtime/emit/binary.ts                            # emitComparisonOp via effectiveComparisonCollation
  - packages/quereus/src/runtime/emit/between.ts                           # per-bound via effectiveBetweenBoundCollation
  - packages/quereus/src/runtime/emit/subquery.ts                          # emitIn via effectiveInCollation(plan) — RHS now participates
  - packages/quereus/src/runtime/emit/join.ts                              # USING comparator via effectiveCollationOfTypes (early slice of join-key-collation-resolution-alignment)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # NEW singleton-IN cover gate (inConstraintCollationOk); IN gate now uses node-level resolution
  - packages/quereus/src/planner/util/fd-utils.ts                          # IN guard-fact gate now load-bearing (effectiveInCollation(n))
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts          # eq↔IN collapse re-gated on pure resolvers, pre-construction
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation doc + IN call-site
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic  # NEW — full behavior matrix
  - packages/quereus/test/planner/comparison-collation.spec.ts             # NEW — unit rank/conflict table
  - packages/quereus/test/logic/40.2-check-extras.sqllogic                 # chk_coll_flip now symmetric-NOCASE
  - packages/quereus/test/planner/constraint-extractor.spec.ts             # helpers gained provenance; one test inverted (see below)
  - docs/types.md                                                          # "Comparison collation resolution" subsection
difficulty: hard
----

# Review: comparison collation provenance lattice

Implements ticket `comparison-collation-provenance-and-precedence` as designed.
All phases landed; full validation run is green:

- `yarn build` (workspace) clean; `yarn lint` (packages/quereus) clean.
- `yarn test` (workspace root): quereus 5977 passing / 0 failing; all other
  packages green.
- `yarn test:store` (LevelDB store module): 5973 passing / 0 failing — the
  store's implicit-PK NOCASE reconcile carries 'default' provenance and keeps
  winning uncontested from either side.

## What the resolver now is

`planner/analysis/comparison-collation.ts` exports the pure lattice
(`collationContribution`, `resolveComparisonCollation`, `resolveInCollation`,
`mergePropagatedCollation`) plus throwing wrappers
(`effectiveComparisonCollation`, `effectiveBetweenBoundCollation`,
`effectiveInCollation(node: InNode)` — signature change,
`effectiveCollationOfTypes` for type-pair sites) and
`collationConflictError` / `isComparisonOperator`. Ranks: explicit 3 /
declared 2 / default 1; defaulted BINARY contributes nothing; absent
`collationSource` with a present name floors to 'default'.
`operandCollation`, `isValueDiscriminatingEquality`, and the AST variant are
unchanged in behavior (both-sides-BINARY rule retained, doc updated).

Plan-time error placement: `BinaryOpNode.generateType` (comparison class incl.
unreachable binary IS — the parser only produces unary `IS [NOT]
NULL/TRUE/FALSE`, documented), `InNode.generateType`,
`BetweenNode.generateType` (both nodes gained `Cached` types), all forced
eagerly in `building/expression.ts` so conflicts error at prepare. Emit-side
calls are loud backstops.

## Use cases for validation (all pinned in tests)

- Headline symmetry: `b = c` / `c = b` with one NOCASE-declared side both
  resolve NOCASE (40.2 `chk_coll_flip` inverted; 06.4.4 §1).
- Explicit/declared conflict errors, both spellings, ordering ops, and
  non-textual COLLATE-wrapped operands (06.4.4 §2/§4; messages:
  `conflicting COLLATE clauses in comparison: X vs Y` and
  `ambiguous collation for comparison: column collations X vs Y differ; apply
  an explicit COLLATE`).
- Defaults-conflict → BINARY silently; defaulted NOCASE beats defaulted BINARY
  (two tables under different session `default_collation`s, 06.4.4 §6).
- Concat propagation: plain-left no longer shadows declared NOCASE; nested
  COLLATE rides rank 3 through `||`; conflicted declared concat propagates no
  collation → BINARY comparison (06.4.4 §7). CASE merges identically
  (order-independent, unit-tested).
- BETWEEN per-bound: two differently-collated explicit bounds are NOT a
  conflict; expr-vs-bound declared conflict errors; NOT BETWEEN same (§8).
- IN: list/subquery RHS now participates via merge — `a IN (n)` with n
  NOCASE-declared resolves NOCASE; conflicting explicit elements error;
  rank-1 element conflicts merge to no-contribution (§9 + unit spec).
- FK declared-collation conflict (parent RTRIM vs child NOCASE) errors at DML
  prepare (§10).
- USING joins resolve through the lattice (`using (k)` ≡ `l.k = r.k`).

## Soundness additions beyond the ticket text

- **Singleton-IN covered-key gate** (`inConstraintCollationOk`,
  constraint-extractor.ts): the old "IN constraints need no gate" rationale
  died with condition-only resolution — `b IN ('bob' collate nocase)` now
  compares NOCASE, so ungated it would falsely cover a BINARY key. Gate
  mirrors the equality gate (effective BINARY, or equal to the column's own
  collation).
- fd-utils' IN guard-fact gate and constraint-extractor's OR-branch IN gate
  switched to node-level resolution and are now load-bearing, not
  future-proofing (comments updated).
- predicate-normalizer's eq↔IN collapse gates **before** constructing the
  InNode (per-disjunct resolution must equal the merged IN resolution), so a
  conflicted candidate is never built.

## Deviations / honest gaps for the reviewer

1. **CHECK conflicts error at first-DML prepare, not CREATE TABLE.** The
   ticket assumed CHECK compiles at CREATE time; it actually compiles in
   constraint-builder during DML planning. 06.4.4 §5 pins the actual compile
   point. CREATE-time detection is parked with the FK variant in backlog
   `fk-collation-conflict-create-time-validation` (already filed) — consider
   whether that ticket's description should be widened to cover CHECK, or a
   sibling filed.
2. **emit/join.ts USING change is an early slice of
   `join-key-collation-resolution-alignment`** (implement/, prereq'd on this
   ticket). That ticket still owns merge-join/bloom-join/asof-scan key
   resolution, USING *plan-time* validation (today a USING declared-conflict
   throws at emit via the backstop, not prepare), planner-side ordering
   lockstep, and MV `collationExplicit` threading. Nothing here conflicts
   with it; its first TODO item is simply done.
3. **constraint-extractor.spec.ts "written order is load-bearing" test was
   inverted** (now "written order is immaterial", expecting decline): with
   symmetric resolution, `'bob' COLLATE NOCASE = b(BINARY-declared)` compares
   NOCASE, so collapsing into a BINARY-driven IN is unsound. The spec's
   `collatedLit`/`textColRef` helpers gained `collationSource`
   ('explicit'/'declared') to model the real folded shapes — reviewer should
   sanity-check those helper semantics against real constant-folding output
   (LiteralNode explicitType copies the whole type, so 'explicit' is right).
4. **Boolean-result comparisons still carry a (merged) collation** on their
   ScalarType, as before the change — now via the propagation merge instead of
   `left || right`. Inert (booleans never compare under collation) but worth a
   reviewer glance.
5. **Plan goldens unchanged**: `formatScalarType` serializes only the logical
   type name, so `collationSource` never surfaces; full plan/optimizer suites
   pass untouched.
6. The ticket's sweep item `building/schema-resolution.ts` was a false
   positive — its `collationName:` is a function parameter, not a ScalarType
   construction. All real construction sites were swept (`grep collationName:`
   in src/ now shows only provenance-threaded or non-ScalarType sites);
   whole-type copies (LiteralNode explicitType, CollateNode spread, projection
   passthroughs, change-scope portable round-trip) carry the field free.

## Suggested review probes

- Adversarial: try to construct an optimizer-synthesized comparison (key
  filter, decorrelation, predicate inference, MV rewrite) that pairs operands
  a user comparison never paired — the design claim is the admitting gate
  always requires collation equality, so the emit backstop should be
  unreachable. If one trips, fix the gate, not the resolver.
- `mergeContributions` order-independence (unit-tested for the documented
  shapes; worth a read for the conflict-clearing-on-higher-rank path).
- The 06.4.4 §6 session-default matrix under the store module (already run
  green via `yarn test:store`, but the reconcile interplay is the subtle
  path).
