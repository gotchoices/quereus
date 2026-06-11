description: Confirmed soundness bug — plan-time equality facts (constant pins, col=col mirrors/ECs, constant bindings, guard-discharge facts) are extracted with no regard for the comparison's effective collation. A NOCASE comparison over a BINARY-keyed column produces false ≤1-row / key claims with observable wrong results (ORDER BY elided, DISTINCT eliminated, partial-unique guard discharged out of scope). Gate the extraction on effective comparison collation; pin the sound-by-accident invariants; extend the Key Soundness net with collation shapes.
files:
  - packages/quereus/src/planner/util/fd-utils.ts                          # extractEqualityFds, buildPredicateFacts, constantValueOf, literalSqlValueOf
  - packages/quereus/src/planner/nodes/filter.ts                           # consumer: pins fold + guard activation + covered-key detection
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts  # consumer: constant bindings across EC peers
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation — extract into shared helper
  - packages/quereus/src/runtime/emit/binary.ts                            # emitComparisonOp — the runtime resolution the helper must mirror
  - packages/quereus/src/planner/util/key-utils.ts                         # join equi-pair / key coverage (sound-by-accident; pin + gate)
  - packages/quereus/src/planner/nodes/join-utils.ts                       # join EC addition from equi-pairs
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # unwrapCast deliberately NOT collate-stripping — pin
  - packages/quereus/src/planner/nodes/scalar.ts                           # CollateNode deliberately NOT injective — pin
  - packages/quereus/test/property.spec.ts                                 # Key Soundness net: zoo + collation-aware tupleSig
  - docs/optimizer.md                                                      # FD tracking section; guard-discharge paragraph
----

# Collation-blind equality-fact extraction (reproduced soundness bug)

## What was reproduced (fix-stage findings, ticket `collation-weakening-key-claims`)

Seed: `create table t4 (b text, x integer, y integer, primary key (b, x))` with
rows `('Bob',1,10), ('bob',1,20)`.

1. **False ≤1-row claim.** `select * from t4 where b = 'bob' collate nocase and x = 1`
   returns 2 rows, but `keysOf(root)` = `[[]]` and `isAtMostOneRow(root)` = true.
   Mechanism: `extractEqualityFds` emits `∅ → b` / `∅ → x` constant pins via
   `constantValueOf`, which **strips `CollateNode`**; the closure plus the PK
   unique witness `{b,x}` derives the empty key. The comparison actually runs
   NOCASE (right-operand collation precedence, `emitComparisonOp`), so passing
   rows are *not* value-equal on `b`.
2. **ORDER BY elided → wrong order.** `select y from t4 where b = 'bob' collate
   nocase and x = 1 order by y desc` returns `[10, 20]` (plan has no sort node).
3. **DISTINCT eliminated → duplicates survive.** With rows `('Bob',1,10),
   ('bob',1,10)`: `select distinct y from t4 where b = 'bob' collate nocase and
   x = 1` returns `[{y:10},{y:10}]`.
4. **Partial-unique guard discharged out of scope.** With
   `create unique index ui on t10 (x) where b = 'bob'` and rows
   `(1,1,'bob'), (2,1,'Bob')`: `select x, id from t10 where b = 'bob' collate
   nocase` claims key `{x}` (`keysOf` includes `[0]`) while the result has
   `x = 1` twice. Mechanism: `buildPredicateFacts.literalSqlValueOf` also strips
   `CollateNode`, so the `eq-literal{b,'bob'}` guard discharges for a filter
   that admits rows *outside* the partial-index scope.

The same family is **sound by accident** at three other sites — the accident
must be pinned so a later "obvious improvement" doesn't open the hole:

