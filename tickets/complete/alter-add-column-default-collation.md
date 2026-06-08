description: Make `apply schema` idempotent under a non-BINARY `default_collation` when ADDing a column. Two composable fronts: (A) the declarative differ emits an explicit resolved `COLLATE` for added columns; (B) the execution-layer ADD COLUMN path (memory/store/isolation) honors the session `default_collation`. RENAME COLUMN deliberately stays BINARY-resolving (derived-DDL path). Implemented, reviewed, and landed.
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/logic/43.1-default-collation.sqllogic, docs/schema.md, docs/sql.md
----

## Summary

The original bug: under `default_collation = nocase`, an `apply schema` that needed to *add* a
text column created it as `BINARY` (the ADD COLUMN path hard-resolved an omitted `COLLATE` to
`BINARY`) while the declared side resolved to `NOCASE` — so every re-apply emitted a spurious
`ALTER TABLE … SET COLLATE NOCASE`. Non-idempotent.

Both fronts landed as the ticket specified:

- **A — differ emits explicit resolved COLLATE** (`schema-differ.ts`). New helper
  `withResolvedAddColumnCollation(col, defaultCollation)` clones the declared `ColumnDef` (never
  mutates the AST) and appends an explicit `{ type: 'collate', collation: <resolved> }` when the
  column omits `COLLATE` and `resolveDefaultCollation(inferType(col.dataType), defaultCollation)
  !== 'BINARY'`. The `columnsToAdd` loop routes every added column through it, so generated ADD
  COLUMN DDL is self-contained (portable across sessions with different defaults) and idempotent.
- **B — execution layer honors `default_collation` on ADD COLUMN only**. Threaded
  `db.options.getStringOption('default_collation')` as the 3rd arg of `columnDefToSchema` at the
  three ADD COLUMN sites: memory `manager.ts:1425`, store `store-module.ts:702`, isolation
  `isolation-module.ts:900` (symmetry only — that site reads `.notNull`/`.name`; the underlying
  memory/store table materializes the real column).
- **RENAME COLUMN left alone** (`manager.ts:1606`, `store-module.ts:884` still call
  `columnDefToSchema(def, defaultNotNull)`, no 3rd arg). RENAME reconstructs its AST from the live
  column via `buildConstraintsFromColumn` (explicit `COLLATE` only for non-BINARY), so threading
  the default there would silently flip an existing BINARY column to the session default.

## Review findings

**Verdict: implementation is correct and complete.** No major findings; two minor gaps fixed
inline. Confirmed the RENAME carve-out is correct (the reviewer agrees: threading the default into
the rename path would be a regression).

### Checked — sound, no change needed
- **All `columnDefToSchema` call sites enumerated** (9 total). CREATE (`manager.ts:1361`) and the
  three ADD COLUMN sites are threaded; the two RENAME sites correctly omit the 3rd arg;
  `createBasicSchema` (`table.ts:421`) is a programmatic test/internal helper, not a user-DDL path,
  so BINARY is correct there; `table.ts:240` is the definition. No ADD COLUMN site was missed.
- **`runAddColumn` does not re-resolve collation** (`alter-table.ts:251+`): it uses the schema
  returned by `module.alterTable` (front B) and merges only column-level CHECK/FK — so the module's
  resolved collation flows through to the engine catalog unchanged.
- **Explicit COLLATE wins over the threaded default** in `columnDefToSchema`'s constraint loop
  (the `case 'collate'` overwrites the default-resolved initial value). So front A's explicit
  `COLLATE NOCASE` + front B's threaded default never conflict (no double-apply).
- **RENAME carve-out verified by test and by reasoning**: renamed BINARY stays BINARY, renamed
  NOCASE stays NOCASE. The deliberate omission of the 3rd arg is correct.
- **Isolation threading is inert but harmless**: `deriveAddColumnBackfill` reads only
  `.notNull`/`.name`; the underlying memory/store ADD COLUMN (both threaded) materializes the real
  collation.
- **`collationExplicit` asymmetry is benign**: front A sets it `true` (explicit COLLATE) while a
  direct `ALTER … ADD COLUMN` via front B leaves it `false` (implicit default). The only consumer,
  the store's `reconcilePkCollations`, gates on PK columns — and ADD COLUMN rejects PK columns, so
  that path is never reached. The differ compares collation *value*, not the flag, so no diff churn.

### Minor findings — fixed inline this pass
- **Cross-session portability was asserted structurally but never tested** (the implementer flagged
  this as the top belt-and-suspenders gap). Added a test
  (`declarative-equivalence.spec.ts`, "an ADD COLUMN migration emitted under nocase lands NOCASE
  when replayed under a BINARY session"): emits the migration DDL under `nocase`, asserts it carries
  an explicit `COLLATE NOCASE`, then replays it in a fresh BINARY-default database and asserts the
  column lands `NOCASE`. Passes.
- **`docs/sql.md` § 9.2.4 was out of date**: it framed `default_collation` as a "create-time
  authoring convenience only" and only mentioned CREATE TABLE. ADD COLUMN now honors it too. Updated
  the semantics paragraph to document ADD COLUMN honoring the default and RENAME COLUMN deliberately
  not (mirroring the `docs/schema.md` change the implementer already made). Reworded the lead from
  "create-time" to "schema-authoring".

### Not pursued — low value, same code path
- **RTRIM on ADD COLUMN** and **JSON/temporal ADD COLUMN under a non-BINARY default** are not
  separately tested. Both flow through the identical `resolveDefaultCollation` type-gate already
  exercised by the NOCASE (text → resolves) and INTEGER (non-text → BINARY) ADD COLUMN cases, so the
  behavior is covered structurally. Not worth a ticket.

## Validation performed (all green, post-edit)

- `yarn workspace @quereus/quereus run build` → EXIT 0.
- `@quereus/store` build + `@quereus/isolation` build → EXIT 0.
- `yarn workspace @quereus/quereus run lint` → EXIT 0 (clean, including the new test).
- Full memory suite (`node test-runner.mjs`): **5407 passing**, 9 pending, EXIT 0 (was 5406 + the
  one new cross-session test).
- Store-mode suite (`node test-runner.mjs --store`): **5401 passing**, 14 pending, EXIT 0 — covers
  the store `addColumn` path and a persisted-DDL reopen via sqllogic `43.1`. (The trailing
  "Failed to rehydrate DDL" stack is an expected negative rehydrate test; EXIT 0 confirms.)
- Targeted `default_collation` declarative-equivalence block: **7 passing** (the 4 implementer cases
  + the 3 pre-existing pragma cases + the new cross-session case — 7 in that describe block).

## Notes for downstream
- The two fronts are independent and both correct; neither relies on the other. A — emit-layer
  idempotency/portability; B — direct-user-`ALTER` parity with CREATE.
- The `docs/schema.md` collation paragraph (DDL-generation reference) and `docs/sql.md` § 9.2.4
  (user-facing pragma reference) now both reflect the ADD-COLUMN-honors / RENAME-does-not reality.
