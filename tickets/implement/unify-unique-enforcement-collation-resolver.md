description: Unify the per-column UNIQUE-enforcement collation resolver. Export the canonical `uniqueEnforcementCollations` from `@quereus/quereus`; have `quereus-store` and `quereus-isolation` import it and delete their private copies. Lock memory's `checkUniqueViaIndex` (which cannot share the import — different index source) against the helper with a conformance test.
prereq:
files:
  - packages/quereus/src/schema/unique-enforcement.ts          # canonical uniqueEnforcementCollations + module doc comment
  - packages/quereus/src/index.ts                              # add the public export (near line 143)
  - packages/quereus-store/src/common/store-table.ts           # private copy (~L1446) + 2 call sites (findUniqueConflict ~L1476, findUniqueConflictViaCoveringMv ~L1562)
  - packages/quereus-isolation/src/isolated-table.ts           # private copy (~L1069) + 1 call site (findMergedUniqueConflict ~L1211)
  - packages/quereus/src/vtab/memory/layer/manager.ts          # checkUniqueViaIndex (#4, live-MemoryIndex source) + checkUniqueViaMaterializedView (already uses the helper)
  - packages/quereus/test/covering-structure.spec.ts           # home for the new #4 conformance lock (or a sibling spec)
difficulty: medium
----

# Unify the UNIQUE-enforcement collation resolver across packages

Three packages hand-maintain an identical per-column UNIQUE-enforcement collation
resolver; a fourth (memory `checkUniqueViaIndex`) computes the same logical value
from a different source. They MUST stay in lockstep: the row-time covering-MV
eligibility gate (`coveringMvHonorsIndexCollation`) decides MV eligibility using
the quereus copy, while the store/isolation/memory-MV re-validators filter
conflicts under their copy. A drift between the gate's notion of the index
collation and a re-validator's notion can re-open the subset-miss the gate closes
(a coarser-index covering MV silently missing a conflict) or over-reject.

## Design decision (resolved — do not re-litigate)

**Adopt Option 1 (single source of truth) for the three textually-identical
copies; apply the Option-2 conformance lock narrowly to the one copy that cannot
share the import.**

Rationale, settled during planning:

- **No import cycle.** `quereus-store` and `quereus-isolation` already
  runtime-depend on `@quereus/quereus` (`workspace:^`). `quereus` depends on
  `@quereus/store` only as a **devDependency** (for `yarn test:store`), so the
  production import graph is strictly `store/isolation → quereus`. Pulling a pure
  schema helper down is clean.
- **The helper is trivial to expose.** `uniqueEnforcementCollations` lives in
  `packages/quereus/src/schema/unique-enforcement.ts` and imports only
  `normalizeCollationName` + types. `TableSchema` / `UniqueConstraintSchema` are
  already exported from the package index (index.ts:143); add one export line.
- **store/isolation copies are byte-identical** to the canonical one → direct
  shared import, copies deleted. Cross-package drift is then eliminated *by
  construction*, not by a test.
- **Memory `checkUniqueViaMaterializedView` already imports the helper**
  (manager.ts: `const collations = uniqueEnforcementCollations(schema, uc);`) —
  no change there.
- **Memory `checkUniqueViaIndex` (the "fourth copy") is NOT mechanically
  unified.** It resolves the collation from the *live* `MemoryIndex.specColumns`
  (`index.specColumns[i]?.collation ?? schema.columns[col].collation`), where
  `index` is the enforcing structure resolved **by column-set** via
  `findIndexForConstraint` — not by `uc.derivedFromIndex` name. The shared
  helper's `(schema, uc)` signature has no `MemoryIndex` handle and resolves the
  index **by name** (`schema.indexes.find(ix => ix.name === uc.derivedFromIndex)`).
  For every constraint shape that actually arises these resolve to the same
  index and the same per-column collations (index-derived UNIQUE → `index` IS the
  named index; plain UNIQUE → auto-index carries the declared collation; both
  fall back to declared otherwise). But replacing the live-handle source with a
  name lookup is a *semantic* change whose equivalence depends on
  schema-construction invariants outside this ticket's scope (e.g. whether a
  plain `UNIQUE(b)` could ever co-exist with a separately-named collated index on
  the same column set, which `findIndexForConstraint` matches by column-set while
  the helper would not by name). A true import-time share for #4 is therefore
  genuinely infeasible without widening the helper's signature (which would muddy
  the clean `(schema, uc)` contract and defeat the unification). **Lock #4 with a
  conformance test instead** — entirely within the quereus package, since both
  the memory module and the helper live there. No cross-package test harness is
  needed.

