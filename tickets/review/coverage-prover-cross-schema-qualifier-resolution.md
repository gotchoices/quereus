description: Review the (schema, table)-aware hardening of the coverage prover's qualifier-aware AST resolver. The resolver no longer drops `ColumnExpr.schema`, so a schema-qualified ORDER BY / WHERE term whose *table* name collides with the base table's (different schema) can no longer mis-resolve onto the base table's same-named column and yield a false `Covers`. Defense-in-depth (SQL cannot currently produce a 3-part column ref — see Reachability); the guard is exercised by a hand-built-AST unit test at the prover boundary.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts
----

## What changed

Two small, localized edits to `coverage-prover.ts`, plus a doc update and a new
unit-test `describe`:

- **`columnRefParts`** now returns `{ schema?, qualifier?, name }` (all
  lowercased) instead of `{ qualifier?, name }`. The `ColumnExpr.schema` qualifier
  is **surfaced** instead of dropped. The `IdentifierExpr` branch is unchanged
  (still rejects a schema-qualified identifier). Doc comment rewritten (the old
  "schema qualifier is dropped / known gap" wording is gone).

- **`makeBodyColumnResolver`** is now **(schema, table)-aware**. For a *qualified*
  reference:
    - if `ref.schema` is **present**, it must equal `baseTable.schemaName`
      (lowercased) — otherwise the resolver returns `undefined`;
    - then the existing `tQualifiers.has(ref.qualifier)` check applies as before.
  An *absent* `ref.schema` keeps today's table-name-only match (the bare qualifier
  is resolved against the schema search path at plan time, so `t.col` still denotes
  `T`). Unqualified (bare-name) resolution is byte-for-byte unchanged.

- **Module doc** gained a "Cross-schema qualifier resolution is (schema, table)-aware"
  paragraph documenting the guard and stating it is **defense-in-depth** because the
  binder rejects every 3-part `schema.table.column` reference before the prover runs.

Net effect: the unqualified and 2-part-qualified reachable paths are unchanged
(all prior single-source and multi-source join tests stay green); only the 3-part
case — which SQL cannot currently produce — is narrowed.

## Why (latent defect)

`makeBodyColumnResolver` resolves an AST ORDER BY / WHERE column reference to a
base-table `T` column by matching the reference's table/alias qualifier against
`tQualifiers` (the FROM-clause names denoting `T`). Previously `columnRefParts`
discarded `ColumnExpr.schema`, so a schema-qualified reference `s2.t.uc` collapsed
to `{ qualifier: 't', name: 'uc' }`. If the base table `main.t` is unaliased its
qualifier is also `'t'`, so the lookup-schema reference matched base `T` and the
prover believed the body was ordered by base `T`'s UC column when it was physically
ordered by the *lookup* `s2.t`'s same-named column ⇒ a false `Covers`. (The FROM
side — `collectBaseTableQualifiers` — was already schema-aware; only the
*reference's* schema was being thrown away.)

## Reachability (important — this is defense-in-depth, NOT a SQL regression)

The cross-schema scenario is **not reachable via SQL**. Quereus's binder rejects
*every* 3-part `schema.table.column` column reference in expression context before
a plan (let alone an MV) exists:
- `RegisteredScope` registers only bare column names for a table source;
- `AliasedScope.resolveSymbol` rewrites `parts[1]` and delegates the still-3-part
  key to `RegisteredScope`, which has no such key ⇒ `undefined`;
- `resolveColumn` then throws `"<schema>.<table>.<col> isn't a column"`.

The two SQL-reachable orderings over the join body both resolve to base `T`'s
column (a genuine cover): bare `order by uc` (output-column / first-match) and
2-part `order by t.uc` (MultiScope first-match = left = base). So the guard can
only be exercised by feeding `proveCoverage` a **hand-built `selectAst`** whose
ORDER BY term is a 3-part `ColumnExpr` — the prover reads `mv.selectAst` directly
and does not re-bind, so the hand-built term reaches the resolver unchanged.

## Tests added (test/covering-structure.spec.ts)

New `describe('coverage prover — cross-schema qualifier resolution (defense-in-depth)')`.

Fixture (note **both tables are named `t` and both carry a `uc` column**, so a
schema-blind match would collide):
- base `main.t (id integer primary key, uc integer not null, lkref integer not null, unique (uc))`
- lookup schema created via `db.schemaManager.addSchema('s2')`, then
  `create table s2.t (pkid integer primary key, uc integer not null)`
- plannable body: `select t.uc, t.id from t left join s2.t on lkref = pkid order by uc`
  (1:1 — LEFT join, base on the preserving side; lookup keyed on its own PK ⇒ no
  fan-out; no FK declared so `rule-join-elimination` does not collapse the join).

Each case re-parses the body for `selectAst`, then **replaces** `orderBy` with a
single hand-built term `{ type: 'column', name: 'uc', table: 't', schema }`, and
calls `proveCoverage(root, mvStub, uc, baseTable)`:

| ORDER BY term schema | expected result | meaning |
|----------------------|-----------------|---------|
| `'s2'` (lookup)      | `covers: false`, `reason: 'ordering-mismatch'` | the fix — no mis-map onto base `T` |
| `'main'` (base)      | `covers: true`  | positive cross-schema: correctly base-qualified still covers |
| `undefined`          | `covers: true`  | reachable bare/2-part path unchanged (regression floor) |

All three pass; confirmed the `s2` case returns `ordering-mismatch` (not `shape`
or `fanout`), proving the shape walk, projection coverage, and fan-out gate all
pass first and the rejection is specifically the ordering resolver.

## Validation performed

- `yarn workspace @quereus/quereus run build` (typecheck) — clean.
- `node packages/quereus/test-runner.mjs --grep 'coverage prover'` — 44 passing
  (the 3 new tests + all pre-existing coverage-prover tests unchanged).
- Full `yarn test` — quereus 3828 passing + all other workspaces green; no new
  failures. (The only `failed`-looking log lines are an intentional `failingKv`
  error-handling fixture in quereus-sync — 163 passing there.)

## Reviewer focus / known gaps

- **Parallel blind spot, deliberately left untouched (per the implement ticket's
  "optional consistency note").** `columnIndexFromExpr` (predicate-shape.ts)
  ignores *both* the table qualifier *and* the schema on a `ColumnExpr` — strictly
  bare-name resolution. Its callers (`check-extraction.ts`,
  `partial-unique-extraction.ts`) operate over **single-table** CHECK constraints /
  partial-index predicates with no joins or schema qualifiers (confirmed by the
  inline comment "Partial-index predicates are single-table … so plain bare-name
  resolution … is faithful"), so the blind spot is harmless there. A parallel
  one-line hardening (reject a schema-qualified `ColumnExpr`) would be defensive
  only; it was kept out of this diff to avoid widening scope. Reviewer may decide
  whether to file a follow-up — low priority.
- **Out of scope (pre-existing, noted not fixed):** the broader binder limitation
  that *no* 3-part `schema.table.column` reference resolves in expression context,
  even single-source / default-schema. That is a separate, pre-existing
  limitation; this ticket only hardens the prover's resolver.
- **Other documented "known gaps" untouched** (conservative rejection of
  derived/function FROM sources; the unqualified-ambiguity check trusting
  join-frame names) — completeness/defense-in-depth, no change.
- **Soundness boundary to sanity-check:** the guard only *narrows* — a present
  foreign schema now yields `undefined` (a `NotCovers`), which is always safe (a
  false `NotCovers` only forgoes an optimization). It never *widens* coverage.
  Worth a skim of the resolver to confirm there is no path where a present schema
  could now make a reference resolve that previously did not.
