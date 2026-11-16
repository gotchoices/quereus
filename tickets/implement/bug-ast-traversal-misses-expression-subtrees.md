---
description: A check that is supposed to reject a table definition containing a random or clock-reading function does not look everywhere in the definition, so a definition that hides such a call in one of five less-common places is accepted. Close the five gaps and add a test that fails to compile when the syntax tree gains a new place an expression can hide.
files:
  - packages/quereus/src/parser/visitor.ts           # traverseAst — add the five arms; update the header NOTE
  - packages/quereus/src/schema/expr-scope/walk.ts   # sibling traversal that already reaches all five; its header NOTE must be updated to say the two now agree
  - packages/quereus/src/schema/manager.ts           # the four callers (rejectIllegalReferences ~2157, defaultEmbedsSubquery ~2222, defaultReferencesNewRow ~2236, findNonDeterministicCall ~2519) — read only, no change expected
  - packages/quereus/src/parser/ast.ts               # SelectStmt.defaults, InsertStmt/UpdateStmt/DeleteStmt returning/upsertClauses/contextValues, WindowFrame/WindowFrameBound
  - packages/quereus/test/visitor.spec.ts            # the coverage ledger lives here
  - packages/quereus/test/logic/44-determinism-validation.sqllogic   # end-to-end regression for the gate
repro: verified
---

# Close the five `traverseAst` gaps and guard the class with a field ledger

## Background

`traverseAst` (`src/parser/visitor.ts`) is the generic "visit every node" helper. Four `CREATE TABLE`-time checks in `src/schema/manager.ts` walk with it: the bind-parameter / bare-column rejection for `DEFAULT` and `CHECK` (`rejectIllegalReferences`), two `DEFAULT` classifiers (`defaultEmbedsSubquery`, `defaultReferencesNewRow`), and the non-deterministic-function gate for `CHECK` and `GENERATED ALWAYS AS` bodies (`findNonDeterministicCall`).

It never descends five expression-bearing places:

- a window frame bound's expression (`rows between <expr> preceding …`) — the `TODO` in the `windowDefinition` arm. The bound types live on `WindowFrame.start` / `.end`; only `preceding` / `following` bounds carry a `value`. `WindowFrame` is not an `AstNode`, so descend into `bound.value` directly (same as `visitWindowFrameBound` in `walk.ts`).
- `SelectStmt.defaults` (the trailing `with defaults (col = expr, …)`).
- a DML statement's `returning` list (insert, update and delete all have one).
- an insert's `upsertClauses` — each clause's `assignments[].value` and `where`.
- a DML statement's `contextValues` (`with context name = expr`) — insert, update and delete.

## Reproduction (verified in the fix stage)

Run against a fresh `Database` after `create table ds (k integer primary key, v integer)`. Every statement below is **accepted** today; the control is refused:

```sql
-- control: refused today ("Non-deterministic expression not allowed in GENERATED ALWAYS AS …")
create table c0 (id integer primary key, g integer generated always as ((select random() from ds limit 1)));

-- all accepted today; all should be refused
create table c1 (id integer primary key, g integer generated always as ((select sum(v) over (rows between abs(random()) preceding and current row) from ds limit 1)));
create table c2 (id integer primary key, g integer generated always as ((select v from ds limit 1 with defaults (v = random()))));
create table c3 (id integer primary key, g integer generated always as ((select r from (insert into ds values (1, 1) returning random() as r) q limit 1)));
create table c4 (id integer primary key, n integer, check (n > (select sum(v) over (rows between abs(random()) preceding and current row) from ds limit 1)));
create table c5 (id integer primary key, g integer generated always as ((select r from (insert into ds values (1, 1) on conflict do update set v = random() returning v as r) q limit 1)));
create table c6 (id integer primary key, g integer generated always as ((select r from (insert into ds values (1, 1) on conflict do update set v = 1 where random() > 0 returning v as r) q limit 1)));
create table c7 (id integer primary key, g integer generated always as ((select r from (insert into ds with context x = random() values (1, 1) returning v as r) q limit 1)));
```

What acceptance actually costs differs by gap, and the ticket's original "values change every read" framing is only exact for some of them:

- **returning / upsert / context (c3, c5, c6, c7):** the non-deterministic call is evaluated whenever the body runs, so the stored value is not a function of the row.
- **frame bound (c1, c4):** the planner rejects any frame bound that is not a constant numeric literal (see the NOTE in `walk.ts` `visitWindowDefinition`), so these tables are most likely *unwritable* — every insert fails — rather than non-deterministic. Not run in the fix stage; inferred from that comment. Refusing at declaration is still right; it is the same "refuse what no write can satisfy" category as `bug-unknown-function-not-caught-at-declaration`.
- **`with defaults` (c2):** inside a scalar subquery the clause is inert metadata (see the `SelectStmt.defaults` doc comment in `ast.ts`), so `random()` there is never evaluated. Refusing it rejects a harmless-but-meaningless declaration. Decision for this ticket: descend anyway. `traverseAst` is a generic "every node" traversal and should not encode evaluation semantics; nobody writes this shape (no test in the repo does with a non-deterministic call — `41-generated-column-scope.sqllogic` §320 uses `with defaults (x = g)` and still passes widened).

## Blast radius (measured in the fix stage)

The five arms were applied temporarily and the full `packages/quereus` suite run (`yarn test` from `packages/quereus`): **11202 passing, 0 failing, 26 pending** — nothing in the existing suite becomes newly rejected. The c1–c7 cases above all became refused with the expected messages. The edit was then reverted; the tree is clean.

Per caller, by reading the code:

