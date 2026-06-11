description: OR-of-equalities collapse to IN is collation-blind — wrong query results (proven). `where b = 'bob' collate nocase or b = 'x' collate nocase` returns only BINARY matches because the IN it collapses to compares under the bare column's collation, dropping the disjuncts' NOCASE. Same family as ticket collation-blind-equality-fact-extraction (the folded-NOCASE-literal shape), at sites that ticket did not cover.
files:
  - packages/quereus/src/planner/analysis/predicate-normalizer.ts          # tryCollapseOrToIn — the proven wrong-results site
  - packages/quereus/src/planner/analysis/constraint-extractor.ts          # collapseBranchesToIn, tryCollapseToOrRange — same family, pushdown side
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # effectivePredicateCollation: OR sourceExpression resolves boolean operands → BINARY, defeating the collation-cover decline
  - packages/quereus/src/planner/analysis/comparison-collation.ts          # shared effective-collation helpers to reuse
  - packages/quereus/test/planner/collation-soundness.spec.ts              # natural home for regression tests
----

# OR-of-equalities → IN collapse changes the comparison collation

## Reproduced wrong results (at current HEAD)

```sql
create table t (b text primary key, y integer) using memory;
insert into t values ('Bob',1),('bob',2),('X',3),('x',4);
select y from t where b = 'bob' collate nocase or b = 'x' collate nocase;
-- returns y = [2,4]; canonical per-disjunct semantics (emitComparisonOp,
-- right-operand collation precedence → NOCASE) is [1,2,3,4]
```

The same query over a non-keyed column also returns [2,4], so this is not (only)
a seek bug — the collapse rewrites the *evaluated* predicate. The
single-disjunct control `where b = 'bob' collate nocase` correctly returns both
case variants, so each disjunct alone has NOCASE semantics; combining them with
OR silently flips to BINARY.

## Root cause

`tryCollapseOrToIn` (predicate-normalizer.ts) rewrites
`col = lit OR col = lit …` into `col IN (lits)` keyed purely on node shapes.
Constant folding collapses `'bob' COLLATE NOCASE` into a `LiteralNode` whose
*type* still carries `collationName: 'NOCASE'` (the load-bearing discovery of
ticket `collation-blind-equality-fact-extraction`), so the shape check passes —
but `emitIn` compares under the **condition operand's** collation (the bare
column → its declared collation), discarding each disjunct's effective
collation.

The rewrite is sound only when every disjunct's effective comparison collation
(per `effectiveComparisonCollation`, right ?? left ?? BINARY) **equals** the
collation the resulting IN will compare under (`effectiveInCollation` of the
column side — its declared collation). Note both failure directions:

- disjunct NOCASE over a BINARY-declared column → IN under-matches (the repro);
- disjunct BINARY (e.g. `b = 'x' collate binary`) over a NOCASE-declared
  column → IN over-matches.

## Sibling sites (same family, fix together)

- `collapseBranchesToIn` (constraint-extractor.ts): collapses OR branches'
  `=`/IN constraints into one IN **constraint** for pushdown/seeks, again
  shape-only. The collapsed constraint's `sourceExpression` is the OR
  `BinaryOpNode`, whose operands are boolean comparisons carrying no
  collation — so `effectivePredicateCollation` (rule-select-access-path)
  resolves it to BINARY and the access path's collation-cover decline never
  fires for it. A pushed IN seek then compares under the index collation while
  the written predicate meant something else.
- `tryCollapseToOrRange` (constraint-extractor.ts): an equality branch becomes
  a `>= v AND <= v` range spec; range seeks compare under index ordering.
  Same gate applies (the OR_RANGE constraint also carries the OR node as
  `sourceExpression`, hitting the same BINARY-defaulting cover analysis).

## Expected behavior

- A disjunct whose effective collation differs from the would-be IN/range
  comparison collation blocks the collapse (whole-OR residual, like the
  existing >32-values bail) — completeness loss only, never a semantics
  change.
- Matched-collation collapses keep working (plain `b='x' or b='y'`,
  and NOCASE-declared `b='x' or b='y'` where eff = declared on both sides).
- Regression tests: the repro above (both keyed and non-keyed spellings); a
  matched-collation control; the over-match direction (`collate binary`
  disjuncts over a NOCASE-declared column); and a pushdown-shape test
  confirming no IN/OR_RANGE seek strips the residual for mismatched
  collations.

## Notes

- Pre-existing at the implement commit of
  `collation-blind-equality-fact-extraction` (predicate-normalizer.ts last
  touched by unrelated tickets); discovered during its review pass.
- The covered-key path is NOT exposed via this hole today: collapsed INs have
  ≥2 values (singleton INs only arise from genuine `IN (x)` spellings), and
  OR_RANGE constraints never count as covering equalities.
