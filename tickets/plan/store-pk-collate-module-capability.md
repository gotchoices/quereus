description: Make per-column PRIMARY KEY collation enforcement a module capability. The engine's `setCollation` contract currently MANDATES a physical re-key (module.ts:412-415); memory honors it, the store (fixed table-level key collation) cannot, so a PK-column `SET COLLATE` silently diverges. Resolved approach (human direction): a module advertises whether it can honor a per-column PK collation, and the engine handles the unsupported case by policy instead of forcing a core key-encoder rewrite.
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/capabilities.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-store/src/common/key-builder.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic, packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic, packages/quereus/test/logic.spec.ts, docs/sql.md, docs/schema.md
----

**Resolved approach (2026-06-07):** replace the original "do the physical re-key (Option B) or
just accept divergence (Option A)" binary with a **module capability negotiation** (human
direction). Design the capability + engine policy; emit an implement ticket.

## Background

The `setCollation` ALTER arm's module contract (`module.ts:412-415`) already says *"the module
must re-key / re-sort any PK / UNIQUE / index that orders by the column and re-validate
uniqueness under the new collation."*

- **Memory** honors this: it re-keys the primary tree on a PK-column `SET COLLATE` and
  re-validates PK uniqueness under the new collation.
- **Store** cannot: `StoreTable.encodeOptions = { collation: config.collation || 'NOCASE' }`
  (`store-table.ts`) — a single, fixed, table-level collation drives every PK/physical-index
  key's bytes via `buildDataKey` / `buildIndexKey`, and PK conflict detection is
  `store.get(key)` against those bytes. A per-column collation that differs from the table key
  collation is **not enforced on new inserts** and existing collisions can't be detected without
  a full physical re-key. So the store applies a PK-column `SET COLLATE` as schema-only — a
  **silent divergence** from memory.

Key enabler: the store **already does logical UNIQUE enforcement** via a full-scan over
`uniqueConstraints` at write time (the non-PK path, `store-module.ts` `validateExistingRows`).
The machinery to enforce a collation logically already exists; the PK is special only because it
is enforced *physically* by key bytes.

## Desired design

A module advertises (via `getCapabilities()` / a new `ModuleCapabilities` field, or whatever
pattern the `module-capability-consistency-audit` recommends) whether it can honor a per-column
PK collation that diverges from its physical key collation. The engine then resolves the
unsupported case by policy, in increasing fidelity:

- **Target — engine-side logical enforcement.** On a PK-column `SET COLLATE` the engine performs
  an ALTER-time collision scan under the new collation (reuse the store's `uniqueConstraints`
  full-scan path), rejecting with `CONSTRAINT` on an introduced collision; going forward it
  enforces the new collation logically. The physical key stays under the table collation, so
  range-scan / `ORDER BY` pushdown on that column won't reflect the new collation (documented
  caveat), but uniqueness is correct. This is the **closest parity to memory §3/§4 without an
  on-disk format change**.
- **Fallback — reject.** If logical enforcement is out of scope, reject the diverging ALTER with
  a clear, **sited** diagnostic ("module enforces PK uniqueness physically under a fixed table
  collation; per-column PK `SET COLLATE` to a divergent collation is unsupported"). Honest,
  cheap, no silent divergence — the store simply refuses rather than mis-enforcing.
- **Open — module-side physical re-key.** The original Option B (per-column key collation +
  ALTER-time re-encode + dup scan) remains available to any module that advertises it; memory
  effectively already does this. Not required of the store.

## Edge cases & interactions

- `41.7.1` §3 (PK colliding under NOCASE → ALTER rejected) and §4 (PK distinct → ALTER succeeds,
  later NOCASE-colliding PK insert rejected): under **target** these can move cross-module
  (removed from `MEMORY_ONLY_FILES` / merged into `41.7.2`); under **fallback** they stay
  memory-only and the store rejects the diverging ALTER itself — assert that behavior explicitly.
- Interaction with the table-level `config.collation` default (a PK `SET COLLATE` to the *same*
  collation as the table key is a no-op and must stay supported on every module).
- Physical index stores keyed under the old table collation (ordering/lookup consistency if a
  module opts into physical re-key).
- On-disk compatibility / migration of existing LevelDB stores — relevant only for the
  module-side physical re-key path, not the logical-enforcement target.
- `docs/sql.md` §2.7 and `docs/schema.md` store-collation notes: document the chosen store
  behavior (and drop or reword the PK deferral caveat accordingly).

## Notes

- Related to `module-capability-consistency-audit` (plan, now resolved) — that survey
  classified the engine↔module contract surface (see `module-capability-negotiation-doc` for
  the full inventory) and settled the pattern this ticket should adopt:
  - **Declare per-arm support and consult it before dispatch** (the `concurrencyMode` model
    generalized), so `runAlterColumn` routes a PK-column `setCollation` to
    `native | logical-enforce | reject` instead of letting the store silently no-op.
  - **Hard contract: never silently no-op.** This ticket's "fallback — reject" path must
    throw `QuereusError(StatusCode.UNSUPPORTED)` with a sited message, not apply schema-only.
  - When this lands, flip on the deferred PK-collation cell in
    `module-alter-conformance-harness` (it is currently `skip`/`xfail` pending this fix).
  Consistent with the audit, but **not gated** on it — proceed independently.
- Supersedes the blocked `store-set-collate-pk-physical-rekey` ticket; the sibling
  `store-set-collate-existing-row-revalidation` (non-PK UNIQUE, validate-only) already landed.
