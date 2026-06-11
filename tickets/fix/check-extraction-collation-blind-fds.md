description: CHECK-constraint FD extraction is collation-blind — proven false ≤1-row claim. `check (b = c collate nocase)` is enforced under NOCASE (verified) but check-extraction mints a value-level determination FD from it at AST level; closure then covers a BINARY unique key and isAtMostOneRow returns true over a 2-row result. Same family as ticket collation-blind-equality-fact-extraction — producer site #7, missed by that ticket.
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts        # handleEquality + recognizeGuardedBody — AST-level, no collation gate
  - packages/quereus/src/planner/analysis/comparison-collation.ts    # gate semantics to mirror (schema-level variant needed — AST has no types)
  - packages/quereus/src/runtime/emit/constraint-check.ts            # establish what collation CHECK enforcement actually resolves
  - packages/quereus/test/planner/collation-soundness.spec.ts        # regression home
  - packages/quereus/test/optimizer/conditional-fds.spec.ts          # unit tests for extraction gating
----

# CHECK equality bodies mint value-level FDs without a collation gate

## Reproduced over-claim (at current HEAD)

```sql
create table t (id integer primary key, b text unique, c text,
                check (b = c collate nocase)) using memory;
insert into t values (1,'x','X');  -- ACCEPTED: enforcement honors the COLLATE (verified)
insert into t values (2,'X','X');  -- accepted
select * from t where c = 'X';     -- returns 2 rows
```

`isAtMostOneRow` on that plan returns **true**. Chain: `handleEquality`
(check-extraction.ts) sees `b = <expr>`; the collate-wrapped side is not a
bare column, so `collectColumnNames` reduces it to `{c}` and a determination
FD `c → b` is minted. The filter pins `c` (BINARY, sound), closure adds `b`
via the FD, the unique key `{b}` is covered → false ≤1-row claim. But the
CHECK is *enforced* under NOCASE, so two rows with BINARY-equal `c` may carry
BINARY-distinct `b` — `c → b` is not a value-level fact.

The guarded twin (`recognizeGuardedBody`, implication-form CHECKs) has the
same shape-only recognition, including the `valueEquality: true` tag on
`col1 = col2` mirror pairs that `FilterNode` activation lifts into an EC —
a stronger (value-equality) claim with the same blindness.

## The enforcement question (resolve first)

Empirically at HEAD:

- `check (b = c collate nocase)` — enforcement **honors** the wrapper
  (accepts a NOCASE-equal, BINARY-distinct pair).
- `check (b = c)` with `c text collate nocase` — enforcement compared
  **BINARY** (rejected 'Bob' = 'bob'), i.e. the declared column collation does
  NOT reach the compiled CHECK comparison.

That second behavior makes today's bare `col1 = col2` facts sound *by
accident* — and it may itself be a conformance bug (SQLite resolves CHECK
comparisons with the column's declared collation). Decide the intended
enforcement semantics first; the extraction gate must mirror whatever
enforcement actually does (the plan-time fact and the runtime enforcement
must agree — see the mirroring discipline in
`planner/analysis/comparison-collation.ts`). Note: if enforcement is later
changed to honor declared collations, the bare col=col facts become unsound
without a gate — so gate on the *resolved* enforcement collation, not on
today's accident, and pin enforcement behavior with tests either way.

## Expected behavior

- A CHECK equality body (or implication body) mints value-level FDs /
  `valueEquality` mirrors / ∅→col pins only when its enforcement comparison is
  value-discriminating for the operand types (BINARY for textual operands —
  the `isValueDiscriminatingEquality` rule, evaluated against schema column
  collations and any COLLATE wrappers in the AST, since extraction runs on
  AST + TableSchema, not typed plan nodes).
- Gated-away bodies are a completeness loss only (no FD), never a semantics
  change.
- Guard-clause recognition (`eq-literal` / `range` antecedents) should be
  audited with the same lens: a guard *scope* containing a COLLATE wrapper is
  currently not parsed (verify and pin), and discharge soundness leans on the
  scope being evaluated under the declared collation
  (`buildPredicateFacts` gate assumption — see fd-utils.ts).
- Regression tests: the repro above; bare col=col over NOCASE-declared
  columns (pin whichever enforcement semantics is decided); the guarded
  `valueEquality` EC-lift shape.

## Notes

- Pre-existing at the implement commit of
  `collation-blind-equality-fact-extraction`; discovered during its review
  pass. That ticket's gates (filter conjuncts, covered keys, join pairs,
  guard discharge, index promotion) are all downstream of typed plan nodes;
  this producer runs on raw AST at schema level and was not in its site list.
