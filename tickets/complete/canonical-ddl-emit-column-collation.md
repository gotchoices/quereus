description: |
  Canonical table DDL now emits a column-level `COLLATE <name>` clause so a
  non-default column collation survives a re-parse of the canonical DDL (notably
  the @quereus/store persistence round-trip). Before this, `formatColumnDef`
  dropped COLLATE entirely and a `collate nocase` column silently reverted to
  BINARY on reopen. Reviewed, validated, and completed.
files:
  - packages/quereus/src/schema/ddl-generator.ts                  # formatColumnDef: COLLATE emission (mirrors generateIndexDDL)
  - packages/quereus/test/ddl-generator-roundtrip-positions.spec.ts  # generator unit tests (+ inline-PK+COLLATE round-trip added in review)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts         # collation-survives-reopen round-trip test
  - docs/schema.md                                                # DDL-generation feature-coverage list updated to include column COLLATE (added in review)
  - tickets/.pre-existing-error.md                                # flags an unrelated (flaky) optimizer-timeout failure
prereq:
----

# Emit column-level COLLATE in canonical table DDL — COMPLETE

## What shipped

`formatColumnDef` (`ddl-generator.ts:300`) now emits
`COLLATE ${quoteIdentifier(col.collation)}` when
`col.collation && normalizeCollationName(col.collation) !== 'BINARY'`, placed
after the nullability annotation and before the inline `PRIMARY KEY`. Added the
`normalizeCollationName` import. No parser/AST/schema change — `columnDefToSchema`
already maps the `'collate'` column constraint back to `schema.collation` via
`validateCollationForType` → `normalizeCollationName`.

Closes a gap where the canonical table DDL dropped COLLATE, so a non-default
column collation reverted to BINARY on any re-parse of the DDL — most visibly
the `@quereus/store` close → reopen → `rehydrateCatalog` round-trip — silently
changing the column's comparison / sort / unique semantics.

## Review findings

### Read fresh, then verified against the handoff

Read the implement diff (`a0171daf`) before the handoff summary. The change is
small, correct, and well-scoped; the handoff was accurate. Detailed checks:

- **Emission condition & quoting** — `col.collation && normalizeCollationName(...) !== 'BINARY'`
  correctly elides both `'BINARY'` and `''` (and case-folds `'binary'`).
  Conditional `quoteIdentifier` matches the index-column path: `COLLATE NOCASE`
  bare, `COLLATE "select"` quoted. Confirmed against the `quoteName` vs
  `quoteIdentifier` policy documented in the generator header.
- **No differ churn (the key interaction)** — confirmed the declarative differ
  compares the *parsed-declared AST* collation (`extractDeclaredCollation`,
  defaulting absent → `'BINARY'`) against the *actual-catalog* collation, **not**
  the canonical DDL string. Adding COLLATE to canonical DDL therefore introduces
  no spurious ALTER/DROP. The existing `declarative-equivalence` collation tests
  still pass.
- **Completeness — other column-emitting paths** — checked for sibling
  generators that also drop COLLATE. `buildConstraintsFromColumn`
  (`alter-table.ts:1489`) and `columnDefToString` (`ast-stringify.ts`) already
  carry collation; `formatColumnDef` was the lone gap. The change brings them
  consistent. No other path needs touching.
- **Type safety / cleanup** — `col.collation` is a required `string`; the truthy
  guard handles `''`. No `any`, no resource concerns, single-purpose edit.

### Tests checked (happy / edge / round-trip / regression)

- **Full `@quereus/quereus` suite: 4976 passing, 9 pending, 0 failing (exit 0).**
  The runner uses `--bail`, so a clean exit means *every* test passed this run —
  including the optimizer IND test the handoff reported as failing (see
  "pre-existing" below).
- **Store round-trip** `non-default column COLLATE survives reopen` — passes;
  resolves `@quereus/quereus` from source so it exercises the live change.
- **Lint** (`packages/quereus`) — clean (exit 0).

### Minor findings — FIXED INLINE

1. **Untested inline-PK + COLLATE combination** (the handoff flagged it as
   "eyeball only"). Added a generator test asserting the combined spelling
   `"id" TEXT COLLATE NOCASE PRIMARY KEY` round-trips and that **both** the
   collation and the inline PK survive the re-parse (two-column table to stay off
   the synthesized all-columns-key path). Green.
2. **Stale docs** — `docs/schema.md` DDL-generation "feature coverage" list
   enumerated `PRIMARY KEY` / `DEFAULT` / `USING` / `WITH TAGS` but **omitted
   COLLATE**. Updated the list to include non-default column `COLLATE <name>`
   (default `BINARY` elided), noting the persistence-survival behavior.

### Major findings

**None.** No new fix/plan/backlog tickets filed.

### Pre-existing failure (left for runner triage)

`tickets/.pre-existing-error.md` flags a 2000ms timeout in
`optimizer/inclusion-dependencies.spec.ts` ("propagated INDs never over-claim").
It is a **flaky wall-clock timeout** in a subsystem this diff never touches: the
isolated test runs ~3s against a 2000ms limit, and under the full suite it
**passed** in both of my runs (`--bail` exit 0). Genuinely unrelated to this
ticket; left in place so the runner's triage pass can address the intermittent
timeout out-of-band. Do not chase it under this ticket.

### Explicitly out of scope (confirmed, not silently skipped)

- **Store-side per-column collation encoders** — `docs/store.md` carries a
  standing TODO (per-column collation for keys/indexes) about the store's binary
  *ordering* encoders. That is orthogonal to DDL round-trip schema preservation;
  this ticket only restores the rehydrated **schema's** `collation` field. No
  `store.md` change needed.
- **`yarn test:store`** (slower LevelDB-path re-run) — not executed; the store
  DDL path is covered by the new mocha test in the store package's own suite,
  which passed. A release-prep run can exercise it.
- **Index-path COLLATE verbosity** — `generateIndexDDL` emits `COLLATE` for any
  truthy collation (including `BINARY`), unlike the new column path which elides
  the default. Pre-existing, harmless (re-parses correctly), and out of scope.

## Validation summary

- `node test-runner.mjs --reporter spec` → 4976 passing, 9 pending, 0 failing.
- Store: `rehydrate-catalog.spec.ts` COLLATE test → passing.
- `yarn lint` (packages/quereus) → clean.
- New generator tests (reserved-word sweep, bare/quoted, default elision,
  inline-PK+COLLATE round-trip, columnDefToSchema round-trip) → all green.
