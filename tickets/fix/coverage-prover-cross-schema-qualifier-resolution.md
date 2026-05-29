description: The coverage prover's qualifier-aware AST resolver ignores the schema part of a column reference, so in a cross-schema join body where the lookup table shares the base table's *name* (different schema), a schema-qualified `s2.t.col` in ORDER BY/WHERE can mis-resolve onto base `s1.t`'s same-named column and yield a false `Covers`. The removed bare-name collision guard previously rejected this case.
prereq: coverage-prover-qualified-name-resolution
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts
----

## Problem

`coverage-prover-qualified-name-resolution` made the body `ORDER BY` / `WHERE`
column resolution qualifier-aware (`makeBodyColumnResolver` + `columnRefParts` +
`collectBaseTableQualifiers`) and removed the former conservative bare-name
**collision guard** that rejected any join whose lookup side reused a UC (or
UC-predicate) column *name*.

The new resolver matches a qualified reference `alias.col` by the **table/alias
part only** — `columnRefParts` reads `ColumnExpr.table` but deliberately drops
`ColumnExpr.schema` (documented as "known gap #3: schema qualifier not separately
validated", matching the prior `columnIndexFromExpr` blind spot).
`collectBaseTableQualifiers` correctly excludes a different-schema same-named
table from `tQualifiers` (it checks `ts.table.schema` against
`baseTable.schemaName`), but because the *reference's* schema is discarded, a
schema-qualified reference whose **table name equals the base table's name**
still matches:

- Base table `s1.t` (unaliased) ⇒ `tQualifiers = { 't' }`.
- Body joins `s1.t` with a same-named lookup `s2.t` (different schema, valid 1:1
  lookup).
- `order by s2.t.uc_col` parses to `ColumnExpr{ name: 'uc_col', table: 't',
  schema: 's2' }`. `columnRefParts` returns `{ qualifier: 't', name: 'uc_col' }`
  (schema `s2` dropped) ⇒ `tQualifiers.has('t')` is true ⇒ resolves to **base
  `s1.t`'s `uc_col`**.

The MV is physically ordered by the *lookup* `s2.t.uc_col`, but the prover
believes it is ordered by base `T`'s UC column ⇒ a **false `Covers`** ⇒ the MV is
trusted as a row-time covering structure for the UNIQUE constraint and a point
lookup keyed on `s1.t`'s UC value reads the wrong rows / misses conflicts. The
same mis-resolution applies to a `WHERE s2.t.col …` conjunct.

This is a (theoretical) **soundness regression** relative to the removed guard:
the old guard rejected (`shape`) any join whose lookup-side column names collided
with the base UC column names, which covered the cross-schema same-name case
(the lookup `s2.t` exposes all of `T`'s column names). The qualifier-aware
resolver replaced that with table-name matching that is blind to the schema, so
the protection is lost for this specific shape.

## Reachability

Quereus supports multiple schemas (`main`, `temp`, attached) and schema-qualified
table references in FROM with a schema search path (see
`planner/building/schema-resolution.ts`, `schema/manager.ts`). Two same-named
tables in different schemas joined inside a materialized-view body is therefore
constructible in principle. The fix stage should **first confirm reachability**:
build an MV whose body joins `s1.t` to `s2.t` (same table name, different schema)
on a valid 1:1 lookup key and orders by `s2.t.<uc-col>`, then assert the prover
does **not** report `Covers`. If the binder/optimizer rejects such a body before
it reaches the prover (e.g. schema-path resolution forbids it, or the shape walk
already bails), document that and downgrade to a defense-in-depth hardening with
a unit test on `makeBodyColumnResolver` directly.

## Expected behavior

A reference whose schema qualifier denotes a table *other than* the base table
must resolve to `undefined` (⇒ `ordering-mismatch` / `predicate-entailment`),
never onto the base table's same-named column. Equivalently: qualifier matching
must consider the (schema, table) pair, not the table name alone.

## Fix direction (for the implementer to validate)

Thread the schema part through the resolver so qualifier matching is
(schema, table)-aware:
- `columnRefParts` should surface the column ref's schema alongside its table
  qualifier (instead of discarding it).
- `collectBaseTableQualifiers` / `makeBodyColumnResolver` should match a
  schema-qualified reference only when its schema equals the base table's schema
  (an *unqualified*-schema reference keeps today's table-name match, since that
  is resolved against the schema search path at plan time).

Keep the single-source and existing multi-source tests green (the resolver still
reduces to bare-name for single-source bodies). Add a positive cross-schema test
(reference correctly qualified to the base schema still covers) and the negative
test above.

## Out of scope

The other two documented "known gaps" from the implement ticket are **not** bugs
and need no ticket: conservative rejection of derived/function FROM sources
(completeness loss only) and the unqualified-ambiguity check trusting join-frame
names (defense-in-depth; a genuinely ambiguous bare reference is a plan-time
error). Leave them as documented limitations.
