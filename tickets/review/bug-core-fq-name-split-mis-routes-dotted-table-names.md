description: A table whose quoted name contains a dot (e.g. a table literally named "a.b") was mis-identified inside the SQL engine's change-tracking code, so materialized-view conflict checks and explain output looked up the wrong table or none; the name splitting is fixed so the full name survives.
prereq:
files:
  - packages/quereus/src/util/qualified-name.ts                # NEW splitBaseKey helper
  - packages/quereus/src/core/database-watchers.ts             # :82 getRowCount
  - packages/quereus/src/core/database-assertions.ts           # :149 getRowCount, :303 pkIndicesByBase
  - packages/quereus/src/core/database-materialized-views.ts   # :979 plan.sourceBase
  - packages/quereus/src/func/builtins/explain.ts              # :1031 assertion-explain prepared params
  - packages/quereus/test/dotted-table-name.spec.ts            # NEW regression spec
difficulty: medium

# Review: core engine `schema.table` keys re-split on `.` for dotted table names

## What the fix does

The core engine keys a base table as a flat lowercased string `` `${schema}.${table}` ``.
Five sites recovered the `(schema, table)` pair with `base.split('.')` and took the
first two elements, so a quoted table name containing a dot (`create table "a.b"` →
key `main.a.b`) was truncated to table `'a'` and the `.b` segment dropped.

Added one shared helper, `splitBaseKey(base)` in
`packages/quereus/src/util/qualified-name.ts`, that splits on the **first** dot only,
and routed all five recovery sites through it. The flat key format is unchanged; only
the destructuring sites changed. The construction sites (watcher `tables` sets, `mvKey`,
`relationToBase`, delta-executor keys) already built and compared the whole key and were
not touched.

Sites changed:
- `database-watchers.ts:82` — `getRowCount` (harmless: feeds cost estimation; wrong/missing → `undefined` fallback).
- `database-assertions.ts:149` — `getRowCount` (harmless: same costing fallback).
- `database-assertions.ts:303` — `pkIndicesByBase` construction for per-tuple assertion residual dispatch.
- `database-materialized-views.ts:979` — `lookupCoveringConflicts` source-table resolution.
- `explain.ts:1031` — `explain_assertion` prepared-param column names.

## How to validate

Build + suite + lint all green on this branch:
- `npx tsc -b tsconfig.build.json` — exit 0.
- `yarn workspace @quereus/quereus run test` — **6916 passing**, 13 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsc -p tsconfig.test.json` typecheck of specs).
- New spec alone: `yarn workspace @quereus/quereus run test:single "packages/quereus/test/dotted-table-name.spec.ts"` — 3 passing.

The regression spec (`packages/quereus/test/dotted-table-name.spec.ts`) has three cases,
all over a table literally named `"a.b"`:

1. **Materialized view — strict discriminator.** A covering MV over `"a.b"` with a
   UNIQUE(x,y). When a covering MV is linked it is the *sole* enforcement structure
   (the auto-index is skipped), so a bad source resolution isn't masked. Pre-fix:
   `plan.sourceBase.split('.')` → `_findTable('a')` → undefined → `lookupCoveringConflicts`
   returns `[]` → the duplicate `(5,5)` is silently admitted (2 rows). Post-fix: the
   duplicate raises `UNIQUE constraint failed: a.b (x, y)` and a distinct `(6,6)` still
   inserts.

2. **Assertion — correctness floor (NOT a strict discriminator; see gaps).** An
   assertion `not exists (select 1 from "a.b" where balance < 0)` fires at commit on a
   violating update and the transaction rolls back; a compatible update still commits.

3. **Explain — strict discriminator.** `explain_assertion` on a GROUP-classified
   assertion over `"a.b"`. The emitted `base` is `main.a.b` and `prepared_pk_params` is
   `["id"]`. Pre-fix the truncated `'a'` never resolved to a table, so
   `prepared_pk_params` was `NULL`.

## Known gaps / honesty notes (treat the tests as a floor)

- **The assertion residual site (`database-assertions.ts:303`) is a *harmless* degrade,
  not a wrong-result bug.** When `pkIndicesByBase` lacks an entry for the base, the delta
  executor's `if (!pkIndices)` guard (`runtime/delta-executor.ts:210`) falls back to a
  full **global** re-evaluation of the violation query — still correct, just not the
  per-tuple residual path. So an assertion over a dotted table fires pre-fix too; case 2
  above confirms correct behavior but does **not** flip red→green across the fix. The
  strict proof that the dotted table now *resolves* for PK/key purposes (the same
  `_findTable(splitBaseKey(base))` recovery this site shares with explain) is the GROUP
  explain test, case 3. A reviewer wanting a strict end-to-end assertion discriminator
  would need to observe *which* path ran (per-tuple vs global) — I did not find a clean
  SQL-observable way to do that.
- **No ROW-classified explain case.** I tried a per-row assertion
  (`not exists (select 1 from "a.b" where balance < 0)`) for a second explain
  discriminator, but `explain_assertion` emits **zero** classification entries for that
  EXISTS shape (`analyzeRowSpecific` produces no row/group binding for it), so there was
  nothing to assert. The GROUP case covers the identical recovery site, so this is
  redundant, not a coverage hole — but noted so nobody re-hunts it.
- **The two `getRowCount` sites are untested.** They feed cost estimation only (a wrong
  or missing count degrades to an `undefined` estimate), so there is no SQL-observable
  behavior to pin. Left uncovered deliberately.
- **Dotted *schema* names remain unsupported.** `splitBaseKey` splits on the first dot,
  which is unambiguous only when the schema name has no dot. A dotted schema name is
  still ambiguous — this is a **tripwire**, documented in the helper's JSDoc
  (`qualified-name.ts`) and matching the accepted convention already used by the
  `@quereus/store` and `@quereus/sync` fixes for the same defect class. Not work now;
  only becomes work if dotted schema names ever become reachable.

## Not done (out of scope per ticket)

The ideal fix — carrying the `(schema, table)` pair forward instead of re-splitting a
joined key — was explicitly deferred: the flat key is embedded across the delta-executor
Map keys, `mvKey`, and `relationToBase`. The first-dot split at the recovery sites is the
scoped fix and matches the store/sync fixes. The key representation was not refactored.
