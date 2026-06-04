description: Deterministic reserved-word-through-every-identifier-position round-trip suite plus the emit/parser quoting fixes it drove. Closes the structural blind spot where the AST property test (which avoids reserved words) could not catch a "reserved word used as an identifier" emit bug like the `release to` regression.
files: packages/quereus/test/emit-roundtrip-positions.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/lexer.ts
----

## What shipped

A new deterministic, position-by-position round-trip suite
(`test/emit-roundtrip-positions.spec.ts`) drives **every** lexer keyword through
**every** identifier position (table/column/alias/schema/index/view/MV/assertion/
savepoint/CTE/collation/pragma/function/upsert/with-context/declare-lens/…),
asserting `parse → astToString → parse` structural equality, plus a
no-over-quoting check pinning the quote-only-when-necessary policy. The set is
driven off `Object.keys(KEYWORDS)` so it can never drift from the lexer the way
the old property-test denylist did.

The suite drove emit fixes in `src/emit/ast-stringify.ts` (collate in three
positions, diff/apply/explain-schema names, scalar function name via the
surgical `quoteFunctionName` gate, TVF name), a parser fix in `parser.ts`
(`collateExpression` reads the collation via `getIdentifierValue` so quoted
collation names strip their quotes), and a DRY refactor moving
`CONTEXTUAL_KEYWORDS` into `lexer.ts` shared by parser + emitter.

See the originating implement handoff (commit `35f30a29`,
`ticket(implement): reserved-word-identifier-emit-roundtrip`) for the full
design rationale, including the two-masters problem behind `quoteFunctionName`
(round-trip SQL vs. auto-derived result-column names — `like('a%', x)` must stay
bare while `"select"(x)` must quote).

## Review findings

Adversarial review of the implement diff (read first, before the handoff),
every touched file, the files it *should* have touched, and a full
build/lint/test pass.

### Verified correct (checked, no action)

- **Function-name gate parity.** `BARE_CALLABLE_FUNCTION_NAMES =
  [...CONTEXTUAL_KEYWORDS, 'replace']` in `ast-stringify.ts` exactly matches the
  parser's bare-callable scalar set at `parser.ts:1660-1661`
  (`consumeIdentifier([...CONTEXTUAL_KEYWORDS, 'replace'], …)`). The shared
  `CONTEXTUAL_KEYWORDS` move means the *base* set cannot drift; only the
  `+ 'replace'` is duplicated, which is documented. The stay-bare behavior is
  guarded by `logic/06-builtin_functions.sqllogic` (passes) and the new suite's
  no-over-quoting check.
- **TVF path reasoning** (uses full `quoteIdentifier`, not the function gate):
  confirmed sound — a quoted TVF name always re-parses and TVF names are
  relation sources, never scalar column names, so over-quoting is cosmetic-only.
- **`IndexedColumn.collation` "defensive/unreachable" flag:** confirmed. The
  parser routes `CREATE INDEX (a collate x)` through the column expression's
  `collate` node, not `col.collation`; the AST field is only reachable via
  programmatically-built ASTs.
- **Parser collate quote-stripping** is a behavior change (quoted collation
  names now strip quotes) but low-risk; the full suite (4590 passing) covers it.
- **Spot-checks** (`savepoint/release/rollback-to "to"`, `collate "select"`,
  `diff schema "select"`, `like('a%', x)` stays bare, `"select"(x)` quotes,
  `create index … (a collate "select")`) all round-trip correctly.

### Minor — fixed inline in this review pass

- **`using <module>` bare emit (CREATE TABLE + CREATE MATERIALIZED VIEW).** The
  handoff flagged this as a documented gap and explicitly asked the reviewer to
  decide gate-vs-leave. Reproduced the break (`create table t (a integer) using
  "select"` emitted `using select`, which failed to re-parse). Gating is cheap,
  safe (normal module names stay bare under `quoteIdentifier`), and consistent
  with the surrounding moduleArgs-key quoting — so **fixed**:
  `moduleClauseToString` and `mvModuleClauseToString` now route the module name
  through `quoteIdentifier`. Added two pinning positions to the suite
  (`create table using module`, `create materialized view using module`).
  Suite: **146 passing** (was 142).

### Major — filed new fix ticket

- **`fix/ddl-generator-reserved-word-identifier-emit`** — the *same* bug class
  lives in two **independent** DDL emitters the AST round-trip suites can never
  reach (they build DDL from schema objects, not ASTs, and feed persistence):
  - `schema/ddl-generator.ts` emits **bare** COLLATE name (`:88`), USING module
    name (`:188`/`:199`), and vtab-arg keys (`:206`).
  - `schema/catalog.ts` emits a **bare** assertion name (`:265`).
  These need quoting plus their own **schema → DDL → parse** round-trip coverage,
  which is real scope beyond this AST-emitter ticket — hence a ticket rather than
  an under-tested inline patch. The ticket also flags the **stale sync banner**
  at `parser.ts:39-44` (names a non-existent
  `quereus-store/src/common/ddl-generator.ts`, omits the real
  `schema/ddl-generator.ts`).

### Honest flags carried forward (not regressions)

- `test:store` was **not** run (store-independent for the AST-emitter changes).
  The persistence-feeding `ddl-generator` gap is now covered by the filed ticket,
  which calls for a `test:store` sanity pass.
- The `+ 'replace'` duplication has no automated guard tying emitter to parser;
  documented and behavior-guarded, accepted as-is.

## Validation (this review)

- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus run test` — **4590 passing, 9 pending, 0
  failing**.
- Focused `emit-roundtrip-positions.spec.ts` — **146 passing** (~123ms).
