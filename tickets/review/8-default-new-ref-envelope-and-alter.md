description: Review the `new.<column>` DEFAULT extension to the shared-key view-write envelope (anchor-key + member defaults) and to ALTER COLUMN SET DEFAULT. ADD COLUMN was deliberately split into a follow-up implement ticket (`add-column-new-ref-backfill`); this ticket does NOT touch the ADD COLUMN path.
prereq:
files: packages/quereus/src/planner/building/default-scope.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/46-mutation-context.sqllogic, docs/sql.md, docs/runtime.md, docs/view-updateability.md
----

## What landed

Extended the `new.<column>` DEFAULT surface (previously: single-source INSERT + CREATE TABLE)
to **two** of the three remaining default paths. The third (ALTER TABLE ADD COLUMN) was split
into `tickets/implement/…-add-column-new-ref-backfill.md` — see "Deliberate scope cut" below.

### Phase 1 — shared row-scoped default scope (no behavior change)
- New `packages/quereus/src/planner/building/default-scope.ts` exporting
  `buildRowDefaultScope(parentScope, targetColumns, sourceAttributes, mutationContextVarNames?)`.
  It registers each supplied column under `new.<col>` and the bare `<col>` (bare skipped when a
  same-named mutation-context variable shadows it).
- `insert.ts` `defaultCtxFor()` now calls the helper instead of inlining the registration loop.
  The lazy-on-first-expression-default behavior on the INSERT hot path is preserved.

### Phase 2 — shared-key view-write envelope (`view-mutation-builder.ts`)
- **Anchor-key default** (`buildKeyDefault`): now builds the key default against a row scope
  (via `buildRowDefaultScope`) that exposes the envelope's supplied view columns as `new.<col>`
  (and bare `<col>`). It mints **fresh** attributes for those columns and returns a `RowDescriptor`
  alongside the compiled node. Fresh attrs (not the `EnvelopeScanNode` attrs) keep the reference
  self-contained so the optimizer cannot dangle a cross-subtree by-id reference.
- `MutationEnvelope` gained `keyDefaultRowDescriptor?: RowDescriptor`; `ViewMutationNode.withChildren`
  preserves it.
- **Runtime** (`view-mutation.ts` `materializeEnvelope`): installs a `createRowSlot` over that
  descriptor and `slot.set(row)` per source row **before** the `__shared_key` is appended, so the
  key default's `new.<col>` refs resolve to the supplied values. Torn down in `finally`.
- **Member defaults**: verified to be free — each member insert already re-plans through
  `buildInsertStmt` → `createRowExpansionProjection`, which wires `new.<col>` against the member's
  envelope projection (member `targetColumns` align positionally with the projection). A new test
  exercises `label text default (lower(new.email))` on a member table.

### Phase 3 — ALTER COLUMN SET DEFAULT (`alter-table.ts` + `manager.ts`)
- `SchemaManager.validateDefaultDeterminism` was refactored: per-default core extracted into
  `validateOneDefault`, planning-ctx construction into `makeDdlValidationContext`. New **public**
  `validateAlterColumnDefault(expr, columnName, tableName, hasMutationContext)` routes a single
  default through the identical checks CREATE TABLE uses.
- `runAlterColumn` calls it for a non-null `setDefault` (DROP DEFAULT skips validation). Bind
  params / bare columns / non-determinism are now rejected at ALTER time (closing the
  silent-accept gap noted in the ticket); `new.<col>` is accepted with the build deferred to INSERT.

### Phase 4 — docs
- `docs/sql.md` § Default Values, `docs/runtime.md` § Determinism Validation (the "ALTER paths don't
  route through validators" note updated — SET DEFAULT now does, ADD COLUMN still pending), and
  `docs/view-updateability.md` § Mutation Context (`new.<col>` reaches the envelope anchor key + members).

## How to validate / use

- `yarn workspace @quereus/quereus test` — **4740 passing, 0 failing** at handoff.
- `yarn workspace @quereus/quereus lint` — clean.
- Targeted: `node test-runner.mjs --grep "File: (03.4-defaults|93.4-view-mutation|46-mutation-context)\.sqllogic"`

### Use cases now covered (tests are the floor, not the ceiling)
- **Envelope anchor key** (`93.4-view-mutation.sqllogic` block (j)): a join view whose anchor key
  default is `coalesce((select max(rid) from ek_core), 0) + new.seq` — the minted key derives from
  the supplied sibling `new.seq` (rids 5/3, *not* the 1/2 ordinals), evaluated once per row, threaded
  to both members; a second insert observes pre-mutation `max(rid)`.
- **Envelope member default** (same block): `ek_contact.label default (lower(new.email))` reads the
  supplied sibling through the member projection.
- **SET DEFAULT** (`03.4-defaults.sqllogic`): `set default (new.x*10)` accepted + exercised by a later
  insert; omitting the sibling raises the resolution error; bare-column and `random()` SET DEFAULT
  rejected at ALTER time; DROP DEFAULT still works.
- **Mutation-context coexistence** (`46-mutation-context.sqllogic` Tests 13–14): `new.<col>` + a context
  variable through SET DEFAULT (single-source) and through the envelope (a member default
  `total default (new.amount + tax)` with `WITH CONTEXT tax`).

## Deliberate scope cut — ADD COLUMN split out (review this decision)

Per the ticket's load-bearing decision, **ALTER TABLE ADD COLUMN** was split into
`tickets/implement/…-add-column-new-ref-backfill.md`. Rationale: ADD COLUMN with a `new.<col>` default
on a **non-empty** table requires per-row backfill (evaluate the default against each existing row);
"store the default for future inserts but NULL existing rows" is an incoherent half-state, and the
ticket's own ADD COLUMN test *requires* the backfill. The backfill needs a new module seam (the
memory module currently folds the default to one literal). So the whole ADD COLUMN slice (allow +
validate + store + backfill) is atomic and lives in the follow-up. `runAddColumn` is **unchanged**
here — it still rejects non-literal defaults, so all pre-existing ADD COLUMN tests pass untouched.

## Known gaps / things to scrutinize

- **Optimizer stability of the fresh key-default attrs.** The key default's `new.<col>` refs point at
  fresh attributes resolved only at runtime via the installed row slot. I argue this is the same
  externally-provided-context pattern mutation-context refs and `__vmupd_keys` use, so the optimizer
  won't dangle them — but a reviewer should confirm no rule rewrites the key-default subtree in a way
  that drops/renames those refs, and that the row slot's attribute-index claim isn't clobbered by a
  subquery inside the same key default (I rely on fresh, unique ids; no `reactivate()` per row).
- **Bare-column registration in the envelope key default.** I register both `new.<col>` and bare
  `<col>` (parent = `ctx.scope`, no mutation-context shadowing set passed). Context vars are not in
  scope at the envelope key default today, so shadowing is moot — but confirm a bare column in a key
  default can't now resolve somewhere unintended.
- **SET DEFAULT determinism at ALTER vs CREATE.** At ALTER the table already exists, so a
  self-referencing-subquery SET DEFAULT *builds* (unlike CREATE, which defers it) and then runs
  `checkDeterministic`. I did not add a test for `set default (coalesce((select max(id) from t),0)+…)`;
  behavior there is "whatever checkDeterministic decides" — worth a glance if that shape matters.
- **No new ADD COLUMN coverage** here by design (see split).
- Pre-existing unused-param hint at `alter-table.ts:809` (`rebuildViaShadowTable`'s `schema`) is
  outside this diff and untouched; lint/tsc are green regardless.
