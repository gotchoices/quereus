description: Pre-existing runtime crash — a same-table column-to-column equality whose column side is seekable against a key (`where b = c` with PK on b) throws "No row context found for column c" at runtime. The constraint extractor mints an op-'=' constraint with bindingKind 'expression' and valueExpr = the same-table column reference; the access path appears to consume it as a seek key whose value expression is then emitted outside any row context. Discovered during the collation-blind-equality-fact-extraction implement pass; unrelated to collations (reproduces with plain BINARY text columns at HEAD).
difficulty: easy
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # extractBinaryConstraint: col = same-table col ⇒ bindingKind 'expression', correlated false
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # consumes '=' constraints for seeks — likely treats the expression binding as a bindable seek value
  - packages/quereus/src/runtime/context-helpers.ts                 # resolveAttribute — where the crash surfaces
----

# Same-table `col = col` equality planned as a seek crashes at runtime

## Repro (memory module, fails at current HEAD)

```sql
create table t14 (b text primary key, c text);
insert into t14 values ('u','u');
select * from t14 where b = c;
-- QuereusError: No row context found for column c. The column reference must be
-- evaluated within the context of its source relation.
```

Also reproduces with a composite key once the remaining key columns are pinned:

```sql
create table t8 (b text, c text, x integer, primary key (b, x));
select * from t8 where b = c and x = 1;   -- crashes
select * from t8 where b = c;             -- OK (b alone not seekable) — returns correct rows
```

## Expected behavior

`b = c` over the same table is a per-row predicate; it can never be a seek key
(the "value" varies per row of the same relation). The query should fall back
to a scan with `b = c` as a residual/filter and return the matching rows.

## Mechanism (research so far)

`extractBinaryConstraint` recognizes `b = c` as a constraint on `b` with
`op: '='`, `bindingKind: 'expression'`, `valueExpr` = the `c` column reference,
and `correlated: false` (the free-reference walk only flags columns *outside*
the constrained table — `c` is inside it). Downstream, the access-path rule
appears to accept the constraint as a seekable equality on the key column and
emits the seek's value expression standalone, where `c` has no row context.

Note for the fix: `computeCoveredKeysForConstraints` also counts this
constraint's column into `eqCols` (it only skips `correlated`), so
`where b = c and x = 1` over PK (b,x) additionally claims a covered key /
≤1-row — worth verifying and fixing with the same "same-table expression
bindings don't pin" distinction. (Two rows `('u','u',1)`, `('v','v',1)` both
pass the filter, so a ≤1-row claim there would be an over-claim; currently
masked by the crash.)

## Acceptance

- Both repro queries return their correct rows (2 rows for the t8 shape with
  matching b=c values; 1 row for t14).
- A same-table `col = col` conjunct never produces a seek constraint binding.
- Covered-key detection does not count same-table expression-bound equalities
  as pinning the column (verify `keysOf` makes no ≤1-row claim for the t8
  shape).
