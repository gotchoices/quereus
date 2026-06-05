description: Per-row CHECK enforcement for ADD COLUMN with a non-foldable (per-row) DEFAULT. The plan-build guard rejecting DEFAULT(new.<col>)+CHECK was removed and replaced with per-row CHECK evaluation inside the backfill hook (mirrors the working NOT NULL per-row path). A violating backfilled row aborts the ALTER and leaves the table unchanged on both the memory and store modules.
files: packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, docs/runtime.md
----

## What shipped

`ALTER TABLE … ADD COLUMN … DEFAULT (<non-foldable>) CHECK (<predicate over new col>)`
now enforces the new column's CHECK against every backfilled existing row. A
violating row aborts the ALTER and leaves the table unchanged (no column added,
catalog restored). The interim `StatusCode.UNSUPPORTED` plan-build guard was
removed.

### Mechanism

CHECK predicates are compiled at plan-build time (`buildAddColumnChecks` in
`planner/building/alter-table.ts`) against a row scope covering the existing
columns plus the new column, hung on `AlterTableNode` as `AddColumnCheck`, and
evaluated inside the per-row backfill hook (`runAddColumn` in
`runtime/emit/alter-table.ts`) against `[...existingRow, backfilledValue]`. A
violation throws mid-loop; because both modules accumulate into a local structure
(memory: local btree swapped in only after the loop; store: batch written only
after the loop) and only commit after the backfill completes, the throw discards
in-progress work and propagates out before `schema.addTable(...)` — so the catalog
is never mutated. No module code changed. The post-backfill scan
(`validateBackfillAgainstChecks`) is now gated on `!backfill` — it remains correct
only for the literal-default path. The compiled CHECKs are also merged into the
table-level constraint set so future INSERT/UPDATE enforce them.

## Review findings

### Read with fresh eyes
Read the full implement diff (commit `145400dd`) across the building node, plan
node, emitter, and tests before the handoff summary. Traced the no-rollback claim
into both modules: `memory/layer/base.ts recreatePrimaryTreeWithNewColumn` builds
a local `newTree` and assigns `this.primaryTree` only after the loop;
`quereus-store/.../store-table.ts migrateRows` accumulates into a `batch` and calls
`batch.write()` only after the loop (line 330). Both confirmed: a throw inside the
engine-supplied evaluator discards partial work and the catalog stays untouched.
Verified write-time CHECK truthiness in `constraint-check.ts:352` (`result ===
false || result === 0`) matches the backfill path exactly — parity holds.

### Bug found & fixed (minor, in this pass)
- **Collation parity gap.** `buildAddColumnChecks` minted the new column's
  `Attribute` without `collationName`, while the existing-column attributes set it.
  A CHECK comparing a `COLLATE NOCASE` new column to a literal would resolve BINARY
  at backfill time but the declared collation at write time — a silent divergence.
  Fixed by carrying `columnDef`'s `collate` constraint into the attribute's
  `collationName`. Added a regression test (`ac_chk_coll`) that passes only when the
  declared collation drives the backfill-time comparison (confirmed: the engine
  consults declared column collation, and the fix wires it through on both modules).

### Test coverage added (the implementer flagged these gaps; all now covered)
- **Multiple CHECKs, all pass** (`ac_chk_multi_ok`) — exercises the N-predicate loop.
- **Multiple CHECKs, the *second* fails** (`ac_chk_multi_bad`) — confirms every
  predicate is enforced, not just the first; table left unchanged.
- **Future-insert enforcement** (`ac_chk_future`) — after a successful per-row CHECK
  ADD COLUMN, a later INSERT violating the CHECK is rejected (merged table-level
  CHECK works post-ALTER).
- **Collation parity** (`ac_chk_coll`) — see above.
All new cases run on both memory and store (`03.4` is re-run by `yarn test:store`).

### Checked, no action needed
- **Empty table** — backfill loop never runs, so no CHECK is evaluated at ALTER
  time (correct: nothing to validate); future inserts enforce via the merged
  table-level CHECK. The analogous NOT NULL empty-table case (`ac_empty`) already
  exists; no separate empty+CHECK case added (behavior is structurally identical —
  zero iterations).
- **Slot ordering / arg bookkeeping** — `params` is `[backfill?, ...checks]` and
  checks are only ever compiled when `backfill` exists, so `args.slice(1)` is
  correct; the dead `backfill ? 1 : 0 → 0` branch is harmless.
- **`inferType(columnDef.dataType)`** — accepts `string | undefined` (defaults to
  BLOB), so a typeless ADD COLUMN is safe.
- **Type coercion of the backfilled value** — the CHECK evaluates the same
  uncoerced value the module stores (`[...row, value]` vs `[...oldRow, value]`), so
  check-time and stored value are mutually consistent. Any default-vs-declared-type
  coercion question is a pre-existing backfill concern, not introduced here.
- **Generated columns** — carry no DEFAULT, so `backfill`/`checks` are undefined;
  unaffected.

### Filed as follow-up (major, pre-existing, out of scope)
- **`tickets/backlog/alter-add-column-backfill-fk-enforcement.md`** — a column-level
  FOREIGN KEY on ADD COLUMN is merged for future INSERT/UPDATE but existing
  (backfilled) rows are never validated against the parent, for any default kind.
  This pre-dates this work and is independent of CHECK; the per-row hook introduced
  here is the natural place to fix it. An inline FOLLOW-UP comment in `runAddColumn`
  already marks the gap.

### Docs
- `docs/runtime.md` ALTER-TABLE validation section described the old
  "rejected at plan-build time (`StatusCode.UNSUPPORTED`)" behavior. Rewritten to
  document the split-by-default-kind CHECK enforcement, the per-row hook /
  no-rollback mechanism, write-time truthiness parity, collation carry-through, and
  the table-level merge. (No other doc mentioned the old limitation.)

### Validation
- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- `03.4` memory + store → pass; `90.2.1` memory → pass
- Full memory logic suite (`--no-bail`) → **4800 passing, 9 pending, 0 failing**.
  The failure the implementer flagged (`41.7.1-alter-column-collate-unique`) was
  resolved by the runner's triage commit `19fdd6b7` (fixed `memory/layer/base.ts`
  and removed `.pre-existing-error.md`) before this review; suite is fully green.