- **Project**: `CollateNode` does not override `isInjectiveIn` (default
  not-injective), so `select b collate nocase as b from t` drops out of
  `deriveProjectionColumnMap` → no key propagates → DISTINCT above it survives
  and correctly dedups NOCASE. Adding the "obvious" injectivity passthrough to
  `CollateNode` (it *is* value-injective) would let a BINARY-minted key land on
  a NOCASE-published column, which consumers (DISTINCT emitter resolves each
  attr's collation; MV backing PK uses output collation) interpret under the
  *output* collation — unsound. Any future enablement needs a
  collation-strength gate at the key-propagation site (output collation at
  least as fine as the source key's enforcement collation).
- **Seek / covered-key extraction**: `constraint-extractor.ts`'s `unwrapCast`
  unwraps `CastNode` only, never `CollateNode` — so a collate-wrapped literal
  never becomes a seek constraint or a covered-key witness (correct results
  verified). The covered-key path in `filter.ts` is therefore sound: a
  recognized `col = lit` comparison's effective collation always equals the
  column's declared collation, which is the key's enforcement collation.
- **Join equi-pairs**: `l.x = r.b collate nocase` is not recognized as an
  equi-pair (CollateNode is not a `ColumnReferenceNode`), so keys combine as a
  cross product — sound. Declared-collation joins are sound because the
  effective comparison collation equals the keyed column's enforcement
  collation. Pin both with tests.

Sound declared-collation cases (keep working): a NOCASE-declared column with a
plain literal pin (`where b = 'bob'`) genuinely implies ≤1 row when the pinned
columns cover a key *enforced under that same collation* (verified) — that
fact flows through the covered-key detection path, which stays.

## Soundness rule

An equality conjunct yields a **value-level** fact only when the comparison's
effective collation is value-discriminating for the operands' logical type:

- non-textual operands: always (collation does not apply);
- textual operands: effective comparison collation must be `BINARY`.

For **guard discharge** (`buildPredicateFacts` facts consumed by
`predicateImpliesGuard`), the slightly wider gate is sound: effective collation
`BINARY` **or equal to the column's declared collation** (the guard predicate
is evaluated under the column's declared collation at index-maintenance time,
so matching-collation discharge keeps filter-rows ⊆ scope-rows; the strict
`sqlValueEquals` literal match already under-claims on case-different
literals). Implement the wider gate if cheap; the BINARY-only gate is an
acceptable conservative fallback (document the completeness loss).

Effective comparison collation must be resolved **exactly as the runtime
does** (`emitComparisonOp`: right operand's collation, else left's, else
BINARY; `emitIn`: condition operand; BETWEEN: per-bound). The access-path rule
already has this in `effectivePredicateCollation`
(rule-select-access-path.ts) — extract it into a shared analysis helper (e.g.
`planner/analysis/comparison-collation.ts`) and use it from both sites so
plan-time facts and runtime behavior cannot drift.

## Consequences to verify

- The Filter covered-key detection (`filter.ts` `extractConstraints` branch)
  still provides ≤1-row for `where b = 'bob' and x = 1` over a NOCASE-declared
  PK — the pins are gated away but that path is independent and sound.
- `rule-predicate-inference-equivalence` stops inferring `peer = lit` from a
  collation-coarse pin (it consumes `extractEqualityFds` bindings — fixed at
  the source).
- `attributeDefaults` through filtered views: a collate-wrapped pin no longer
  contributes an insert default. Behavior change is acceptable (the previous
  value was not actually pinned).
- Join EC addition (`join-utils.ts`) and join key coverage
  (`key-utils.ts` `joinPairsCoverKey` / `analyzeJoinKeyCoverage`): apply the
  same gate to equi-pair recognition if/where pairs can carry a non-BINARY
  effective comparison over textual operands (today they cannot via collate
  wrappers — pin that; gate if declared-collation asymmetry can produce a
  comparison coarser than the covered key's enforcement collation).

## Key Soundness net extension

`test/property.spec.ts` § Key Soundness: the zoo is integer-only and `tupleSig`
is value-based, so this whole class was invisible.

- Add TEXT-bearing tables with mixed-case data and zoo shapes with
  `collate nocase` projections, collate-wrapped filter pins, collated
  equi-joins, and partial-unique + collated-discharge.
- Make the checker collation-aware: a claimed key must be distinct under each
  key column's **output collation** (fold NOCASE → lower-case, RTRIM → trim-end
  per `tupleSig` column), since consumers (DISTINCT emitter, MV backing PK)
  compare under output collations. The value-based check stays for `isSet`.

## Docs

- `docs/optimizer.md` FD-tracking section: document the value-discriminating
  gate on equality-fact extraction and the pinned non-injectivity of
  `CollateNode`.
- The guard-discharge paragraph (~line 1674) currently lists "collation-aware
  text bound comparison" as out of scope — update for the new gate.

## TODO

- Extract `effectivePredicateCollation` into a shared plan-time helper mirroring `emitComparisonOp`/`emitIn`/BETWEEN resolution; reuse from rule-select-access-path
- Gate `extractEqualityFds` (FDs, equiv pairs, constant bindings) per conjunct on value-discriminating effective collation
- Gate `buildPredicateFacts` (`literalEqs`, `columnEqs`, `inListEqs`, `rangeBounds`) — BINARY or declared-collation-match for textual operands
- Audit join equi-pair extraction / key coverage for the same gate; pin the collate-wrapper exclusion with tests
- Regression tests for repro shapes 1–4 (false ≤1-row, elided ORDER BY, eliminated DISTINCT, out-of-scope guard discharge) and the sound declared-collation controls
- Pin sound-by-accident invariants: CollateNode non-injectivity (unit test + comment), constraint-extractor `unwrapCast` not collate-stripping (comment + seek-correctness test, e.g. `where b = 'x' collate nocase` over BINARY PK returns case-variants)
- Extend Key Soundness net: collation-bearing zoo shapes + collation-aware key-distinctness check
- Update docs/optimizer.md (FD tracking + guard discharge)
- Run `yarn test` and lint
