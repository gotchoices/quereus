description: Add a derived, event-invalidated "lens basis-FK gate" on SchemaManager (Set of basis schema.table keys that back ≥1 logical-FK-referenced parent slot) and use it to O(1) short-circuit the three basis-keyed lens FK paths (executeLensForeignKeyActions, assertLensRestrictsForParentMutation, basisFksOverriddenByDivergentLensFk) when the written basis table backs no logical-FK parent slot. The logical-FK analogue of the physical reverse-FK index.
files:
  - packages/quereus/src/schema/manager.ts                    # add lensFkGate cache + getter + invalidate; extend constructor change listener; null in addSchema/getOrCreateSchema/removeSchema/clearAll
  - packages/quereus/src/schema/lens-fk-discovery.ts          # export buildLensBasisFkGate(schemaManager); gate basisFksOverriddenByDivergentLensFk at entry
  - packages/quereus/src/runtime/foreign-key-actions.ts       # gate executeLensForeignKeyActions + assertLensRestrictsForParentMutation at entry
  - packages/quereus/src/schema/lens-compiler.ts              # invalidate gate after the clear-and-rebuild in deployLogicalSchema
  - packages/quereus/test/lens-enforcement.spec.ts            # gate short-circuit + under-report regression cases (reuse deployCascadeLens)
  - docs/schema.md                                            # § Reverse foreign-key index — add a "lens basis-FK gate" sibling subsection
difficulty: medium
----

# Lens basis-FK gate — the logical-FK analogue of the reverse-FK index

## Context

`reverse-fk-index-catalog` + `reverse-fk-index-engine-consumers` (both **complete**) built and
consumed a catalog-level reverse index over **physical** FKs (`TableSchema.foreignKeys`), keyed
by referenced `schema.table`. That index deliberately does **not** cover *logical* FKs, which
live only on a child lens slot's `enforced-fk` obligation (on no basis table) and are discovered
by walking `getAllLensSlots()` rather than table FKs. Those lens paths were left on the full slot
scan and parked here.

Three runtime/discovery functions reverse-map a written **basis** parent table to the logical
parent slot(s) it backs, then walk every schema's lens slots to find referencing logical FKs:

- `executeLensForeignKeyActions` (`runtime/foreign-key-actions.ts:512`) — the lens cascade walker.
- `assertLensRestrictsForParentMutation` (`runtime/foreign-key-actions.ts:744`) — the lens RESTRICT pre-check.
- `basisFksOverriddenByDivergentLensFk` (`schema/lens-fk-discovery.ts:316`) — the divergent-basis-action suppression set.

Each currently runs `for (schema of sm._getAllSchemas()) for (parentSlot of schema.getAllLensSlots()) { resolveSlotBasisSource(...) ... }`
on **every** basis write. The slot set is empty in almost all databases, so this is cheap — but
it is a per-write scan that the physical index now avoids for physical FKs. This ticket gives the
lens paths the same O(1) gate.

`findLogicalParentFkRefs(parentSlot, sm)` (`lens-fk-discovery.ts:235`) is the underlying
per-parent-slot discovery the three functions call *after* the basis match. It is keyed by a
parent slot (not a basis table) and is reached only from inside the already-gated callers at
runtime, so it is **not** itself gated and its signature does **not** change. (It is also used
plan-time by `planner/mutation/lens-enforcement.ts`, which is out of scope.)

## Design

Add a derived cache on `SchemaManager`, exactly analogous to `reverseFkIndex`:

```ts
// On SchemaManager:
/** Basis `schema.table` (lowercased) keys that back ≥1 logical parent slot referenced
 *  by ≥1 logical FK. `null` ⇒ rebuild on next access. Pure derived cache. */
private lensFkGate: Set<string> | null = null;

/** O(1): does this basis table back a logical-FK-referenced parent slot? When false,
 *  the three lens FK paths early-return — nothing for them to find. */
basisTableBacksLogicalParentFk(schemaName: string, tableName: string): boolean
```

