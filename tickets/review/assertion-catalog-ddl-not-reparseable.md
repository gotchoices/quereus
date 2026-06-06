description: Review — assertion catalog `ddl` is now a faithful, re-parseable `CREATE ASSERTION <name> CHECK (<expr>)` (emitted from the stored `checkExpression` AST via `expressionToString`, not the embedded `violationSql` SELECT). Verify correctness + the new re-parse round-trip tests.
files: packages/quereus/src/schema/catalog.ts, packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts, packages/quereus/src/schema/assertion.ts, packages/quereus/src/runtime/emit/create-assertion.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/schema-differ.ts
----

## What changed

`assertionSchemaToCatalog` (`schema/catalog.ts:316`) previously emitted:

```
CREATE ASSERTION my_assert CHECK (select 1 where not (1 = 1))
```

The CHECK slot held `violationSql` — a full `select 1 where not (<expr>)` query,
which is not a CHECK-*expression*, so the catalog `ddl` never round-tripped
through `parse()` (the parser's `createAssertionStatement` calls
`this.expression()` after `CHECK (`, and a leading `select` is not an
expression).

Now the CHECK slot is emitted from the stored `checkExpression` AST via
`expressionToString` — the same call `emitCreateAssertion`
(`runtime/emit/create-assertion.ts:23`) already uses to build the violation
query, so it is already proven to produce a parseable expression for this input:

```
CREATE ASSERTION my_assert CHECK (1 = 1)
```

Two source edits, both in `catalog.ts`:
- Added `expressionToString` to the existing `../emit/ast-stringify.js` import (line 5).
- Rewrote `assertionSchemaToCatalog` to use
  `assertionSchema.checkExpression ? expressionToString(...) : violationSql`,
  keeping uppercase keywords and `quoteIdentifier(name)`. The `violationSql`
  fallback fires only for an assertion reconstructed from `violationSql` alone —
  a path that does not exist today (`importSingleDDL` throws on assertion DDL);
  it exists so the function never throws on that hypothetical case rather than
  silently dropping the field.

## Why option 1 (make it faithful) — settled in plan

The string literally announces itself as `CREATE ASSERTION ... CHECK (...)`; a
parseable form removes a latent landmine for any future rehydrate / schema-export
/ "show DDL" tooling. Fix is tiny and reuses already-exercised machinery. No
back-compat barrier: assertion `ddl` is never fed back to the parser today (the
differ reads assertions by name only), and back-compat is not yet a concern per
AGENTS.md. Keyword casing kept uppercase to match sibling generator sites
(`ddl-generator.ts`) and the existing passing name-quoting tests.

## Tests added / updated

`test/ddl-generator-roundtrip-positions.spec.ts`:
- Rewrote the file-header deferral note and the assertion describe-block comment
  (they previously documented *why a full re-parse was not attempted* — exactly
  what this ticket removes).
- Two new tests in `describe('Generator: CREATE ASSERTION name (collectSchemaCatalog)')`:
  - **literal predicate** — `create assertion my_assert check (1 = 1)` →
    `collectSchemaCatalog` → `parse(a.ddl)` asserts `type === 'createAssertion'`
    and name matches. (Previously would have thrown on the embedded `select`.)
  - **identifier-bearing predicate** — creates `t(id, v)`, then
    `create assertion a2 check (not exists (select 1 from t where v < 0))` →
    `parse(a.ddl)` round-trips. Chosen to exercise `expressionToString`'s
    identifier quoting (a table ref `t` and column ref `v`), not just a literal.
- The two pre-existing name-quoting asserts (`CREATE ASSERTION "select" CHECK`,
  no-over-quote on `my_assert`) pass verbatim, now additionally backed by a
  successful `parse()`.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- Full quereus suite (`node test-runner.mjs`) — **4855 passing, 9 pending, exit 0**.
- Targeted `--grep "CREATE ASSERTION"` — 6 passing (incl. both new tests, the
  emit-error-handling spec, and the AST round-trip property test).
- `eslint` on both touched files — clean (exit 0).

## Hash-consumer question (resolved — answer to the plan's handoff ask)

**No actual-catalog hash consumer reads `catalog.assertions[].ddl`, so no hash
value shifts.** Traced both consumers of `collectSchemaCatalog`:
- `schema/catalog.ts` itself.
- `runtime/emit/schema-declarative.ts` → `computeSchemaDiff(declaredSchema, actualCatalog)`.
  The differ (`schema-differ.ts:417-427`) keys `actualCatalog.assertions` **by
  name only**, generates create-DDL from the *declared* AST via
  `createAssertionToString` (not the catalog `ddl`), and drops by name. The
  catalog `ddl` field is never hashed or string-compared.
- `computeSchemaHash` (`schema-hasher.ts:62`) hashes the *declared* schema via
  `generateDeclaredDDL`, which emits no assertion DDL at all — declared-schema
  hash unaffected.
- `emitDiffSchema`'s `computeShortSchemaHash` (`schema-declarative.ts:296`) also
  hashes the declared schema, not the actual catalog.

## Reviewer focus / known gaps to probe

- **Fallback branch is untested.** The `violationSql` fallback is unreachable
  today (no reconstruct-from-`violationSql` path exists), so it has no test. It
  is a defensive no-throw guard, not live behavior — confirm you agree it should
  stay rather than become an assert/throw. If a reviewer prefers it loud, an
  alternative is to throw when `checkExpression` is absent; left as a fallback
  per the plan's explicit "do not silently drop the field" guidance.
- **Re-parse asserts structure, not expression equality.** The new tests assert
  the re-parsed `stmt.type === 'createAssertion'` and the name, but do **not**
  assert the round-tripped CHECK *expression* is structurally equal to the
  original. The AST round-trip property suite already covers
  `parse → createAssertionToString → parse` expression fidelity generally; the
  gap here is specifically that the *catalog generator's* CHECK slot matches the
  original expression byte-for-byte. Low risk (it is the same `expressionToString`
  call), but a stronger test would `parse` both the catalog `ddl` and a
  hand-written `create assertion … check (<same expr>)` and compare the `.check`
  ASTs. Consider whether that is worth adding.
- **Display consumers unchanged.** `func/builtins/schema.ts` and
  `func/builtins/explain.ts` read `violationSql` directly, not the catalog `ddl`
  — assertion *violation-query display* is unchanged. Only the catalog `ddl`
  string changed. (Spot-check these if you want to be sure nothing reads the
  catalog `ddl` for display.)
- **Differ untouched** — deliberately. Confirm no migration-generation path was
  expected to change.
