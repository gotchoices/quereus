description: Gate the OR-of-equalities → IN / OR_RANGE collapses on matching effective collation — wrong query results (reproduced at HEAD). `where b = 'bob' collate nocase or b = 'x' collate nocase` returns only BINARY matches because the collapse rewrites the evaluated predicate into an IN that compares under the bare column's collation.
files:
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts          # tryCollapseOrToIn — the evaluated-predicate site (gate here fixes wrong results)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # tryExtractOrBranches / collapseBranchesToIn / tryCollapseToOrRange — pushdown side; columnSideOf + equalityConstraintCollationOk (~line 985-1032) are the pattern to mirror
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # effectiveComparisonCollation / effectiveInCollation / effectiveBetweenBoundCollation / operandCollation — reuse, do not re-derive
  - packages/quereus/test/planner/collation-soundness.spec.ts              # add SQL regression block (verified repros + expected values below)
  - packages/quereus/test/planner/constraint-extractor.spec.ts             # add unit tests for the extractor gate (helpers at top of file)
  - docs/optimizer.md                                                      # "Collation gate on equality facts" section (~line 1420) — add the OR-collapse bullet
difficulty: hard
----

# Gate OR→IN / OR→OR_RANGE collapse on matching effective collation

## Reproduced and confirmed at HEAD (fix-stage findings)

A temporary spec (since deleted) confirmed all three failure shapes:

```sql
create table t (b text primary key, y integer) using memory;
insert into t values ('Bob',1),('bob',2),('X',3),('x',4);
select y from t where b = 'bob' collate nocase or b = 'x' collate nocase order by y;
-- actual [2,4]; correct per-disjunct semantics (emitComparisonOp, right-operand
-- collation precedence → NOCASE) is [1,2,3,4]
```

- Same wrong result over a **non-keyed** column (`create table t2 (id integer
  primary key, b text, y integer)`) — proving the *evaluated* predicate is
  rewritten, not just a seek.
- **Over-match direction**: `b = 'bob' collate binary or b = 'x' collate binary`
  over a NOCASE-declared PK with rows ('Bob',1),('X',3) returns [1,3]; correct
  is [] (BINARY comparison matches neither case-variant).
- Controls pass today and must keep passing: single NOCASE disjunct alone;
  plain `b='bob' or b='x'` over both BINARY- and NOCASE-declared columns
  (eff = declared on every disjunct → collapse stays).
- `b = 'bob' collate nocase or b > 'z'` (OR_RANGE shape, non-indexed column)
  happens to pass today only because no seek consumes the constraint and the
  residual OR still evaluates — the extractor-side hole is real but currently
  shielded by residual re-application; gate it anyway (see soundness argument
  below).

## Root cause

Constant folding collapses `'bob' COLLATE NOCASE` into a `LiteralNode` whose
*type* still carries `collationName: 'NOCASE'` (`LiteralNode.explicitType`,
scalar.ts ~line 346 — the load-bearing discovery of ticket
`collation-blind-equality-fact-extraction`). Shape-only collapse checks
therefore pass, but:

- `tryCollapseOrToIn` (predicate-normalizer.ts ~line 196) rewrites
  `col = lit OR col = lit …` into `col IN (lits)`; `emitIn` compares under the
  **condition operand's** collation (bare column → declared), discarding each
  disjunct's effective collation. `normalizePredicate` runs in
  rule-predicate-pushdown, FilterNode/JoinNode `getPredicates`,
  rule-grow-retrieve, etc. — the rewritten IN is what gets *evaluated*.
- `tryExtractOrBranches` (constraint-extractor.ts ~line 622) →
  `collapseBranchesToIn` / `tryCollapseToOrRange` mint IN / OR_RANGE
  **constraints** for pushdown/seeks the same shape-only way. The collapsed
  constraint's `sourceExpression` is the OR `BinaryOpNode`, whose operands are
  boolean comparisons carrying no collation — so `effectivePredicateCollation`
  (rule-select-access-path.ts ~line 1216) resolves it to BINARY and the
  collation-cover decline never fires for the true mismatch. A consumed IN seek
  would then compare under the index collation while the written predicate
  meant something else.

## Soundness rule

A collapse is sound only when **every** disjunct's effective comparison
collation (per `effectiveComparisonCollation` — right ?? left ?? BINARY, in
*written* operand order) **equals** the collation the collapsed form compares
under: the column operand's own collation (`effectiveInCollation` for IN;
index ordering = declared collation for OR_RANGE specs). Both directions fail
otherwise (under-match: NOCASE disjunct over BINARY column; over-match: BINARY
disjunct over NOCASE column). On mismatch, decline the **whole** collapse —
the OR stays residual, exactly like the existing >32-values bail: a
completeness/performance loss only, never a semantics change.

Plain literals carry no collation, so eff = the column's collation and
matched-collation collapses keep working unchanged (including plain disjuncts
over NOCASE-declared columns).

## TODO

Gates
- [ ] `predicate-normalizer.ts` `tryCollapseOrToIn`: for each disjunct compute
      `effectiveComparisonCollation(b.left, b.right)` (written order — the
      `lit = col` pattern resolves the literal as the *right*-precedence
      operand only when it is written on the right) and compare with
      `effectiveInCollation(col)` for that disjunct's column reference; any
      mismatch → `return null`. Import from `./comparison-collation.js`.
