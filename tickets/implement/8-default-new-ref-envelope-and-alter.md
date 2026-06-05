description: Extend `new.<column>` DEFAULT references (read a populated sibling — landed for single-source INSERT + CREATE TABLE) to the two remaining default paths: the shared-key view-write "envelope" (anchor-key default + per-member defaults) and the ALTER TABLE default paths (ADD COLUMN backfill + ALTER COLUMN SET DEFAULT). Route both through the same row-scoped build + shared DDL validator the INSERT / CREATE TABLE paths already use, so the override surface stays "one mechanism".
files: packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/46-mutation-context.sqllogic, docs/sql.md, docs/runtime.md, docs/view-updateability.md
----

## Background (what already landed)

A column `DEFAULT` may now read a value the INSERT **supplies** for a sibling column via
`new.<column>` (e.g. `slug text default (lower(new.title))`). Only INSERT-supplied columns
are visible — a default never depends on another column's default (no evaluation-order race);
referencing an omitted column is a clean resolution error.

Two cooperating pieces deliver this on the **single-source INSERT** + **CREATE TABLE** paths:

- **Build (`planner/building/insert.ts` → `createRowExpansionProjection`)** — `defaultCtxFor()`
  builds, lazily, a `RegisteredScope` (parented on the mutation-context scope) that registers each
  source-supplied column under `new.<col>` and bare `<col>` (the bare form skipped when a
  same-named mutation-context variable shadows it). Omitted columns are deliberately absent.