`basisTableBacksLogicalParentFk` lazily (re)builds `lensFkGate` on first access after any
invalidation, then does `gate.has(\`${schema}.${table}\`.toLowerCase())`.

### Building the gate — `buildLensBasisFkGate(schemaManager): Set<string>`

Put the builder in `lens-fk-discovery.ts` (it already imports `resolveSlotBasisSource`,
`findLogicalParentFkRefs`, `LensSlot`, `SchemaManager` as `import type`). `manager.ts` imports it
— verified cycle-free: the `manager → lens-fk-discovery → lens-prover → planner/*` chain carries
only `import type { SchemaManager }`, no runtime back-edge to `manager.ts`.

```
const gate = new Set<string>();
for (const schema of schemaManager._getAllSchemas()) {
  for (const parentSlot of schema.getAllLensSlots()) {
    const basis = resolveSlotBasisSource(parentSlot, schemaManager);   // undefined ⇒ multi-source/absent ⇒ skip
    if (!basis) continue;
    if (findLogicalParentFkRefs(parentSlot, schemaManager).length === 0) continue;
    gate.add(`${basis.schemaName.toLowerCase()}.${basis.name.toLowerCase()}`);
  }
}
return gate;
```

This is exactly the scan the three functions perform, run once and cached. The key is the
**basis parent** `schema.table` — the value each basis write carries. A parent slot with no
single basis spine resolves to `undefined` and contributes no key; at runtime that same slot is
skipped (`if (!basis) continue`), so the gate's omission is **consistent** with the full scan —
no under-report. Conservatism is automatic: building from the live catalog means the gate can only
over-report (an extra key ⇒ an unnecessary scan that finds nothing ⇒ same result, slower); it
never under-reports for the current catalog state.

### Soundness invariant (load-bearing)

The gate must never cause a function to skip a scan that would have matched: for every
`basisParent` where the full scan would find ≥1 (parent-slot-backed-by-basisParent × referencing
logical FK), `lensFkGate` contains its key. Built directly from that scan and invalidated on every
event that can change the scan's result, this holds. A stale gate that **under-reports** would
silently drop logical enforcement (cascade not propagated / RESTRICT not enforced / divergent basis
action not suppressed) — the fatal direction — so invalidation must be exhaustive.

### Invalidation surface

The gate depends on (a) the lens-slot set + each slot's `enforced-fk` obligations, and (b) the
basis-table catalog (because `resolveSlotBasisSource` resolves a bare table name against it). So:

- **Lens-slot lifecycle** — the slots are mutated *only* via `Schema.addLensSlot` /
  `clearLensSlots` / `removeLensSlot`, which fire **no** `SchemaChangeEvent` (the union in
  `change-events.ts` has no lens event). The one deploy path is
  `lens-compiler.ts deployLogicalSchema` (clear-and-rebuild, ~line 247), which holds
  `schemaManager = db.schemaManager` — call `schemaManager.invalidateLensFkGate()` right after the
  clear-and-rebuild block (sibling to the snapshot rotation). Confirm via
  `find_references(addLensSlot|clearLensSlots|removeLensSlot)` that no other call site mutates
  slots without already invalidating (today: `deployLogicalSchema`, plus `removeSchema`/`clearAll`
  below).
- **Basis-table catalog** — extend the existing constructor `changeNotifier` listener (which nulls
  `reverseFkIndex` on `table_added`/`table_modified`/`table_removed`) to also call
  `invalidateLensFkGate()`. This covers a basis table being created after the gate was built
  (the under-report vector), dropped, or column-renamed in a way that changes basis resolution.
- **Schema attach/detach + reset** — `addSchema`, `getOrCreateSchema`, `removeSchema`, and
  `clearAll` already null `reverseFkIndex`; null `lensFkGate` at the same points (logical-schema
  ATTACH/DETACH bring/remove slots; `removeSchema`/`clearAll` call `clearLensSlots`; these fire no
  event). Belt-and-suspenders on `addSchema`/`getOrCreateSchema` mirrors the physical index.

