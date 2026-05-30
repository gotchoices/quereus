description: Harden the coverage prover's qualifier-aware AST resolver to be (schema, table)-aware. Today `columnRefParts` drops `ColumnExpr.schema`, so a schema-qualified body ORDER BY / WHERE reference whose *table name* equals the base table's name (different schema) mis-resolves onto the base table's same-named column and yields a false `Covers`. Reachability research (below) shows the binder rejects all 3-part `schema.table.column` references before the prover runs, so this is a **defense-in-depth** hardening with a direct (hand-built-AST) unit test, not a SQL-reachable regression.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts
----

## Summary

`makeBodyColumnResolver` (in `coverage-prover.ts`) resolves an AST `ORDER BY` /
`WHERE` column reference to a base-table `T` column by matching the reference's
**table/alias qualifier** against `tQualifiers` (the FROM-clause names that denote
`T`). The helper `columnRefParts` deliberately **discards** `ColumnExpr.schema`
(documented as a known gap, mirroring the prior `columnIndexFromExpr` blind
spot). Consequently a schema-qualified reference `s2.t.uc` collapses to
`{ qualifier: 't', name: 'uc' }`; if the *base* table `s1.t` is unaliased its
qualifier is also `'t'`, so the lookup-schema reference matches base `T` and the
prover believes the body is ordered by base `T`'s UC column when it is physically
ordered by the *lookup* `s2.t`'s same-named column ⇒ a false `Covers`.

`collectBaseTableQualifiers` already does the right thing on the FROM side (it
only treats a `TableSource` as `T` when `ts.table.schema` is absent or equals
`baseTable.schemaName`); the gap is purely that the *reference's* schema is
thrown away, so qualifier matching is table-name-only and blind to schema.

## Reachability finding (research done in the fix stage)

The cross-schema scenario the original ticket describes is **not reachable via
SQL**. Quereus's binder does not resolve 3-part `schema.table.column` column
references against FROM sources at all:

- `RegisteredScope` (`planner/scopes/registered.ts`) registers only bare column
  names (`lk`, `uc`, …) for a table source.
- `AliasedScope.resolveSymbol` (`planner/scopes/aliased.ts`) for a 3-part key
  `schema.table.col` checks only `parts[1] === alias`, rewrites `parts[1]` to the
  parent scope name (equal to the table name for a regular source), and delegates
  the still-3-part key `schema.table.col` to the `RegisteredScope`, which has no
  such key. So it returns `undefined`.
- `resolveColumn` (`planner/resolve.ts`) then throws `"<schema>.<table>.<col>
  isn't a column"`.

Empirically (fix-stage probes, base `main.t` + lookup `s2.t`, both named `t`):

| body fragment                                   | result                         |
|-------------------------------------------------|--------------------------------|
| `select s2.t.uc from s2.t`                      | ERR: `s2.t.uc isn't a column`  |
| `select main.t.uc from t`                       | ERR: `main.t.uc isn't a column`|
| `… on t.lkref = s2.t.pkid …`                    | ERR: `s2.t.pkid isn't a column`|
| `… order by s2.t.uc`                            | ERR: `s2.t.uc isn't a column`  |
| `… order by uc`  (bare, both have `uc`)         | plans OK → resolves to **base** `T.uc` (output column / first-match) |
| `… order by t.uc` (qualifier shared by both)    | plans OK → resolves to **base** `T.uc` (MultiScope first-match = left = base) |

So **every** 3-part schema-qualified column reference is rejected before the
prover runs, and the two reachable orderings both resolve to base `T`'s column
(a genuine cover, not a false one). A body carrying `order by s2.t.uc` /
`where s2.t.col` can therefore never reach `proveCoverage`, and a real
materialized view can only be created from a body that plans.

**Conclusion:** downgrade from a SQL-level regression to a defense-in-depth
hardening, exactly as the fix ticket's "Reachability" section instructed. The
latent defect is nonetheless real and reproduces by feeding `proveCoverage` a
hand-built `selectAst` whose ORDER BY term is a 3-part `ColumnExpr` (the prover
reads `mv.selectAst` directly, so it does not re-bind):