Net effect: 3 copies → 1 shared function; the 4th is pinned by a test that fails
loudly if its live-index resolution ever diverges from the helper.

## Architecture

```
                 packages/quereus (source of truth)
                 ────────────────────────────────────
   schema/unique-enforcement.ts
     export uniqueEnforcementCollations(schema, uc)  ◄─────────────┐
     export coveringMvHonorsIndexCollation(schema, uc)             │ (stays internal — only
                                                                   │  used by the MV gate)
   index.ts  ── re-exports uniqueEnforcementCollations ────────┐   │
                                                               │   │
   core/database-materialized-views.ts                         │   │
     findRowTimeCoveringStructure ─► coveringMvHonorsIndexCollation  (the GATE)
                                                               │
   vtab/memory/layer/manager.ts                                │
     checkUniqueViaMaterializedView ─► uniqueEnforcementCollations  (already wired)
     checkUniqueViaIndex            ─► index.specColumns[…]         (#4: live handle;
                                          ▲                          conformance-locked,
                                          └── asserted == helper ── by new test)
                                                               │
                 ┌─────────────────────────────────────────────┘
                 │ import { uniqueEnforcementCollations } from '@quereus/quereus'
                 ▼
   quereus-store/.../store-table.ts        quereus-isolation/.../isolated-table.ts
     findUniqueConflict                       findMergedUniqueConflict
     findUniqueConflictViaCoveringMv          (private copy deleted)
     (private copy deleted)
```

The canonical helper signature is unchanged:

```ts
export function uniqueEnforcementCollations(
  schema: TableSchema,
  uc: UniqueConstraintSchema,
): (string | undefined)[]
```

Call sites that today read `this.uniqueEnforcementCollations(uc)` become
`uniqueEnforcementCollations(this.tableSchema!, uc)` — preserving the existing
`this.tableSchema!` non-null assertion and the freshness guarantee (the helper
reads the *passed* schema each call, so an `ALTER COLUMN SET COLLATE` that
propagates a new per-column collation into the index spec is picked up exactly as
before — see the store-module.ts comment that already relies on this).

## Edge cases & interactions

- **Positional alignment** `uc.columns[i]` ↔ `index.columns[i]` — load-bearing
  for all copies, guaranteed by `appendIndexToTableSchema`
  (`columns = indexSchema.columns.map(c => c.index)`). The conformance test must
  include a **composite** UC to exercise index 1.
- **Non-derived UNIQUE** (`derivedFromIndex` unset) → declared column collation
  for every column. (Table-level / column UNIQUE.)
- **Index-derived UNIQUE with explicit per-column COLLATE** (finer: BINARY index
  over a NOCASE column; coarser: NOCASE index over a BINARY column; equal) → the
  index's per-column COLLATE.
- **Column position with no explicit index COLLATE** (`CREATE UNIQUE INDEX ix ON
  t(b)`) → declared column collation (`index.columns[i].collation` is undefined →
  `?? schema.columns[col].collation`).
- **Missing index metadata** — `derivedFromIndex` set but the index record is
  gone: helper falls back to declared per column and must NOT throw (mirrors the
  gate's `if (!index) …` tolerance). Preserve this; the `?.` chain already does.
- **`this.tableSchema!` null-safety** — unchanged from the deleted private
  copies, which already asserted non-null at these call sites (deep in
  update/query paths where the schema is always set).
- **ALTER COLUMN SET COLLATE on an index column** — store-module.ts re-collates
  the derived index's columns so a `derivedFromIndex` UNIQUE re-keys enforcement
  under the new collation; the helper reading `this.tableSchema!` (the post-ALTER
  schema) must continue to surface the new collation. No behavioral change —
  just verify the store unique-constraints suite still passes.
- **#4 (`checkUniqueViaIndex`) divergence** — the conformance test is the guard.
  Drive these shapes through both `uniqueEnforcementCollations(schema, uc)` and
  the #4 expression (evaluated against the `MemoryIndex` that
  `findIndexForConstraint` resolves for the same `uc`) and assert equal output:
  finer / coarser / equal / plain (no index COLLATE) / composite / non-derived.
  If the test ever shows a real divergence, that is a genuine finding — surface
  it (it would mean the two index-resolution paths disagree), do **not** paper
  over it by widening the helper.
