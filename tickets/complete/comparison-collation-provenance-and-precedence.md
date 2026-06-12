description: Provenance-ranked, symmetric comparison-collation lattice (explicit COLLATE > declared column collation > defaulted collation > BINARY) replacing right-operand precedence. ScalarType gained collationSource; comparison-collation.ts is the single resolver behind every plan-time mirror and runtime emitter; same-rank explicit/declared conflicts error at prepare time. Implemented, reviewed, complete.
files:
  - packages/quereus/src/common/datatype.ts                                # CollationSource type + ScalarType.collationSource
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # THE resolver (lattice, IN merge, propagation merge, throwing wrappers)
  - packages/quereus/src/planner/nodes/scalar.ts                           # BinaryOp validation+merge, CASE merge, Collate→'explicit', BetweenNode cached generateType
  - packages/quereus/src/planner/nodes/subquery.ts                         # InNode cached generateType + validation
  - packages/quereus/src/planner/building/expression.ts                    # eager getType() forcing for comparisons / IN / BETWEEN
  - packages/quereus/src/planner/type-utils.ts                             # columnSchemaToScalarType → 'declared'/'default' from collationExplicit
  - packages/quereus/src/runtime/emit/{binary,between,subquery,join}.ts    # emitters via shared resolver
  - packages/quereus/src/planner/analysis/{constraint-extractor,predicate-normalizer}.ts  # gates re-derived on the lattice
  - packages/quereus/src/planner/util/fd-utils.ts                          # IN guard-fact gate load-bearing
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic
  - packages/quereus/test/planner/comparison-collation.spec.ts
  - docs/types.md, docs/sql.md, docs/optimizer.md
----

# Comparison collation provenance lattice — complete

A comparison (`=`/`!=`/`<`/`<=`/`>`/`>=`, IN, each BETWEEN bound, USING join
pairs) resolves ONE effective collation symmetrically from both operands'
provenance: explicit COLLATE (rank 3) > explicitly-declared column collation
(rank 2) > defaulted collation (rank 1; defaulted BINARY contributes nothing)
> BINARY floor. Same-rank explicit/declared name conflicts are prepare-time
errors; same-rank default conflicts resolve to BINARY silently. This
deliberately diverges from SQLite's left-operand precedence — `a = b` ≡
`b = a` always. `planner/analysis/comparison-collation.ts` is the single
resolver behind every plan-time mirror (access-path collation cover, FD/EC
gates, predicate-normalizer eq↔IN collapse, constraint-extractor gates,
including a NEW singleton-IN covered-key gate) and every runtime emitter
(`emitComparisonOp`, `emitIn` — RHS now participates via merge, `emitBetween`
per-bound, the USING-join comparator). Validation errors fire where the
comparison compiles: statement prepare for queries, DML prepare for CHECK/FK
write-path scopes. Non-comparison combiners (`||`, CASE) propagate collation
by rank, order-independently; equal-rank disagreement propagates none.
Full behavior matrix in test/logic/06.4.4; unit rank/conflict table in
test/planner/comparison-collation.spec.ts. docs/types.md § Comparison
collation resolution is the reference.