```
schema = 's2'  (lookup) ⇒ {covers: true}   ← BUG (should be ordering-mismatch)
schema = 'main'(base)   ⇒ {covers: true}   ← correct
schema =  undefined     ⇒ {covers: true}   ← correct (today's reachable behavior)
```

## Fix direction

Thread the reference's schema through the resolver and match the
**(schema, table)** pair instead of the table name alone:

- `columnRefParts` — surface the column ref's schema alongside its table
  qualifier instead of dropping it:
  `{ schema?: string; qualifier?: string; name: string }`. (Keep lowercasing.)
  Note the existing `identifier` branch already rejects a schema-qualified
  identifier; only the `column` branch leaks the schema today.
- `makeBodyColumnResolver` — for a qualified reference, when `ref.schema` is
  present, match `T` only if `ref.schema === baseTable.schemaName` **and**
  `tQualifiers.has(ref.qualifier)`; when `ref.schema` is absent, keep today's
  table-name match (the unqualified-schema case is resolved against the schema
  search path at plan time, so a bare `t.col` still denotes `T`). A reference
  whose schema denotes a different schema resolves to `undefined`.

This leaves the unqualified and 2-part reachable paths byte-for-byte unchanged
(all existing single-source and multi-source join tests stay green) and only
narrows the 3-part case that SQL cannot currently produce.

Optional consistency note (do **not** expand scope): `columnIndexFromExpr` /
`predicate-shape.ts` share the same documented schema blind spot. The fix ticket
scopes this change to the coverage-prover resolver only; if the implementer finds
the shared `ColumnIndexResolver` contract makes a parallel one-line hardening
trivial and risk-free, mention it in the review handoff rather than silently
widening the diff.

## Out of scope

- The broader binder limitation that *no* 3-part `schema.table.column` reference
  resolves in expression context (even single-source, even matching the default
  schema). That is a separate, pre-existing limitation — note it in the review
  handoff but do not fix it here.
- The other two documented "known gaps" (conservative rejection of
  derived/function FROM sources; the unqualified-ambiguity check trusting
  join-frame names) — completeness/defense-in-depth only, no change.

## TODO

- Extend `columnRefParts` to return the (lowercased) `schema` of a `ColumnExpr`
  alongside `qualifier`/`name`; update its doc comment (drop the "schema
  qualifier is dropped / known gap #3" wording).
- Update `makeBodyColumnResolver` so a qualified reference with a present schema
  matches `T` only when `ref.schema === baseTable.schemaName` (in addition to the
  existing `tQualifiers.has(qualifier)` check); unqualified-schema and bare
  references keep current behavior.
- Update the module doc / inline comments in `coverage-prover.ts` to state that
  qualifier matching is now (schema, table)-aware and that the SQL-level
  cross-schema collision is unreachable (binder rejects 3-part column refs), so
  this guard is defense-in-depth.
- Add a direct unit test in `test/covering-structure.spec.ts` (a new `describe`
  near the multi-source join suite): build the plannable join body
  `select t.uc, t.id from t left join s2.t on lkref = pkid order by uc`
  (base `main.t (id pk, uc not null, lkref not null, unique(uc))`, lookup
  `s2.t (pkid pk, uc not null)`; create schema `s2` via
  `db.schemaManager.addSchema('s2')`), plan it for `root`, then call
  `proveCoverage` with a `selectAst` whose single ORDER BY term is a hand-built
  `{ type: 'column', name: 'uc', table: 't', schema }` `ColumnExpr`:
    - `schema: 's2'`  ⇒ expect `covers: false`, `reason: 'ordering-mismatch'` (the fix);
    - `schema: 'main'`⇒ expect `covers: true` (positive cross-schema: correctly
      qualified to the base schema still covers);
    - `schema: undefined` ⇒ expect `covers: true` (reachable bare/2-part path
      unchanged — regression floor).
  Document in the test that the 3-part reference is hand-built because the binder
  rejects it, so the path is exercised at the prover boundary only.
- Run `yarn workspace @quereus/quereus run build` (typecheck) and the focused
  suite (`node packages/quereus/test-runner.mjs --grep 'coverage prover'`), then
  the full `yarn test`, before handing off to review.
