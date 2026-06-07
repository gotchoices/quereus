description: Make the live CREATE INDEX path accept an explicit per-column COLLATE (`create index ix on t (col collate nocase [desc])`) instead of rejecting it as an expression index, and fix the persistence emitter to keep the trailing `asc`/`desc` for that collate-folded column form. Unblocks the differ-emitted explicit-COLLATE recreate from ticket 2.1 (index-canonical-body-collation), which now produces such recreate DDL.
prereq:
files:
  - packages/quereus/src/schema/manager.ts            # buildIndexSchema (~2046-2079) — swap the column mapping to mirror importIndex; resolveImportedIndexColumn (~2506) + importIndex loop (~2457-2472) are the working reference
  - packages/quereus/src/emit/ast-stringify.ts         # indexedColumnsToString (~894-906) — folded `col.expr` branch drops direction; createIndexToString (~908) is the caller
  - packages/quereus/test/index-ddl-roundtrip.spec.ts  # un-skip PENDING (~659); extend "adding an explicit index COLLATE recreates" (~589) with an apply-level assertion; TABLE const at line 359
----

# Live CREATE INDEX must support explicit per-column COLLATE (and persistence must keep its direction)

## Root cause (both confirmed in source)

The parser's `indexedColumn()` (parser.ts ~3804) folds an indexed column written
as `col COLLATE x` into `{ expr: <collate-expr over column>, direction }` — there
is no bare `col.name` and no top-level `col.collation` (the collation sits on
`col.expr.collation`). Two downstream paths do not understand that folded form:

1. **`buildIndexSchema` — the LIVE create path** (manager.ts ~2052-2054) throws
   `Indices on expressions are not supported yet.` whenever `indexedCol.expr` is
   set. Because the parser folds *every* explicit COLLATE into `expr`, this means
   `create index ix on t (col collate nocase)` always fails to execute. It also
   reads `indexedCol.collation`, which is `undefined` for the folded form — so even
   without the throw it would silently drop the collation.

2. **`indexedColumnsToString` — the persistence emitter** (ast-stringify.ts
   ~903-905), reached via `createIndexToString`. Its `else if (col.expr)` branch
   returns `expressionToString(col.expr)` with no trailing direction, so
   `create index ix on t (email collate nocase desc)` re-emits as
   `create index ix on t (email collate nocase)` — `desc` is dropped.

## The reference implementation already exists

The catalog-IMPORT path already handles the folded form correctly and is the
template for fix (1):

- `resolveImportedIndexColumn(col)` (manager.ts ~2506) unwraps the folded form to
  `{ name, collation }`: a bare `col.name` passes through; a `collate` expr over a
  bare column reference unwraps to `{ name: expr.expr.name, collation: expr.collation }`;
  anything else returns `{ name: undefined, … }` (a genuine expression index).
- `importIndex`'s column loop (manager.ts ~2457-2472) maps each column through it,
  rejects an unresolved name, looks up the column index, and builds
  `{ index, desc: col.direction === 'desc', collation: normalizeCollationName(collation || tableColSchema.collation || 'BINARY') }`.

`buildIndexSchema` produces the identical `IndexColumnSchema` shape — only its
column-mapping body differs. It is a module-level function in the same file, so
`buildIndexSchema` can call `resolveImportedIndexColumn` directly.

## Required behavior

- `create index ix on t (col collate <c>)` and `… collate <c> desc` build a valid
  `IndexSchema` through the live path, resolving column + per-column collation
  exactly as `importIndex` does (explicit index COLLATE → table column collation →
  BINARY; normalized via `normalizeCollationName`).
- A genuine expression index (non-column operand, e.g. `lower(col)`) must still be
  rejected — keep the `Indices on expressions are not supported yet.` error when
  `resolveImportedIndexColumn` returns an unset name. (`importIndex` throws a
  differently-worded error for the same case; keep `buildIndexSchema`'s existing
  message so its error text and `loc` are unchanged for non-COLLATE expression
  indexes.)
