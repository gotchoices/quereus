description: Coerce NEW.* values to column logical types before queueing deferred CHECK rows (GitHub #25)
files: packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic, docs/runtime.md
----
GitHub issue: https://github.com/gotchoices/quereus/issues/25

## What was done

Deferred CHECK constraints comparing `new.*` against rows stored in other tables
failed for logical types that rewrite values on parse (e.g. `datetime`). Stored
rows are coerced on insert, but the `new.*` values snapshotted for deferred
evaluation were raw, so equality (`P.TS = new.ParentTS`) spuriously failed at
COMMIT.

The fix adds `coerceNewSection(row, tableSchema)` in `emit/constraint-check.ts`,
which clones the flat OLD/NEW row and coerces only the NEW section (indices
`n..2n-1`) via `validateAndParse(value, column.logicalType, column.name)` — exactly
mirroring `MemoryTableManager.performInsert/performUpdate` and the store path's
`coerceRow`. Per-cell parse failures fall back to the raw value so the row's own
`performInsert` stays the authoritative MISMATCH source. The single deferred-queue
call site (`checkCheckConstraints`) now passes the coerced snapshot instead of
`row.slice()`. OLD values are left raw (NULL on INSERT, already-coerced stored rows
on UPDATE); `committed.*` comes from stored coerced data, so coercing NEW alone also
covers transition constraints.

Regression coverage was added to `test/logic/43-transition-constraints.sqllogic`
(memory-backed): positive numeric→datetime #25 repro, negative no-match, alternate
textual representation, and (added in review) INSERT + UPDATE coverage of the shared
call site.

## Review findings

### Verified correct
- **Fix mirrors storage coercion exactly.** `coerceNewSection` uses the same
  `validateAndParse(value, column.logicalType, column.name)` per NEW cell as
  `vtab/memory/layer/manager.ts` performInsert/performUpdate and
  `quereus-store/.../store-table.ts coerceRow`. Index math (`numCols + i`) matches the
  flat `[OLD(0..n-1), NEW(n..2n-1)]` layout produced by `emit/insert.ts`.
- **Single call site; correct ordering.** Only one `_queueDeferredConstraintRow`
  site exists. The row reaching `checkCheckConstraints` already reflects NOT NULL
  DEFAULT substitution (`checkConstraints` assigns `row = nnResult.replacedRow`
  before calling it), so coercion sees substituted defaults too. The live pipeline
  row is untouched (helper builds a fresh slice).
- **Test genuinely catches the bug.** Reverted the fix to `row.slice()` and ran the
  43 file in isolation: the positive #25 repro fails ("CHECK constraint failed:
  ParentExists"). Restored; confirmed `git diff --stat` clean afterward.
- **Lint / build / tests pass.** `yarn workspace @quereus/quereus run lint` (exit 0),
  `build` (exit 0), `test` (3642 passing, 9 pending, exit 0) — both before and after
  the review's test additions.
- **Fallback-on-throw reasoning holds.** A value that fails `validateAndParse` keeps
  its raw form in the snapshot; the same row fails its own `performInsert`
  downstream, so net behavior is unchanged for genuinely invalid rows.

### Fixed inline (minor)
- **Stale doc.** `docs/runtime.md` § Deferred Constraints showed the old
  `row.slice() as Row` queueing snippet and never mentioned NEW coercion. Updated the
  snippet to `coerceNewSection(row, tableSchema)` and added a paragraph explaining
  why NEW is coerced before queueing (GitHub #25), the OLD-section rationale, and the
  parse-failure fallback.
- **UPDATE path was untested.** The fix covers INSERT *and* UPDATE (shared call site)
  but tests only exercised INSERT. Added an UPDATE positive (numeric NEW matching a
  numeric-stored parent — exercises `coerceNewSection` on the UPDATE path) and an
  UPDATE negative (no matching parent → deferred CHECK fires).

### Filed as new ticket (major)
- **`fix/datetime-coercion-not-canonical`** — DATETIME (and likely DATE/TIME)
  coercion is **not canonical**: a numeric epoch coerces to
  `"2017-07-14T02:40:00+00:00[UTC]"` (ZonedDateTime), while the equivalent ISO string
  coerces to `"2017-07-14T02:40:00"` (PlainDateTime — `parse` tries `PlainDateTime.from`
  first and silently drops the offset/zone), and `DATETIME.compare` uses
  `BINARY_COLLATION`, so they compare unequal. This is a pre-existing, broader
  correctness bug (affects any number-vs-string datetime comparison in queries, joins,
  and constraints) that this fix neither caused nor can address. Discovered when an
  initial review UPDATE test crossed representations and failed; that test was narrowed
  to numeric-vs-numeric to stay within this fix's scope, and the cross-representation
  case is deferred to the new ticket. Note: the pre-existing "alternate textual"
  INSERT case only passes because a textual-stored parent sits at the same instant —
  it does not actually prove textual-NEW vs numeric-stored equality.

### Checked, nothing to do
- **contextRow coercion** — intentionally out of scope (context values are evaluated
  expressions not necessarily typed to this table's columns; #25 does not implicate
  them). No change; would be a separate ticket if a need arises.
- **Other deferred-queue sites** — none; `_queueDeferredConstraintRow` has exactly one
  caller.
- **Resource cleanup / type safety** — helper is pure, allocates one fresh array per
  deferred row (deferred path only, acceptable), no new resources. Types are explicit
  (`Row`, `SqlValue`, `TableSchema`); no `any`.

## Validation performed (review)
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — 3642 passing, 9 pending, exit 0.
- Single-file run of `43-transition-constraints.sqllogic` with the fix reverted —
  positive case fails as expected (proves the test catches the regression); restored.
- **Store path not run** (`yarn test:store`, slower / not agent-runnable by default).
  The store path shares coercion via `coerceRow`, so behavior should match; a human or
  CI can spot-check if desired.