- **DDL validation (`schema/manager.ts` → `validateDefaultDeterminism` / `rejectIllegalReferences`)**
  — a `new.`-qualified column passes the bare-column rejection pre-walk, and when a default reads
  `new.<col>` (`defaultReferencesNewRow`) the build/determinism check is **deferred to INSERT time**
  (the row scope isn't available at CREATE TABLE), exactly like mutation-context identifiers and
  self-referencing subqueries.

This ticket closes the two paths that still reject or ignore `new.<col>`.

## The invariant to preserve

`new.<col>` means **"the value of sibling column `col` for the row this default is being applied
to, at the moment it is applied."** On INSERT that is the INSERT-supplied value; the two paths
below must read the same way (supplied envelope column; existing row's column during backfill).
Only columns that *have* a value at apply time are visible — never another column's pending default.

---

## Path A — Shared-key view-write "envelope"

`planner/building/view-mutation-builder.ts` decomposes a view INSERT across base tables and
materializes a surrogate/shared key by evaluating an **anchor key column's DEFAULT once per logical
row**, then threads the value across the fan-out via the equivalence class (the "evaluate-once-and-
thread" envelope — see `docs/view-updateability.md` § Mutation context, `docs/lens.md` shared-key).

Two sub-sites:

- **Anchor-key default — `buildKeyDefault()` (~lines 527–538).** Builds the key DEFAULT against the
  bare global `ctx`:
  ```ts
  const node = buildExpression(ctx, keyDefault) as ScalarPlanNode;
  if (!ctx.db.options.getBooleanOption('nondeterministic_schema')) {
      validateDeterministicDefault(node, '<shared key>', view.name);
  ```
  `ctx.scope` has no row columns, so a key default like
  `default (coalesce((select max(id) from anchor), 0) + new.tenant_id)` cannot resolve `new.tenant_id`.
  **Fix:** build the key default against a row-scoped context that registers the envelope's
  **supplied** columns as `new.<col>` (and bare `<col>`), mirroring `defaultCtxFor()` in `insert.ts`.
  The envelope already has the user-supplied source columns in hand (it is built from the view-INSERT
  source) — the registration must target *those* attributes. Factor the scope-building helper out of
  `insert.ts` so both sites share one implementation rather than duplicating the registration loop.

- **Per-member defaults — `buildDecompositionMemberInsert()` (~lines 556–605).** Each member INSERT
  re-enters `buildInsertStmt(ctx, memberInsert, [], projectedSource)` (~line 599), which *does* run
  `createRowExpansionProjection` (so `new.` is wired) — **but** `projectedSource` is an
  `EnvelopeScanNode` exposing envelope columns, not the original user source. Verify a member-column
  default `new.<sibling>` resolves against the correct envelope attribute (column-name alignment
  between the member's `targetColumns` and the envelope projection). If alignment holds this is free;
  if not, align the names/attributes so member defaults read supplied siblings consistently with the
  single-source path.

---

## Path B — ALTER TABLE default paths

`runtime/emit/alter-table.ts`. These bypass the shared CREATE-TABLE validators today (noted in
`docs/runtime.md` § Determinism Validation: "These DDL-time guards currently fire only on
`CREATE TABLE`").

- **ADD COLUMN — `runAddColumn()` (~lines 188–213).** Currently requires the default to fold to a
  literal:
  ```ts
  if (defaultConstraint && defaultConstraint.expr && tryFoldLiteral(defaultConstraint.expr) === undefined) {
      throw new QuereusError(`ALTER TABLE ADD COLUMN DEFAULT … must fold to a literal …`);
  ```
  This rejects `new.<col>` outright and means you cannot even *add* a column whose default reads a
  sibling for future inserts. **Fix (load-bearing decision below):** allow a `new.<col>` default —
  validate it through the shared DDL validator (with the `new.` allowance + INSERT-time deferral),
  store it on the column schema so **future** inserts resolve it via `createRowExpansionProjection`,
  and **backfill existing rows by per-row evaluation** with the existing row in scope (no longer a
  single folded literal). A non-`new.`, non-literal, non-deterministic default stays rejected.

- **ALTER COLUMN SET DEFAULT — `runAlterColumn()` (~lines 486–530).** Passes `setDefault` straight to
  `module.alterTable(...)` with **no** validation (memory module just assigns it —
  `vtab/memory/layer/manager.ts` ~lines 1697–1707: `newCol = { ...oldCol, defaultValue: change.setDefault }`).
  **Fix:** route the new default through the same validator CREATE TABLE uses (rejecting bare columns
  / bind params / non-determinism, allowing `new.` with deferral), so the stored default is consistent
  with what INSERT will accept.

### Load-bearing decision — ADD COLUMN backfill semantics

`new.<col>` for a *future* insert = the INSERT-supplied sibling. For **backfilling existing rows**
there is no INSERT — `new.<col>` must mean **the existing row's sibling value**. That is the same
"row this default is applied to" reading, and it is coherent (the row exists; read its column), but
it changes ADD COLUMN backfill from "one literal for every row" to "evaluate the default per existing
row." Implement the backfill as the moral equivalent of `update <t> set <newcol> = <default over the row>`
over the pre-existing rows, reusing the row-scoped default build. If the backfill-per-row scope turns
out to be materially more than the envelope + SET DEFAULT work, **split ADD-COLUMN-backfill into its
own implement ticket** (chain via `prereq:`) rather than growing this one — the envelope + SET DEFAULT
+ ADD-COLUMN-stores-default-for-future-inserts slice still stands alone.

---

## Tests

- **Envelope (`test/logic/93.4-view-mutation.sqllogic`)** — a view whose anchor-key default reads a
  supplied sibling via `new.<col>`; assert the threaded key derives correctly across the fan-out and
  every member row agrees on identity. A member-table column default reading `new.<sibling>` resolves
  to the supplied value.
- **ADD COLUMN (`test/logic/03.4-defaults.sqllogic` or a sibling file)** — `alter table t add column
  c integer default (new.base * 2)` over a table with pre-existing rows: existing rows backfill from
  their own `base`; a subsequent insert supplying `base` derives `c`; a subsequent insert omitting
  `base` raises the resolution error (parity with the single-source path). Pre-existing literal-fold
  ADD COLUMN cases keep passing.
- **SET DEFAULT** — `alter column … set default (new.x)` is accepted (deferred), then exercised by a
  later insert; a bare-column / non-deterministic SET DEFAULT is now rejected at ALTER time (closing
  the silent-accept gap).
- **Mutation context coexistence (`test/logic/46-mutation-context.sqllogic`)** — `new.<col>` +
  context variable through the envelope and through SET DEFAULT, mirroring the single-source Test 11.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log` and
  `yarn workspace @quereus/quereus lint`.

## TODO

### Phase 1 — share the row-scoped default scope
- Extract the `new.`/bare source-column registration from `insert.ts` `defaultCtxFor()` into a small
  reusable helper (e.g. `buildRowDefaultScope(ctx, contextScope, targetColumns, sourceAttributes, mutationContext)`),
  keeping the lazy-on-first-expression-default behavior on the INSERT path.

### Phase 2 — envelope
- Use the shared helper in `buildKeyDefault()` so the anchor-key default resolves `new.<col>` against
  the supplied envelope columns; keep the determinism deferral consistent with INSERT.
- Verify/align `buildDecompositionMemberInsert()` so per-member defaults read supplied siblings
  through the `EnvelopeScanNode` source.

### Phase 3 — ALTER paths
- Route `runAlterColumn()` SET DEFAULT through the shared DDL validator (allow `new.`, defer; reject
  bare/non-det).
- `runAddColumn()`: allow a `new.` (or otherwise non-literal but valid) default — validate, store for
  future inserts, and backfill existing rows by per-row evaluation with the row in scope. (Split to a
  `prereq:` ticket if backfill grows large.)
- Update the `docs/runtime.md` note that says ALTER paths don't route through the validators.

### Phase 4 — docs + gate
- Extend `docs/sql.md` § Default Values and `docs/view-updateability.md` to state `new.<col>` works at
  the envelope anchor key and through ALTER (with the backfill = existing-row semantics).
- Tests above pass; lint clean.