- `createIndexToString` / `indexedColumnsToString` emit the trailing `desc` for the
  collate-folded form (asc is the default and stays elided, matching the plain
  `col.name` branch). The collation itself is already rendered by
  `expressionToString(col.expr)` — only the direction is missing.
- End-to-end: the differ-emitted explicit-COLLATE recreate from 2.1 applies, and an
  unchanged explicit-COLLATE index re-declared verbatim produces zero churn AND
  applies.

## Out of scope (carry forward, do NOT implement here)

The ticket's **"Secondary: migration apply ordering"** note (`generateMigrationDDL`
emits `CREATE INDEX` before the `ALTER COLUMN … SET COLLATE` for a
column-collation-driven recreate) is **currently benign** — verified: the memory
backend returns correct collation-aware results after the sequence, and the store
backend keys secondary indexes under a single table-level collation, so a
per-column SET COLLATE does not re-key them. It becomes a real stale-key hazard
only on a future backend that keys secondary indexes by per-column collation AND
resolves index collation from the column at CREATE INDEX time. Leave the ordering
as-is; do not change `generateMigrationDDL` here. (Candidate fix (b) — emitting an
explicit `COLLATE <resolved>` on the recreate — would *depend* on this ticket's
apply-path fix, but is a separate future concern.)

## Validation

- `yarn workspace @quereus/quereus test` (memory backend) — run the full suite;
  pay attention to `test/index-ddl-roundtrip.spec.ts`.
- `yarn lint` (single-quote globs on Windows).
- Store backend: the explicit-COLLATE create now flows into the store catalog path
  too. Run `yarn test:store` if time permits (slower) to confirm the recreate
  applies against the LevelDB store; if it exceeds the agent idle budget, stream it
  (`… 2>&1 | tee /tmp/store.log; tail -n 80 /tmp/store.log`) or defer to CI and note
  the deferral in the review handoff.

## TODO

- In `buildIndexSchema` (manager.ts ~2052-2070), replace the
  `if (indexedCol.expr) throw …` block and the `indexedCol.name` / `indexedCol.collation`
  reads with a `resolveImportedIndexColumn(indexedCol)` call, mirroring `importIndex`'s
  loop: reject an unresolved name (keep the existing `Indices on expressions are not
  supported yet.` message + `loc`), look up the column via `columnIndexMap`, and build
  `{ index, desc: indexedCol.direction === 'desc', collation: normalizeCollationName(collation || tableColSchema.collation || 'BINARY') }`.
- In `indexedColumnsToString` (ast-stringify.ts ~903-905), in the `else if (col.expr)`
  branch, build `let colStr = expressionToString(col.expr); if (col.direction === 'desc') colStr += ' desc'; return colStr;`.
- Un-skip the PENDING test "an explicit COLLATE on a descending column (collate-folded
  form), re-declared verbatim, does not churn" (index-ddl-roundtrip.spec.ts ~659) and
  drop its now-stale PENDING comment.
- Extend "adding an explicit index COLLATE recreates the index" (~589) — or add a
  sibling end-to-end test — with an APPLY-level assertion: using the `db.exec('declare
  schema main { … }')` → `db.exec('apply schema main')` pattern (see the convergence
  test at ~546), declare `index ix on t (email)`, apply, re-declare `index ix on t
  (email collate nocase)`, apply, and assert the migration applies cleanly and a re-diff
  is empty (converged) with the catalog index carrying `nocase`.
- Add an apply-level test that an explicit-COLLATE index re-declared verbatim
  (`index ix on t (email collate nocase)` both times) applies on first declare and
  produces zero churn on re-apply.
- After fixes pass, sanity-check the original end-to-end repro from the source ticket
  (declare `t(email)` + `index ix on t (email)`, apply; re-declare with
  `index ix on t (email collate nocase)`, apply) no longer throws
  `Indices on expressions are not supported yet.`.
