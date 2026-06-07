description: Canonical-body drift renderers now case-fold bare column-name identifiers (index column list; named-constraint UNIQUE / PK / FK local + referenced column lists) so a column reference whose case diverges from the column definition no longer churns a spurious drop+recreate / drop+add on every diff. Persistence renderers keep original case. Implemented + tested; ready for review.
files:
  - packages/quereus/src/emit/ast-stringify.ts            # canonicalIndexedColumnsToString (~853 lowercase); lowercaseTableConstraintColumnNames helper (~1394) applied in constraintBodyToCanonicalString (~1436)
  - packages/quereus/src/schema/ddl-generator.ts          # actual side — VERIFIED no edit (indexToCanonicalDDL / constraintToCanonicalDDL funnel through the shared renderers)
  - packages/quereus/src/schema/schema-differ.ts          # declared side — VERIFIED no edit (pkSequencesEqual untouched; reconciledDeclaredBody composes via the shared renderer)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # +2 index mixed-case no-churn cases in "declarative differ stability"
  - packages/quereus/test/declarative-equivalence.spec.ts # +3 UNIQUE / FK-local / FK-referenced mixed-case no-churn cases in "named-constraint body change"
  - docs/schema.md                                        # case-fold note added to the constraint (#436) and index (#440) body-change sections
  - tickets/backlog/canonical-body-identifier-case-beyond-column-lists.md  # parked: CHECK-expr refs + FK referenced TABLE name (pre-existing, created by plan stage)
----

# Canonical-body column-name case normalization — review handoff

## What changed (one idea)

The declarative differ detects a "name-matched object whose body changed" by rendering a
**canonical body string** on both the declared-AST side and the actual-catalog side and
comparing byte-equal. Every bare column-name identifier flowed through `quoteIdentifier`,
which **preserves case**. The actual side renders the column *definition* case
(`tableSchema.columns[i].name`); the declared side renders the as-written index/constraint
*reference* case. When those diverge, the bodies compared unequal and the differ scheduled a
needless **drop+recreate** (index) / **drop+add** (constraint) on *every* diff, never
converging. Fix: lowercase bare column-name identifiers **inside the canonical-only
renderers**, matching Quereus's uniformly case-insensitive column resolution (the AST never
tracks identifier quoting; every resolver folds via `.toLowerCase()`).

Two surgical edits, both in `ast-stringify.ts`:

1. `canonicalIndexedColumnsToString` — lowercase the bare name before `quoteIdentifier`
   (the `expressionToString(col.expr)` fallback for genuine expression-index columns is
   left unchanged / un-lowercased).
2. `lowercaseTableConstraintColumnNames` (new, non-mutating clone helper) applied at the top
   of `constraintBodyToCanonicalString`, **before** the existing `canonicalCheckOperations` /
   `canonicalForeignKeyClause` normalization (so the FK-clause normalizer reads already-
   lowercased referenced columns). Covers UNIQUE / PRIMARY KEY column lists, the FK local
   (child) column list, and the FK referenced (parent) column list. CHECK passes through
   unchanged (no column list — its refs live in the expression, parked).

`quoteIdentifier` still runs *after* the lowercase, so a reserved-word column name re-quotes
correctly on both sides (`Order` → `order` → `"order"`; keyword detection is already
case-insensitive).

## Why no differ / ddl-generator edits

Both the declared side (`schema-differ.ts`) and the actual side (`ddl-generator.ts`'s
`indexToCanonicalDDL` / `constraintToCanonicalDDL`) funnel through the same two shared
renderers, so the actual side picks up the lowercase automatically. A `find_references` sweep
confirmed these are the **only** callers of the canonical renderers — no external consumer
relies on the canonical body preserving case. Verified, not edited.

## Persistence is deliberately untouched

The user-facing / persistence renderers keep original case: `indexedColumnsToString`,
`createIndexToString`, `generateIndexDDL`, and `tableConstraintsToString` *called directly*
from `generateTableDDL` / `alterTableToString`. The lowercase lives only in the
`canonical*`/`*BodyToCanonicalString` family. This matters because `generateTableDDL`
re-parses its own output on store rehydration — the declared casing must round-trip there.
**Guard:** the emit round-trip specs (`emit-roundtrip-positions`, `emit-roundtrip-property`,
175 passing) and the index-ddl-roundtrip **fixed-point** test (`generateIndexDDL` is a fixed
point over import, asserts original-case output) all stayed green.