Prefer a single shared `invalidate` that nulls both caches if it reads cleaner, or keep
`invalidateLensFkGate()` separate and call both — match the existing `invalidateReverseFkIndex`
style. Rebuild always happens on next access, never inside a listener, so it is order-independent.

### Wiring the three callers

After the existing `foreign_keys`-off early return, add the gate check, then leave the existing
scan body **byte-for-byte unchanged** (it now runs only on a hit):

- `executeLensForeignKeyActions` / `assertLensRestrictsForParentMutation` (take `db`):
  `if (!sm.basisTableBacksLogicalParentFk(basisParentTable.schemaName, basisParentTable.name)) return;`
- `basisFksOverriddenByDivergentLensFk` (takes `schemaManager`, returns a `Set`, not
  `foreign_keys`-gated itself — callers gate):
  `if (!schemaManager.basisTableBacksLogicalParentFk(basisParent.schemaName, basisParent.name)) return new Set();`

Update each function's "No-op (early return) when … no lens slot resolves to `basisParentTable`"
doc line to say the O(1) gate now decides this, with the full scan as the on-hit confirmation.

## Edge cases & interactions

- **No lenses / no logical FKs (the common cases).** Empty gate ⇒ all three functions O(1) return.
  A lens-bearing DB with no logical FKs is also empty (the `findLogicalParentFkRefs(...).length === 0`
  filter). Both must be verified by a throughput-style assertion (gate miss ⇒ no scan).
- **Gate hit preserves existing behavior exactly.** A write to a basis table that *does* back a
  logical-FK parent slot must run the unchanged scan — every existing cascade/RESTRICT/divergent
  test in `lens-enforcement.spec.ts` (the `deployCascadeLens` suite, the divergent-basis suite, the
  transitive/composite/MATCH-SIMPLE cases) must stay green untouched. This is the primary
  regression guard.
- **Under-report on late basis creation (the fatal vector).** Force-build the gate (e.g. trigger a
  read) when a basis table is absent or before a referencing structure exists, then create
  it/redeploy, and confirm enforcement *still fires*. Mirrors the physical index's silent-import
  regression. At minimum: deploy a lens with a logical cascade FK, perform an unrelated write
  (builds gate), then `apply schema` a change and confirm the cascade fires.
- **Lens redeploy add/remove of a logical FK.** `apply schema X` that adds or drops a logical FK →
  `deployLogicalSchema` invalidates → next basis write rebuilds the gate and reflects the change.
- **DETACH / clearAll.** `removeSchema` of a logical (or basis) schema and `clearAll` (test reset)
  must invalidate; a stale gate after detach over-reports (harmless) but after a basis re-attach
  could under-report if not reset — reset covers both.
- **Multi-source / decomposition parent slot.** No single basis spine ⇒ no gate key ⇒ runtime
  also skips it. The existing "multi-source parent fires no lens cascade" test must stay green.
- **Cross-schema basis.** Gate keyed by the basis parent's own `schema.table` (lowercased),
  exactly what the basis write carries; cross-schema logical FKs key under the basis parent's
  schema. Case-insensitive throughout (lowercase both halves), matching `reverseFkIndex`.
- **Divergent-basis complement invariant unchanged.** The gate only decides *whether to scan*;
  `basisFksOverriddenByDivergentLensFk` still computes *which* basis FKs are suppressed identically
  on a hit. The complement invariant with the cascade walker's `agree` elision is untouched (both
  gate on the same basis table, so both fire-or-skip together).
- **Concurrent / re-entrant lens cascades.** A lens cascade re-enters the lens write path and may
  issue further basis writes; each re-consults the (cached, unchanged-mid-statement) gate. The gate
  is only invalidated by DDL, never by DML, so it is stable across a cascade's nested writes — no
  rebuild churn inside a statement.

