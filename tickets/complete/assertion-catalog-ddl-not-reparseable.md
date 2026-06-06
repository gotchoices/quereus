description: Assertion catalog `ddl` is now a faithful, re-parseable `CREATE ASSERTION <name> CHECK (<expr>)` — emitted from the stored `checkExpression` AST via `expressionToString`, not the embedded `select 1 where not (...)` `violationSql`. Reviewed and completed.
files: packages/quereus/src/schema/catalog.ts, packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts
----

## Summary

`assertionSchemaToCatalog` (`schema/catalog.ts:316`) previously put `violationSql`
— a full `select 1 where not (<expr>)` query — into the CHECK slot, so the
catalog `ddl` advertised itself as `CREATE ASSERTION … CHECK (…)` yet never
round-tripped through `parse()` (a leading `select` is not a CHECK-*expression*).
It now emits the CHECK slot from the stored `checkExpression` AST via
`expressionToString` — the same call `emitCreateAssertion` already uses to build
the violation query, so it is already proven parseable for this input:

```
CREATE ASSERTION my_assert CHECK (1 = 1)
```

A `violationSql` fallback remains for the (today-unreachable) case of an
assertion reconstructed from `violationSql` alone, so the function never throws
nor silently drops the field.

## Review findings

### What was checked

- **Implement diff read first, fresh** (`git show 2fa67948`) before the handoff.
- **Correctness of the emitted DDL.** Confirmed the catalog CHECK slot is the
  exact `expressionToString(checkExpression)` that `emitCreateAssertion`
  (`runtime/emit/create-assertion.ts:23`) already feeds into
  `select 1 where not (<exprSql>)`. Since that violation query is parsed/planned
  at assertion-creation time, the same expression string is guaranteed
  parseable, and `CHECK (<exprSql>)` applies the same outer parenthesisation as
  `not (<exprSql>)` — no new precedence exposure, no new throw path
  (`expressionToString` already ran without throwing at creation time).
- **No downstream consumer of the changed string.** Traced every reader of
  `actualCatalog.assertions`:
  - `schema-differ.ts:417` keys assertions by `name.toLowerCase()` only and
    generates create-DDL from the *declared* AST via `createAssertionToString`;
    the stored `CatalogAssertion.ddl` value is never read, hashed, or compared.
  - `importSingleDDL` (`schema/manager.ts:2126`) handles only `createTable` /
    `createIndex` and throws on any other statement type — assertion `ddl` is
    never fed back to the parser today, so the change has no rehydrate impact.
  - Schema-hash paths (`schema-hasher.ts`, `schema-declarative.ts`) hash the
    *declared* schema, not the actual catalog — no hash value shifts. (Confirms
    the implementer's hash-consumer analysis.)
- **Display consumers** (`func/builtins/schema.ts`, `func/builtins/explain.ts`)
  read `violationSql` directly, not the catalog `ddl` — violation-query display
  is unchanged. Verified the catalog `ddl` is not read for display anywhere.
- **DRY note (intentional non-reuse).** `createAssertionToString`
  (`ast-stringify.ts:914`) emits the *lowercase* `create assertion … check (…)`
  form; the catalog generator deliberately keeps uppercase keywords to match its
  sibling sites (`ddl-generator.ts`) and the pre-existing name-quoting tests.
  Accepted — the duplication is one short template literal and the casing
  divergence is a real constraint, not an oversight.
- **Lint + full test suite** run green (below).

### Findings & disposition

- **Minor (fixed in this pass): tests asserted statement *shape*, not predicate
  *fidelity*.** The two new re-parse tests asserted only
  `stmt.type === 'createAssertion'` + name — a structure-only check that would
  pass even if `expressionToString` dropped parens or mis-associated and emitted
  *a* valid-but-different predicate (exactly the faithfulness failure this ticket
  exists to prevent). Strengthened the identifier-bearing test to also assert the
  re-parsed CHECK canonicalises to the same expression as the original:
  `expressionToString(parse(ddl).check) === expressionToString(parse('… check (<same>)').check)`.
  Added `expressionToString` import. Passes.

- **Minor (reviewed, left as-is): `violationSql` fallback is untested and
  unreachable.** No path reconstructs an assertion from `violationSql` alone
  today (`importSingleDDL` throws on assertion DDL), so the fallback branch has
  no live caller and no test. It is a defensive no-throw guard explicitly chosen
  in plan over throwing ("do not silently drop the field"). Agreed: keeping it as
  a non-throwing fallback is correct for a catalog *snapshot* function — throwing
  there would turn a benign hypothetical into a hard failure. No change.

- **Major: none.** No new tickets filed.

- **Docs:** none required. No doc describes the assertion catalog `ddl` shape;
  the behavior is documented inline at the call site and in the test header,
  both of which were updated by the implementer to reflect the now-faithful form
  (verified against the new reality).

- **Empty categories:** no performance, resource-cleanup, error-handling, or
  type-safety concerns — the change is a single string-construction swap reusing
  an already-exercised pure function; no new resources, async, or `any`.

## Validation

- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `eslint` on `src/schema/catalog.ts` + the test file — clean (exit 0).
- Full quereus suite (`node test-runner.mjs`) — **4855 passing, 9 pending**
  (exit 0), unchanged from the implement handoff.
- `--grep "CREATE ASSERTION"` — **6 passing**, including the strengthened
  predicate-fidelity test.
