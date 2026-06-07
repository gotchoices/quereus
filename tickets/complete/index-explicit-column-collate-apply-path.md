description: Live CREATE INDEX accepts an explicit per-column COLLATE (`create index ix on t (col collate nocase [desc])`) via the parser's collate-folded form, and the persistence emitter keeps the trailing asc/desc for that form. Implemented and reviewed; complete. Surfaced a latent planner correctness bug (collation-mismatched index seek drops the residual predicate) filed as `index-collation-mismatch-residual-filter`.
files:
  - packages/quereus/src/schema/manager.ts                 # buildIndexSchema now calls resolveImportedIndexColumn (shared with importIndex)
  - packages/quereus/src/emit/ast-stringify.ts             # indexedColumnsToString folded-expr branch re-appends `desc`
  - packages/quereus/test/index-ddl-roundtrip.spec.ts      # +3 apply-level tests (added explicit COLLATE, first-declare, DESC); un-skipped desc+collate no-churn
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic  # negative section repurposed to positive feature + KNOWN GAP note
  - docs/sql.md                                            # §6.3 example now shows per-column COLLATE on CREATE INDEX
  - tickets/fix/index-collation-mismatch-residual-filter.md  # NEW fix ticket — surfaced planner correctness bug
----

# Live CREATE INDEX explicit per-column COLLATE (apply path + emitter) — complete

## What landed

- **`buildIndexSchema`** (`manager.ts` ~2052): the old `if (indexedCol.expr) throw` +
  `indexedCol.name`/`.collation` reads were replaced by a single
  `resolveImportedIndexColumn(indexedCol)` call — the exact helper `importIndex`
  already uses. It unwraps the parser's collate-folded form (`col COLLATE x` →
  `{name, collation}`), passes a bare `col.name` through, and returns an unset name
  for a genuine expression index (still rejected with `Indices on expressions are
  not supported yet.`). Collation resolution is now identical on the create and
  import paths (explicit index COLLATE → table column collation → BINARY, via
  `normalizeCollationName`). Module-agnostic, so the store catalog path inherits it.
- **`indexedColumnsToString`** (`ast-stringify.ts` ~902): the folded-expr branch now
  re-appends ` desc` when `col.direction === 'desc'` (asc stays elided). The
  collation itself was already rendered by `expressionToString`; only the direction
  was dropped.

## Review findings

**Disposition:** implementation correct as landed; one **minor** test gap and one
**minor** docs gap fixed inline; one **major** correctness bug was already correctly
filed as a separate fix ticket by the implementer (verified, not re-filed).

### Checked — implementation correctness
- **`resolveImportedIndexColumn` reuse (DRY):** confirmed the helper is module-level
  and shared verbatim with `importIndex`; the two call sites now resolve name +
  collation identically, eliminating the prior divergence. Good.
- **Parser direction capture:** verified `indexedColumn()` (`parser.ts` ~3804) parses
  ASC/DESC *after* the (folded collate) expression, so `col COLLATE x DESC` yields
  `{expr: <collate>, direction: 'desc'}` — `buildIndexSchema`'s `desc:
  indexedCol.direction === 'desc'` reads it correctly, and the emitter re-appends it.
  No double-`desc` (the collate expr never renders direction).
- **Emitter order consistency:** folded branch renders `<col> collate <c>` then
  ` desc` — same name/collate/desc order as the plain `col.name` branch and the
  canonical-body renderer. Consistent.
- **Throw `loc`:** the expression-index rejection uses `indexedCol.expr?.loc`; for a
  genuine expression index `expr` is always set, and a bare-name column never reaches
  the throw, so the optional chaining is purely defensive. Fine.
- **Removed error message:** `Indexed column must be a simple column name.` confirmed
  to have **zero** remaining references (code, tests, docs). Clean removal.
- **Composite / mixed forms:** each column is resolved independently, so
  `(a, b collate nocase, c desc)` is handled per-column. No issue.

### Checked — surfaced correctness bug (MAJOR, correctly deferred)
- **Reproduced the bug directly** (memory backend): `where name = 'BOB'` returns
  `[{id:2}]` before an index and `[{id:2},{id:4}]` after
  `create index … (name collate NOCASE)` — wrong rows, as the handoff claimed.
  A NOCASE index seek satisfies a BINARY equality without retaining the BINARY
  predicate as a residual filter. The fix ticket
  (`index-collation-mismatch-residual-filter`) accurately captures root cause,
  repro, affected files, and the preferred seek-then-residual fix. **Disposition:**
  correctly major and out of this ticket's create-path/emitter scope — left filed,
  not pulled into this pass. The `06.4.2` section's `KNOWN GAP` comment correctly
  documents the gap and does **not** pin the buggy output; the corrected assertion
  is to be restored when that fix lands.
- Confirmed nothing else in the suite silently depends on the buggy path: the full
  memory suite passes with the corrected assertion *omitted* (not pinned to the wrong
  value), so no test encodes the defect.

### Found + fixed inline (MINOR)
- **Missing apply-level DESC coverage:** the handoff flagged that no test asserted an
  `(email collate nocase desc)` index round-trips its DESC through a real apply +
  `index_info`. `index_info` does expose a `desc` column, so this was a real gap.
  Added `a descending explicit-COLLATE index applies and the catalog carries both
  DESC and the collation` to `index-ddl-roundtrip.spec.ts` — applies the folded DESC
  form, asserts `index_info('t')` reports `{collation: 'NOCASE', desc: 1}`, and that
  a verbatim re-declare converges with zero churn. (Roundtrip spec: 63 → 64 passing.)
- **Docs:** `docs/sql.md` §6.3 examples omitted per-column COLLATE even though live
  `CREATE INDEX (col collate …)` was previously rejected and is now supported (the
  grammar at ~3963 already lists it). Added an example showing `(email collate nocase
  desc)` plus a note that a bare `col COLLATE x` is a per-column collation, not an
  expression index. `docs/schema.md` (~171) already documented the import-side
  collate-folded handling and remains accurate.

### Checked — no action needed
- **`index_info` PK-not-reported assumption:** the new tests assert `index_info('t')`
  returns a single row. Confirmed `index_info` lists only `table.indexes` (+ exposed
  implicit covering indexes); the implicit PK is not materialized as a listed index,
  so the single-row assertions are sound and consistent with the existing import test.
- **Store path:** unchanged from handoff — create flows through the same
  module-agnostic `buildIndexSchema`; the targeted `06.4.2` store run was already
  green. No store-specific logic in this diff.

## Validation (this review)
- `yarn workspace @quereus/quereus test` (memory): **5234 passing, 9 pending, 0 failing**.
- Full sqllogic suite: **229 passing** (includes `06.4.2-collation-extras`).
- `index-ddl-roundtrip.spec.ts`: **64 passing** (was 63; +1 DESC apply test added this pass).
- `yarn workspace @quereus/quereus typecheck`: clean.
- `yarn workspace @quereus/quereus lint`: clean (after the test addition).

## Follow-on (tracked elsewhere — not part of this ticket)
- `index-collation-mismatch-residual-filter` (fix/) — the surfaced planner
  correctness bug; restores the corrected `where name = 'BOB' → [{id:2}]` assertion
  in `06.4.2` once landed.
- Out-of-scope from the source ticket (left as-is, benign for memory + current store):
  `generateMigrationDDL` emits `CREATE INDEX` before `ALTER COLUMN … SET COLLATE` for
  a column-collation-driven recreate; only a stale-key hazard on a hypothetical future
  backend that keys secondary indexes by per-column collation AND resolves index
  collation from the column at CREATE INDEX time.

## End