Known deferred slices (tickets on file at completion):
- USING declared-conflict plan-time validation, merge/bloom/asof key
  resolution, planner ordering lockstep, MV collationExplicit threading →
  implement/`join-key-collation-resolution-alignment` (prereq'd on this).
- CREATE-time detection of conflicted CHECK/FK collations (today: first-DML
  prepare) → backlog/`fk-collation-conflict-create-time-validation`.
- Set-operation cross-input collation merge → backlog ticket of that name.

## Review findings

**Checked** (adversarial pass over commit dc7b125e, diff read before the
handoff summary):

- Resolver logic line-by-line: `collationContribution` flooring,
  `resolveContributions` rank/conflict table, `mergeContributions`
  order-independence (including the conflict-clearing-on-higher-rank path —
  verified correct by case analysis; the unit spec's 11×11 symmetry matrix
  and reversal tests pin it), `resolveInCollation`'s merge-then-resolve, and
  `mergePropagatedCollation`'s no-coin-flip rule.
- Every `new BinaryOpNode` / `new InNode` / `new BetweenNode` site in src/:
  builder sites force the cached type eagerly (prepare-time errors); the
  predicate-normalizer's collapse pre-gates before construction; rebuild
  sites (`withChildren`, in-subquery cache rule, normalizer) revalidate
  lazily as backstops. `Cached` leaves the cache empty on throw, so a
  conflicted type re-throws consistently.
- Emit-backstop reachability probe across optimizer-synthesized comparisons:
  subquery decorrelation pairs the same operand types the InNode already
  validated at prepare; predicate-inference equality synthesis and
  key-filter param refs carry the column's own type on both sides; the
  sargable range rewrite's literals carry the column type verbatim; lens
  auxiliary join keys are engine-maintained mirrors. None can mint a
  conflict a user comparison didn't already trip — backstop unreachable as
  designed. MV remap-to-backing provenance is the one open edge, explicitly
  owned by `join-key-collation-resolution-alignment` (its scope was
  verified to cover it).
- Provenance sweep: `collationName:` grep over src/ confirms all ScalarType
  construction sites are threaded or carry the field via whole-type copies;
  `collationExplicit` provenance verified at the schema layer
  (`columnDefToSchema` sets it for the CREATE-time COLLATE clause only;
  the store reconcile spreads without it → 'default' rank, as the design
  intends in-session). Constant folding preserves the whole type
  (`LiteralNode.explicitType` via const-pass), so the inverted
  constraint-extractor spec's `collatedLit('explicit')` helper models the
  real folded shape correctly.
- Docs sweep across docs/ for the retired right-operand rule.
- Validation: `yarn build` clean, `yarn lint` (packages/quereus) clean,
  full `yarn test` green — quereus 5977 passing / 0 failing / 9 pending,
  all other packages green. (`yarn test:store` was run green by the
  implement stage; nothing in this review changed source.)

**Minor — fixed in this pass:** four stale documentation passages still
described the old right-operand precedence: docs/sql.md CHECK-constraint
collation note and § 4.4 COLLATE-expression resolution paragraph;
docs/optimizer.md access-path collation-cover bullet and the
equality-fact-gate resolution bullet. All four now describe the symmetric
provenance lattice and point at docs/types.md § Comparison collation
resolution. (docs/types.md itself was written correctly by the implement
stage.)

**Major — new ticket filed:** fix/`collation-provenance-stability-set-collate-and-reload`.
The lattice rank of a column's collation is currently a function of schema
*history*, not catalog state: `ALTER COLUMN ... SET COLLATE` never sets
`collationExplicit` (both memory and store modules spread
`{ ...oldCol, collation }`), so an explicit user demand ranks 'default' —
or 'declared' if the column happened to be created with a COLLATE clause,
since the spread inherits the flag; and because persisted DDL always emits
an explicit `COLLATE` for non-BINARY collations, a session-defaulted
collation reloads as 'declared' — rank 1 before a store reopen, rank 2
after. All flips are fail-louder (a silent resolution becomes a
prepare-time error, never silently different results), which bounds the
severity, but prepare errors appearing across a reopen is real instability.

**Explicitly found-nothing categories:** no correctness, type-safety,
resource-cleanup, or error-handling defects in the resolver or its call
sites (the module is pure; throwing wrappers carry AST location; eager
forcing adds no measurable prepare cost). No test gaps worth new tests in
this pass — the 06.4.4 matrix, the unit symmetry sweep, and the inverted
extractor spec cover happy path, conflicts both spellings, defaults
interplay, propagation, IN/BETWEEN/FK/USING, and the gate soundness cases;
the SET-COLLATE/reload provenance cases belong to the filed ticket. The
equi-pair-extractor comment about left-operand precedence in the merge/bloom
emitters remains accurate until `join-key-collation-resolution-alignment`
lands, so it was deliberately left untouched.