## Key tests (extend `test/lens-enforcement.spec.ts`)

Reuse the existing `deployCascadeLens` helper. Add a `describe('lens enforcement: basis-FK gate
short-circuit')`:

- **Gate miss skips the scan.** With a lens deployed but writing a basis table that backs no
  logical-FK parent slot (or with no logical FK at all), assert the three paths no-op. Prefer a
  direct unit assertion: `db.schemaManager.basisTableBacksLogicalParentFk('main','unrelated')`
  is `false`, and `basisFksOverriddenByDivergentLensFk(unrelatedBasis,'delete',sm)` returns an
  empty set without scanning. (Mirror the `maintained-parent-fk.spec.ts` "unreferenced throughput
  gate" style.)
- **Gate hit enforces (behavior unchanged).** A logical `on delete cascade` over a basis-backed
  parent: `basisTableBacksLogicalParentFk` is `true` and the delete still cascades — i.e. the
  existing cascade cases pass with the gate in place.
- **Under-report regression.** Build the gate before the referencing structure exists (unrelated
  write), then `apply schema` to add the logical cascade FK / its parent slot, then delete the
  parent and confirm the child is cascade-deleted. Confirm it would **fail** if the deploy did not
  invalidate (note this in a comment; do not leave a broken assertion).
- **Invalidation on DETACH/redeploy.** Optional: after dropping/redeploying the logical schema,
  the gate reflects the new slot set (a parent that no longer backs a logical FK ⇒ subsequent write
  no-ops; one that newly does ⇒ enforces).

## TODO

### Phase 1 — gate primitive
- Add `buildLensBasisFkGate(schemaManager): Set<string>` to `lens-fk-discovery.ts` (exported,
  documented), reusing `resolveSlotBasisSource` + `findLogicalParentFkRefs`.
- Add `lensFkGate: Set<string> | null = null`, `invalidateLensFkGate()`, and
  `basisTableBacksLogicalParentFk(schemaName, tableName): boolean` to `SchemaManager`
  (`manager.ts`), importing the builder. Doc-comment the cache and the soundness invariant,
  matching the `reverseFkIndex` prose.

### Phase 2 — invalidation hooks
- Extend the constructor `changeNotifier` listener in `manager.ts` to also `invalidateLensFkGate()`
  on `table_added`/`table_modified`/`table_removed`.
- Null `lensFkGate` in `addSchema`, `getOrCreateSchema`, `removeSchema`, `clearAll` (alongside the
  existing `invalidateReverseFkIndex` calls).
- In `lens-compiler.ts deployLogicalSchema`, call `schemaManager.invalidateLensFkGate()` after the
  clear-and-rebuild block. Run `find_references(addLensSlot|clearLensSlots|removeLensSlot)` to
  confirm no other unguarded slot-mutation site exists; invalidate any that surface.

### Phase 3 — wire the three callers
- Gate `executeLensForeignKeyActions` and `assertLensRestrictsForParentMutation` (early `return`)
  and `basisFksOverriddenByDivergentLensFk` (early `return new Set()`), leaving each existing scan
  body unchanged. Update the three doc-comment "No-op when …" lines.

### Phase 4 — tests + docs
- Add the `basis-FK gate short-circuit` describe to `lens-enforcement.spec.ts` (gate miss / gate
  hit / under-report regression / invalidation), reusing `deployCascadeLens`.
- Add a "lens basis-FK gate" sibling subsection to the `docs/schema.md` § Reverse foreign-key
  index (keyed by basis schema.table; built from the slot scan; invalidated on lens deploy +
  basis-table events + attach/detach; the never-under-report invariant).
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus test`
  (stream with `2>&1 | tee /tmp/lens-gate-test.log; tail -n 80 /tmp/lens-gate-test.log`); the full
  quereus suite must stay green (the existing lens cascade/RESTRICT/divergent cases are the primary
  regression guard).