- **Build order** — `yarn build` is sequential and already builds `quereus`
  before `quereus-store` / `quereus-isolation`, so the new export is available
  when the consumers compile. No build-graph change required.
- **Doc drift** — the module doc comment in `unique-enforcement.ts` currently
  says the copies are "deliberately NOT yet unified across packages — see the
  ticket's out of scope." Update it to state that store/isolation now import this
  helper and that memory's `checkUniqueViaIndex` is conformance-locked rather
  than sharing the import (and why).

## TODO

### Phase 1 — expose + unify the three identical copies

- Add `export { uniqueEnforcementCollations } from './schema/unique-enforcement.js';`
  to `packages/quereus/src/index.ts` (near the other schema re-exports, ~L143).
  Leave `coveringMvHonorsIndexCollation` unexported — it is only consumed inside
  the quereus package by the MV gate.
- In `packages/quereus-store/src/common/store-table.ts`:
  - Add `uniqueEnforcementCollations` to the existing value-import block from
    `@quereus/quereus`.
  - Delete the private `uniqueEnforcementCollations(uc)` method (~L1446) and its
    doc comment.
  - Replace both `this.uniqueEnforcementCollations(uc)` call sites
    (`findUniqueConflict`, `findUniqueConflictViaCoveringMv`) with
    `uniqueEnforcementCollations(this.tableSchema!, uc)`.
- In `packages/quereus-isolation/src/isolated-table.ts`:
  - Add `uniqueEnforcementCollations` to the existing value-import block from
    `@quereus/quereus`.
  - Delete the private `uniqueEnforcementCollations(uc)` method (~L1069) and its
    doc comment.
  - Replace the `this.uniqueEnforcementCollations(uc)` call site in
    `findMergedUniqueConflict` with `uniqueEnforcementCollations(this.tableSchema!, uc)`.
- Update the `unique-enforcement.ts` module doc comment (and the
  `uniqueEnforcementCollations` JSDoc) to reflect that store/isolation now import
  it; drop the "deliberately NOT yet unified / out of scope" language.

### Phase 2 — conformance-lock the memory `checkUniqueViaIndex` resolution

- Leave `checkUniqueViaIndex`'s `index.specColumns[i]?.collation ?? …`
  resolution in place (it is the authoritative live-index source). Tighten/clarify
  its existing comment to note the shared helper resolves the SAME value from
  `(schema, uc)` and that the agreement is locked by the conformance test below.
- Add a quereus-package test (in `covering-structure.spec.ts` or a small sibling
  spec) that, for each shape — finer (BINARY index / NOCASE col), coarser (NOCASE
  index / BINARY col), equal, plain (no index COLLATE), composite (two columns,
  one finer one plain), non-derived (table-level UNIQUE) — builds the table +
  constraint, then asserts:
  - `uniqueEnforcementCollations(schema, uc)` equals, per column, the #4
    expression evaluated against the `MemoryIndex` returned by the memory module's
    constraint-index resolution for that `uc`
    (`index.specColumns[i]?.collation ?? schema.columns[col].collation`).
  Use the existing patterns in `covering-structure.spec.ts` (`db.schemaManager
  .getTable(...)!.uniqueConstraints![0]`, etc.) to reach the live schema + index.
  Keep it normalized-name comparison if the raw stored collation casing differs.

### Phase 3 — validate

- `yarn workspace @quereus/quereus run lint` (eslint + test-file type-check;
  catches the new export + call-site signature drift). Single-quote globs on
  Windows.
- `yarn build` (confirms the cross-package export resolves and store/isolation
  type-check against the imported helper).
- `yarn test` (default memory-backed suite — covers covering-structure.spec.ts,
  the new conformance test, and the isolation suite). Stream with `tee`.
- `yarn test:store` for the store path's index-derived-UNIQUE collation suite
  (`packages/quereus-store/test/unique-constraints.spec.ts`) — confirms the store
  re-validators behave identically through the shared helper. (If wall-clock is a
  concern under the runner, document deferral and lean on `yarn test`; the store
  unique suite is the targeted check.)