## Tests (the floor — please probe beyond these)

All five new cases were confirmed to **fail without the fix** (stashed the source edit and
re-ran: 5 failing with the exact `constraintsToDrop`/`constraintsToAdd` churn shown; restored
→ 0 failing), so they genuinely pin the bug rather than tautologically pass.

- `index-ddl-roundtrip.spec.ts` → "declarative differ stability":
  - **index column-case no-churn** — column `Email`, index over `email` (definition≠reference
    within one declaration) → empty `indexesToCreate`/`indexesToDrop`/`tablesToAlter`.
  - **composite mixed-case no-churn** — columns `name`/`active`, index `(Name, Active)`.
- `declarative-equivalence.spec.ts` → "named-constraint body change (drop+recreate)":
  - **UNIQUE column-case no-churn** — column `Email`, `constraint uq unique (email)`.
  - **FK local column-case no-churn** — child column `PA`, `foreign key (pa) references …`.
  - **FK referenced (parent) column-case no-churn** — *between-versions*: apply
    `references parent(PID)`, re-declare `references parent(pid)`. (Necessary because
    `referencedColumnNames` is stored **as-written**, see "Subtlety" below — it can only
    diverge across re-declares, not within one declaration like the local/index columns.)
  - Negative cases (genuine column-set / order / direction / UNIQUE-set / FK-action changes
    still drop+recreate) are the pre-existing tests at index-ddl-roundtrip ~431–461 and the
    body-change describe — all stayed green.

Full package suite: **5195 passing, 9 pending, 0 failing**. `tsc --noEmit` clean; `eslint`
clean on the changed file.

### Suggested reviewer probes
- A `desc` / collation-folded index column whose **case** also diverges (e.g. column `Email`,
  index `email COLLATE NOCASE DESC`) — confirm the collate-fold name extraction
  (`indexedColumnBareName` → `col.expr.expr.name`) still lowercases and excludes collation.
- A reserved-word column name in mixed case used in a UNIQUE/index (e.g. column `Order`,
  `unique ("ORDER")`) — confirm `order` re-quotes to `"order"` on both sides, no over/under
  quoting.
- An end-to-end `apply` convergence for a mixed-case UNIQUE/FK (not just the diff decision),
  mirroring the index "applying a body change converges" test — confirms the no-churn diff
  also means no spurious migration DDL executes.

## Known gaps / honest limitations

- **CHECK-expression & partial-index WHERE column refs are NOT folded.** A CHECK / partial
  index whose expression references a column in a different case than its definition can still
  churn. Lower-frequency (both sides store the as-written reference, so churn needs a case
  change *between versions*) and needs expression-tree walking that must preserve string
  literals — a distinct change. Parked in `backlog/canonical-body-identifier-case-beyond-
  column-lists` (also covers **FK referenced *table* name** case — a table identifier, distinct
  from column-name normalization).
- **PK normalization is inert today.** The live PK drift comparison is `pkSequencesEqual`,
  which already lowercases both sides; PRIMARY KEY is excluded from
  `collectDeclaredNamedConstraints` and never routes through `constraintBodyToCanonicalString`.
  The helper covers `primaryKey` purely for renderer-family consistency. `pkSequencesEqual` was
  **not** touched (verify).
- **Subtlety worth re-checking:** `referencedColumnNames` is stored **as-written**
  (`constraint-builder.ts`: `referencedColumnNames: fk.columns`), not resolved to the parent
  definition case. So the FK *referenced*-column bug is a between-versions case, while the FK
  *local* / UNIQUE / index column bugs are definition≠reference within a single declaration
  (the actual side lifts the definition case there). The FK-referenced test reflects this; a
  reviewer might want a stronger/realer scenario for it.
- **`yarn test:store` (LevelDB store path) was NOT run.** Rationale: the change touches only
  the in-memory canonical-comparison renderers, not the persistence DDL path (store
  rehydration uses `tableConstraintsToString` / `generateIndexDDL` directly, which are
  unchanged). Low-risk but unverified end-to-end on the store module — flag for the reviewer to
  decide whether a store-path spot check is warranted.

## Pre-existing failures

None encountered. No `tickets/.pre-existing-error.md` was written.