- `findNonDeterministicCall` (CHECK and GENERATED): newly refuses a non-deterministic call in the five subtrees. This is the fix.
- `defaultEmbedsSubquery` / `defaultReferencesNewRow`: return `true` more often, which only *widens* the "defer DEFAULT validation to INSERT time" branch in `validateOneDefault` — more lenient, never newly rejects.
- `rejectIllegalReferences`: newly rejects a bind parameter (`?`) in the five subtrees — correct, a parameter has no value at declaration. Bare-column rejection applies only at subquery depth 0, and the DML subtrees are only reachable below a `select` / `subquery` / `exists` boundary, so the only new depth-0 reach is a frame bound of a window function written directly in a `DEFAULT` — which the planner rejects anyway.
- **No stored schema can stop loading:** the CHECK / GENERATED / DEFAULT determinism gates run only from `createTable` (and `ALTER … SET DEFAULT`), not from the import/rehydrate path — see the doc comment on `validateGeneratedColumnDeterminism` (`manager.ts` ~2468). `ALTER TABLE ADD COLUMN` uses its own plan-based gate (`planner/building/alter-table.ts`, `validateDeterministicDefault`) and does not use `traverseAst`.

So the risk the original ticket worried about — newly rejecting DDL that works today — is limited to freshly authored DDL containing one of these shapes with a non-deterministic call or a `?`.

`SelectStmt.union` is visited by `walk.ts` but not by `traverseAst`; the parser never sets it (only `parser.ts` ~3778 reads it). Classify it in the ledger (descend it for parity, or mark it not produced by the parser — implementer's call; descending costs one line).

## The coverage ledger

The schema scope walk's spec (`test/schema/expr-scope-walk.spec.ts` ~400) has a `Record<AST.Expression['type'], …>` ledger, so a new expression kind cannot be added without a recorded decision. That ledger is per node *kind*; this bug is per *field* — every kind involved (select, insert, windowDefinition) was already handled, the misses were fields on them. So the ledger here has to be per field:

```ts
type Fields<T> = Exclude<keyof T, 'type' | 'loc'>;
type Treatment =
	| { descend: string }   // sample SQL that puts `sentinel()` in exactly this field
	| { skip: string };     // why this field holds no expression (or is deliberately not descended)

const SELECT_FIELDS: Record<Fields<AST.SelectStmt>, Treatment> = {
	withClause: { descend: 'with c as (select sentinel()) select 1 from c' },
	columns: { descend: 'select sentinel()' },
	defaults: { descend: '(select 1 from t with defaults (a = sentinel()))' },  // or whatever form parses at statement level
	distinct: { skip: 'flag' },
	schemaPath: { skip: 'names only' },
	storedBodyEnv: { skip: 'write-through lowering metadata, never set by the parser' },
	// … every other key, or this does not compile
};
```

One such `Record` per AST type that owns an expression-bearing field: `SelectStmt`, `InsertStmt`, `UpdateStmt`, `DeleteStmt`, `ValuesStmt`, `UpsertClause`, `ResultColumnExpr` (for `inverse`), `JoinClause`, `FunctionSource`, `SubquerySource`, `WindowFunctionExpr`, `WindowDefinition`, `WindowFrame` (start/end), `CaseExpr`, `InExpr`, `BetweenExpr`, `ExistsExpr`, `FunctionExpr`, `SubqueryExpr`, `BinaryExpr`, `UnaryExpr`, `CastExpr`, `CollateExpr`, `CommonTableExpr`. Adding a field to any of them fails compilation (`yarn lint` in `packages/quereus` type-checks test files) until someone classifies it.

Add one node-kind ledger too — `Record<AST.AstNode['type'], 'descend' | 'leaf' | 'not-traversed'>` — because a brand-new node kind today only hits the `default:` arm's runtime `warnLog`, which nothing asserts.

One data-driven runtime test then iterates every `descend` entry: parse the sample, `traverseAst` it, assert a `function` node named `sentinel` was entered. This proves each listed field is actually descended (a compile-only ledger would let someone mark a field `descend` without adding the arm). That single test is the reproduction at the lowest layer; replace nothing in the existing `visitor.spec.ts` cases unless the ledger strictly subsumes them (the CASE/IN/BETWEEN/CTE/inverse/targetSource cases largely are — the reviewer may trim them).

Plus one end-to-end case in `test/logic/44-determinism-validation.sqllogic` showing the gate consumes the widened reach — c3 (returning, the genuinely non-deterministic shape) and c4 (CHECK) are enough; do not add all seven.

## Related

`bug-unknown-function-not-caught-at-declaration` (in `fix/`) is a different hole in the same gate — `findNonDeterministicCall` skips a function name the registry cannot resolve. Disjoint root cause; do not fold it in here.

## TODO

- In `traverseAst`: descend `SelectStmt.defaults[].expr`; for insert/update/delete descend `returning` (result columns, including any `inverse`, via one small helper shared with the select-columns arm) and `contextValues[].value`; for insert descend `upsertClauses[].assignments[].value` and `.where`; in `windowDefinition` descend `frame.start` / `frame.end` bound values for `preceding` / `following`, replacing the `TODO`. Decide `SelectStmt.union`.
- Rewrite the header `NOTE:` in `visitor.ts` and in `walk.ts`: the two traversals now have the same reach; point at the ledger in `test/visitor.spec.ts` as the guard; drop the "owned by this ticket" sentences.
- Add the field ledgers + node-kind ledger + the single data-driven sentinel test to `test/visitor.spec.ts`.
- Add the c3 and c4 cases (expecting `Non-deterministic expression not allowed in GENERATED ALWAYS AS` / `… in CHECK`) to `test/logic/44-determinism-validation.sqllogic`.
- `yarn lint` and `yarn test` in `packages/quereus`; expect the full suite to stay green (it did with the same arms in the fix stage).