- [ ] `constraint-extractor.ts`: add a branch-constraint collation gate and
      apply it in `tryExtractOrBranches` to every branch constraint **before
      both Case 1 (collapseBranchesToIn) and Case 2 (tryCollapseToOrRange)**
      (one pre-gate covers both — both collapsed forms compare under the
      column's collation); any failure → `return null` (whole OR residual).
      Per `sourceExpression` shape:
      - `BinaryOpNode` (`=`, ranges): eff = `effectiveComparisonCollation(src.left, src.right)`;
        target = `operandCollation(columnSideOf(src, c.attributeId))` (reuse
        the existing `columnSideOf` helper, ~line 985); fail when the column
        side cannot be located.
      - `InNode` (minted only by `extractInConstraint`, condition is a bare
        `ColumnReferenceNode`): `effectiveInCollation(condition)` IS the
        column's collation — always passes; keep the check explicit or
        document why it is vacuous.
      - `BetweenNode` (branch of 2 constraints sharing one source): both
        `effectiveBetweenBoundCollation(expr, lower)` and `(expr, upper)` must
        equal `operandCollation(expr)`.
      - Any other shape → fail (conservative; note this is the *opposite*
        polarity of `equalityConstraintCollationOk`'s permissive fallback,
        because here permissive = wrong results, and also note that
        eff === 'BINARY' alone is NOT sufficient here — the over-match
        direction needs eff === declared).
- [ ] Note for the reviewer in code comments: `effectivePredicateCollation`
      (rule-select-access-path) still resolves an OR `sourceExpression` to
      BINARY, but post-gate every surviving collapsed constraint's true
      collation equals the column's declared collation, so the cover analysis
      is at worst conservative (BINARY-vs-NOCASE-index → COARSER_SAFE keeps
      the semantically-correct OR residual; ranges decline). Making it precise
      (e.g. carrying the resolved collation on the constraint) is an optional
      follow-up, not required for correctness — do NOT regress matched
      collapses to fix it here.

Tests (regression block in collation-soundness.spec.ts — all expected values verified at HEAD)
- [ ] Keyed under-match: `t (b text primary key, y integer)` rows
      ('Bob',1),('bob',2),('X',3),('x',4);
      `where b='bob' collate nocase or b='x' collate nocase` → y [1,2,3,4].
- [ ] Non-keyed spelling (separate integer PK, `b text` plain) → same [1,2,3,4].
- [ ] Over-match: `t (b text collate nocase primary key, y integer)` rows
      ('Bob',1),('X',3); `where b='bob' collate binary or b='x' collate binary`
      → [] (currently returns [1,3]).
- [ ] Matched controls: plain disjuncts over plain column → [2,4]; plain
      disjuncts over NOCASE-declared column rows ('Bob',1),('X',3) → [1,3];
      single NOCASE disjunct → both case-variants.
- [ ] OR_RANGE shape: `where b='bob' collate nocase or b>'z'` over plain
      non-keyed `b` with rows ('Bob',1),('bob',2),('zz',3) → [1,2,3] (passes
      today; pins that the gate doesn't break it and that no future seek
      consumption changes it).
- [ ] Unit tests in constraint-extractor.spec.ts (helpers at top of file;
      build the folded-NOCASE literal via `new LiteralNode(scope, expr,
      explicitType)` with `collationName: 'NOCASE'`, and a TEXT-typed
      `colRef` variant with/without `collationName` — the existing `colRef`
      helper is INTEGER-typed):
      pushdown-shape assertions that mismatched-collation ORs produce **no**
      IN/OR_RANGE constraint and a residualPredicate (this is the
      "no seek strips the residual" guarantee at its source), for both the
      eq→IN and eq-as-range→OR_RANGE cases, plus matched-collation collapses
      still firing (existing tests cover plain shapes; add a NOCASE-declared
      column + NOCASE-literal matched case).
- [ ] `yarn test` (root), `yarn workspace @quereus/quereus run lint`, and
      `tsc --noEmit` (typecheck script) clean.

Docs
- [ ] Add a bullet to docs/optimizer.md § "Collation gate on equality facts"
      (~line 1420) covering the OR-collapse gate: both the normalizer
      (evaluated-predicate) and constraint-extractor (pushdown) collapse sites
      require every disjunct's effective collation to equal the column-side
      collation the collapsed IN/OR_RANGE compares under; mismatch leaves the
      OR residual.

## Notes

- Pre-existing at the implement commit of
  `collation-blind-equality-fact-extraction`; discovered during its review.
- Non-textual operands make collation inert (`isValueDiscriminatingEquality`'s
  escape); the name-equality gate above blocks contrived shapes like
  `x = 5 collate nocase or x = 6` over an integer column. That completeness
  loss is acceptable — do not widen the gate with textuality reasoning unless
  it falls out trivially from exported helpers.
- The covered-key path is NOT exposed via this hole today: collapsed INs have
  ≥2 values (singleton INs only arise from genuine `IN (x)` spellings), and
  OR_RANGE constraints never count as covering equalities.
