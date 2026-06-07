description: Canonical-body renderers for schema-diff drift detection (index column lists, named-constraint UNIQUE / FK local + referenced column lists, and the PK column list) preserve column-identifier case via `quoteIdentifier(name)`, while column resolution everywhere else folds case (`.toLowerCase()`). A declared index/constraint whose column reference case differs from the column *definition* case therefore renders byte-unequal against the actual catalog and churns a spurious drop+recreate / drop+add on every diff. Fix: lowercase bare column-name identifiers in the canonical-comparison renderers only (user-facing DDL keeps original case).
prereq:
files:
  - packages/quereus/src/emit/ast-stringify.ts          # canonicalIndexedColumnsToString, constraintBodyToCanonicalString, tableConstraintsToString, foreignKeyClauseTail
  - packages/quereus/src/schema/ddl-generator.ts         # indexToCanonicalDDL, constraintToCanonicalDDL — actual-side lift (no change expected; both sides funnel through the shared renderers)
  - packages/quereus/src/schema/schema-differ.ts         # pkSequencesEqual (already case-insensitive — the consistency reference point); index + constraint body comparison call sites
  - packages/quereus/test/index-ddl-roundtrip.spec.ts    # "declarative differ stability" describe — add mixed-case no-churn case(s)
  - packages/quereus/test/declarative-equivalence.spec.ts # "named-constraint body change" / "named-constraint lifecycle" describes — add mixed-case no-churn UNIQUE/FK case(s)
----

# Canonical-body column-name case normalization (constraint / PK / index drift)

## Problem

The declarative schema differ detects a "name-matched object whose body changed"
by rendering a **canonical body string** on both sides and comparing byte-equal:

- declared side — rendered from the parsed AST (`ast-stringify.ts`),
- actual side — lifted from the stored schema through the *same* renderer
  (`ddl-generator.ts`'s `indexToCanonicalDDL` / `constraintToCanonicalDDL`).

Every bare column-name identifier in those bodies flows through
`quoteIdentifier(name)`, which **preserves case**. On the actual side `name` is
the stored column *definition* case (`tableSchema.columns[i].name`); on the
declared side it is whatever case the user typed in the index/constraint column
list. When those two diverge the bodies compare unequal and the differ schedules
a needless **drop+recreate** (index) or **drop+add** (constraint) — on *every*
diff, never converging. The produced object is correct; the work is just wasted
(plus churn in migration output and `require-hint` accounting).

This is **pre-existing** — it already affects the named-constraint UNIQUE / FK /
referenced-column lists and was inherited by the index body-drift path. It only
fires when a column reference's case diverges from the column definition's case
within the same declared schema — unusual but legal.

## Resolved design

### The quoted-identifier question is settled: fold like unquoted.

The ticket asked whether Quereus treats a double-quoted column name as
case-sensitive (SQL-standard) or folds it like an unquoted one. Two engine facts
settle it:

1. **The AST does not track quoting.** The lexer emits `TokenType.IDENTIFIER`
   with the *unquoted* value for double-quoted / backtick / bracket forms, and
   the parser's `getIdentifierValue` (parser.ts ~line 3781) returns that value
   verbatim — no case fold, **no "was-quoted" flag**. So `"Email"` and `Email`
   parse to the *identical* AST node `{ name: 'Email' }`. There is no information
   downstream that could make a quoted reference behave case-sensitively.
2. **Column resolution is uniformly case-insensitive.** Every resolver folds with
   `.toLowerCase()` — `columnIndexMap.get(name.toLowerCase())`, `resolve.ts`,
   `planner/analysis/predicate-shape.ts`, `coverage-prover.ts`,
   `rename-rewriter.ts`, and `schema-differ.ts`'s own `pkSequencesEqual`.

Therefore Quereus has **no** SQL-standard case-sensitive quoted identifiers, and
**blanket-lowercasing the bare column name** in the canonical body is correct: it
matches resolution semantics exactly, and both declared and actual sides funnel
through the same renderer so they agree after lowercasing.

`quoteIdentifier` still runs *after* the lowercase, so a reserved-word column name
(e.g. `Order`) lowercases to `order` and quotes as `"order"` on both sides —
keyword detection is already case-insensitive (`KEYWORDS[name.toLowerCase()]`), so
quoting is unaffected.

### What gets normalized (and what does not)

Normalize bare column-name identifiers in the canonical **column lists** only:

| Path | Renderer (canonical-only entry point) | Source of column name |
|------|----------------------------------------|------------------------|
| Index column list | `canonicalIndexedColumnsToString` | `indexedColumnBareName(col)` |
| UNIQUE column list | `constraintBodyToCanonicalString` → `tableConstraintsToString` | `tc.columns[].name` |
| FK local (child) column list | same | `tc.columns[].name` |
| FK referenced (parent) column list | same → `foreignKeyClauseTail` | `tc.foreignKey.columns[]` |
| PK column list | helper covers `primaryKey` for symmetry | `tc.columns[].name` |

**PK note:** the live PK drift comparison is `pkSequencesEqual`, which *already*
lowercases both sides — so PK normalization in the renderer has **no behavioral
effect** today (the differ excludes PRIMARY KEY from `collectDeclaredNamedConstraints`
and never routes it through `constraintBodyToCanonicalString`). It is included in
the shared helper purely so the renderer family stays internally consistent if a
PK ever flows through it. Do not change `pkSequencesEqual`.

**Persistence is untouched.** Apply the lowercase inside the *canonical-only*
functions, operating on cloned AST copies. The user-facing / persistence
renderers — `indexedColumnsToString`, `createIndexToString`, `generateIndexDDL`,
and `tableConstraintsToString` *called directly* from `generateTableDDL` /
`alterTableToString` — must keep emitting the original case. (`generateTableDDL`
re-parses its own output on store rehydration, so the case must round-trip there.)

### Out of scope (parked → `backlog/canonical-body-identifier-case-beyond-column-lists`)

- **Column references embedded in CHECK expressions / partial-index WHERE
  predicates.** These render via `expressionToString` (column nodes →
  `quoteIdentifier(expr.name)`), so a case-divergent reference inside a CHECK/WHERE
  can still churn. Lower-frequency than the column-list bug (both sides store the
  *as-written* reference, so churn needs a case change *between versions*, not just
  definition≠reference at declaration time) and requires expression-tree walking
  that must preserve string literals — a distinct change.
- **FK referenced *table* name case** (`fk.table`). A table identifier, also
  case-insensitive, but distinct from column-name normalization.

Both are captured in the backlog ticket so they are not lost.

## Implementation shape

`ast-stringify.ts`:

- In `canonicalIndexedColumnsToString`, lowercase the extracted bare name before
  `quoteIdentifier` (keep the `expressionToString(col.expr)` fallback for genuine
  expression-index columns unchanged):
  ```ts
  const name = indexedColumnBareName(col);
  if (name) {
    const lower = name.toLowerCase();
    return col.direction === 'desc' ? `${quoteIdentifier(lower)} desc` : quoteIdentifier(lower);
  }
  ```
- Add a small clone-and-lowercase helper and apply it inside
  `constraintBodyToCanonicalString` (NOT inside `tableConstraintsToString`). It
  must never mutate the input — the declared side passes `d.bodyAst`, which backs
  `ddl`/`definition` in the differ:
  ```ts
  function lowercaseTableConstraintColumnNames(tc: AST.TableConstraint): AST.TableConstraint {
    switch (tc.type) {
      case 'primaryKey':
      case 'unique':
        return tc.columns ? { ...tc, columns: tc.columns.map(c => ({ ...c, name: c.name.toLowerCase() })) } : tc;
      case 'foreignKey':
        return {
          ...tc,
          columns: tc.columns?.map(c => ({ ...c, name: c.name.toLowerCase() })),
          foreignKey: tc.foreignKey
            ? { ...tc.foreignKey, columns: tc.foreignKey.columns?.map(n => n.toLowerCase()) }
            : tc.foreignKey,
        };
      default:
        return tc; // 'check' — no column list (refs live in the expr, parked)
    }
  }
  ```
  Then, in `constraintBodyToCanonicalString`, lowercase *before* the existing
  `canonicalCheckOperations` / `canonicalForeignKeyClause` normalization so
  `canonicalForeignKeyClause` reads the already-lowercased referenced columns:
  ```ts
  let normalized: AST.TableConstraint = lowercaseTableConstraintColumnNames({ ...tc, name: undefined, tags: undefined });
  // ...existing check-operations / FK-clause normalization unchanged...
  ```
- No change expected in `ddl-generator.ts` — `indexToCanonicalDDL` and
  `constraintToCanonicalDDL` already funnel through the shared renderers, so the
  actual side picks up the lowercase automatically. Verify, don't edit.

## Edge cases & interactions

- **Reserved-word column in mixed case** (`Order`/`"Order"`): lowercases to
  `order`, `quoteIdentifier` re-quotes to `"order"` on both sides → equal. No
  over-/under-quoting regression.
- **Collate-folded index column** (`col COLLATE x`): `indexedColumnBareName`
  extracts the name from `col.expr.expr.name`; lowercase that. Collation stays
  excluded from the canonical body (unchanged).
- **Genuine expression-index column** (no resolvable bare name): unchanged
  `expressionToString(col.expr)` fallback — *not* lowercased. Acceptable: such
  indexes are rejected on import and never name-match a real actual.
- **Elided FK referenced-column list** (`references parent` with no `(...)`):
  `tc.foreignKey.columns` is undefined → `?.map` stays undefined → no synthesized
  list; `canonicalForeignKeyClause` still collapses empty/absent to `undefined`.
- **Mutation safety**: the declared side passes `d.bodyAst` (immutable — backs
  `ddl`/`definition`); the helper clones the column arrays, so `d.bodyAst` is
  never touched. Confirm `reconciledDeclaredBody` (rename reconciliation) still
  converges: it builds its own clones and calls `constraintBodyToCanonicalString`,
  so reconciled-declared and actual both lowercase — rename + case reconciliation
  composes correctly.
- **PK regression guard**: confirm `pkSequencesEqual` is untouched and PK
  persistence DDL (`generateTableDDL` `PRIMARY KEY (...)`) still emits the
  definition case.
- **Persistence fixed-point guard**: the index-ddl-roundtrip emission tests and
  the "re-generating DDL from the imported schema is a fixed point" test
  (index-ddl-roundtrip.spec.ts ~line 227) assert original-case output — they must
  still pass, proving the persistence path was not lowercased.
- **CHECK still churns on case-divergent expr refs** (parked): a CHECK whose
  expression references a column in a different case than its definition can still
  drop+recreate. Documented limitation; covered by the backlog ticket.

## Key tests (TDD targets)

Add to `index-ddl-roundtrip.spec.ts` → `describe('CREATE INDEX DDL round-trip: declarative differ stability', …)`:

- **Index column-case no-churn**: table column declared `Email`, index declared
  over `email` (and the symmetric case) → `diff.indexesToCreate` and
  `diff.indexesToDrop` both empty, `tablesToAlter` empty. Use the existing
  `diffIndexEdit(baseline, modified)` helper with the same case on both sides of
  the apply→declare boundary so only the case divergence is under test (declare
  the column as `Email` in the `TABLE`, reference it as `email` in the index).
- **Composite mixed-case no-churn**: `index ix on t (Name, Active)` declared vs
  columns `name`, `active` → empty diff.
- **Negative (still recreates)**: a genuine column-set/order/direction change is
  unchanged (existing tests at lines ~431–461 must stay green).

Add to `declarative-equivalence.spec.ts` (near the
`named-constraint body change (drop+recreate)` / `named-constraint lifecycle`
describes):

- **UNIQUE column-case no-churn**: column `Email`, `constraint uq unique (email)`
  → no `constraintsToDrop`/`constraintsToAdd` on re-declare.
- **FK column-case no-churn**: child FK whose local and/or referenced column case
  differs from the definitions → no drop+add. Cover the referenced (parent)
  column list specifically (it renders through `foreignKeyClauseTail`).
- **Negative (still recreates)**: an actual body change (e.g. UNIQUE column set
  change, FK `ON DELETE` action change) still drop+adds — existing body-change
  tests must stay green.

## TODO

- Lowercase the bare name in `canonicalIndexedColumnsToString`
  (`ast-stringify.ts`).
- Add `lowercaseTableConstraintColumnNames` and apply it in
  `constraintBodyToCanonicalString` (before the existing FK/check normalization),
  on a non-mutating clone.
- Verify (no edit) `indexToCanonicalDDL` / `constraintToCanonicalDDL` pick up the
  lowercase via the shared renderers; do NOT touch `pkSequencesEqual` or the
  persistence renderers.
- Add the index mixed-case no-churn cases to `index-ddl-roundtrip.spec.ts`.
- Add the UNIQUE + FK (local and referenced) mixed-case no-churn cases to
  `declarative-equivalence.spec.ts`.
- Run `yarn workspace @quereus/quereus test` (Mocha) and the package lint
  (single-quote the glob on Windows); confirm the persistence fixed-point and
  existing body-change tests stay green.
- If anything in `docs/schema.md` documents the canonical-body comparison /
  drift detection, add a sentence that bare column-name identifiers are
  case-folded in the canonical body (matching column resolution).
