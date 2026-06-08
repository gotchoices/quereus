description: Wire `[NOT] DEFERRABLE [INITIALLY ...]` through the AST stringifier so `ForeignKeyClause.deferrable` / `initiallyDeferred` round-trip on both column-level and table-level foreign keys. Helper `foreignKeyClauseTail` de-duplicates the two FK call sites.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
----

## Outcome

`ForeignKeyClause.deferrable` / `initiallyDeferred` now survive `parse → stringify → parse` on both column-level (`references TBL(...) [not] deferrable [initially …]`) and table-level (`foreign key (...) references TBL(...) [not] deferrable [initially …]`) FK shapes. The previously duplicated FK clause tail (`references TBL(cols) [on delete …] [on update …]`) is consolidated into a single helper alongside the new deferrability emission. The FK-deferrability TODO in the file header is removed.

## Review findings

Read the implement diff (`dd032c8c`) first, then revisited the surrounding stringifier + parser + ast definitions.

### Correctness / behavior preservation — fixed/none

- **Helper extraction is verbatim-equivalent for the pre-deferrability portion**: diffed the prior inline code at `columnConstraintsToString` and `tableConstraintsToString` against `foreignKeyClauseTail` (ast-stringify.ts:1065-1080). Identifier quoting (`quoteIdentifier`), column-list formatting (`map(quoteIdentifier).join(', ')`), and the `on delete` / `on update` arms match byte-for-byte. The table-level call site still emits `foreign key (<cols>) ` ahead of the helper, preserving its prior output. No semantic drift.
- **Deferrability guard mirrors the parser**: `parser.ts:3688-3716` only ever populates `initiallyDeferred` after consuming a DEFERRABLE/NOT DEFERRABLE token, and the stringifier's `if (fk.deferrable !== undefined) { … if (fk.initiallyDeferred !== undefined) … }` nesting matches that invariant. Round-trip is safe.
- **All four canonical legal SQL shapes round-trip** (`DEFERRABLE`, `DEFERRABLE INITIALLY DEFERRED|IMMEDIATE`, `NOT DEFERRABLE`) via the unit tests; the three additional shapes the parser accepts (`NOT DEFERRABLE INITIALLY DEFERRED|IMMEDIATE`, and the no-clause case `{}`) are covered by the property arb.
- **Identifier-collision risk**: `'deferrable'` (and `'initially'`, `'deferred'`, `'immediate'`) were already in the property-test identifier blocklist (emit-roundtrip-property.spec.ts:54-55). No risk of an arbitrary-generated identifier shadowing the new keywords.

### Tests / coverage — sufficient

- Unit suite gained 8 new cases (4 shapes × column-level + table-level) → 47 passing (was 39).
- Property suite incorporates `fkDeferrabilityArb` into both `columnConstraintArb` and the table-FK arm of `makeTableConstraintArb`, giving cross-product coverage with `onDelete` / `onUpdate` / column-list shapes.
- Asymmetric shape (no `NOT DEFERRABLE INITIALLY …` in unit suite): acceptable — the parser's NOT branch (parser.ts:3699-3710) is structurally a copy of the DEFERRABLE branch and is exercised by the property arb. Not worth duplicating.
- No happy-path regressions: full `yarn workspace @quereus/quereus run test` → 3291 passing.

### DRY / modularity — improved

- The pre-existing inline duplication of the FK tail between the two constraint-stringifier arms is the larger DRY win here; the helper makes the new feature an additive single-site change. Good shape for any future additions (e.g. `MATCH SIMPLE|PARTIAL|FULL` if ever wired).

### Resource / error handling / type safety — n/a

- Pure string assembly, no I/O, no async, no `any`. Helper signature `(fk: AST.ForeignKeyClause) => string` is precisely typed against the AST interface.

### Docs — verified, no updates needed

- `docs/sql.md:3503` already specifies the deferrability grammar.
- The file header comment in `ast-stringify.ts` lost the now-resolved TODO line.
- No other doc file references FK stringification.

### Knowingly-deferred caveats (left as-is)

- `ColumnConstraint.deferrable` / `ColumnConstraint.initiallyDeferred` (ast.ts:432-433) and `TableConstraint.deferrable` / `TableConstraint.initiallyDeferred` (ast.ts:446-447) remain unused by the parser (parser.ts:3716 writes only the nested `ForeignKeyClause`) and ignored by the stringifier. Per the implement-stage handoff, no producer currently populates them; treating these as dead fields rather than a forward-compat target is reasonable. Would only become a finding if a future builder/parser path starts setting them — at which point the stringifier would need a corresponding read. Not actioning here; not a regression.
- `deferrable === false && initiallyDeferred === true` ("NOT DEFERRABLE INITIALLY DEFERRED") is semantically odd but syntactically accepted by the SQL grammar and by Quereus's parser. The stringifier round-trips it faithfully without commenting on semantic validity — correct call for a stringifier (semantics belong upstream).

### Validation run as part of this review

- `yarn workspace @quereus/quereus run lint` — exit 0.
- `yarn workspace @quereus/quereus run test --grep "AST round-trip"` — 47 passing.
- `yarn workspace @quereus/quereus run test` — 3291 passing (full quereus suite, no regressions).

No new tickets filed. Nothing in this pass rose above "knowingly-deferred caveat" — disposition: none.
