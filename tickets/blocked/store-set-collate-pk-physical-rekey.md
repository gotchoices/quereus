description: Store SET COLLATE on a PRIMARY KEY column — per-column key collation / physical re-key (Option B) so PK collation is enforced and re-validated like memory
files:
  - packages/quereus-store/src/common/store-table.ts          # encodeOptions = { collation: config.collation || 'NOCASE' } (~173); buildDataKey/buildIndexKey call sites
  - packages/quereus-store/src/common/key-builder.ts           # buildDataKey / buildIndexKey / EncodeOptions
  - packages/quereus-store/src/common/store-module.ts          # setCollation arm; existing-row scans
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic  # PK sections 3+4, currently memory-only
  - packages/quereus/test/logic.spec.ts                        # MEMORY_ONLY_FILES
----

**BLOCKED — design / value call (human sign-off).** This is a large core key-encoder rewrite (per-column key collation + physical PK re-key) whose *necessity* is debatable: the sibling `store-set-collate-existing-row-revalidation` deemed validate-only (Option A) "likely sufficient." *Unblocks when:* a human decides whether to invest in physical PK re-key (Option B) or accept and document the memory/store PK-collation divergence. Not auto-implemented — an unsupervised core-storage encoder rewrite of debatable necessity is too risky/wasteful overnight.

# Store `SET COLLATE` on a PRIMARY KEY column — physical re-key (Option B)

## Background / why this is separate

The `store-set-collate-existing-row-revalidation` ticket brought the store to parity with
the memory module for **non-PK UNIQUE** collation changes (validate-only, Option A). It
deliberately left **PRIMARY KEY** columns out of scope because the store enforces PK
uniqueness *physically*, not logically:

- `StoreTable.encodeOptions = { collation: config.collation || 'NOCASE' }` — a **single,
  fixed table-level collation** drives the byte encoding of every PK (and physical index)
  key via `buildDataKey` / `buildIndexKey`. PK conflict detection is `store.get(key)`
  against those bytes; there is no per-column logical PK uniqueness scan analogous to the
  `uniqueConstraints` path.
- Therefore a per-column collation that differs from the table key collation is **not
  enforced on new inserts** for a PK column, and existing-row PK collisions under a new
  per-column collation cannot be detected by re-encoding without a full physical re-key.
- Under the default `NOCASE` table encoding the BINARY-distinct/NOCASE-colliding PK
  fixtures used by the memory tests (`insert into pkc values ('a'),('A')`) cannot even
  coexist in the store, so those scenarios are not merely unvalidated — they are
  unrepresentable with the current encoder.

## Divergence (still open after the Option-A ticket)

Memory re-keys the primary tree on a PK-column `SET COLLATE` and re-validates PK
uniqueness under the new collation (rejecting on collision, enforcing it for later
inserts). The store applies a PK-column `SET COLLATE` as schema-only and continues to key
under the fixed table collation. So `41.7.1` sections §3 (PK colliding under NOCASE →
ALTER rejected) and §4 (PK distinct → ALTER succeeds, later NOCASE-colliding PK insert
rejected) remain **memory-only**.

## Desired outcome

Give the store per-column collation in its key encoder (or an ALTER-time full re-encode +
duplicate scan) so a PK-column `SET COLLATE`:

- re-validates existing PK values under the new collation and rejects with `CONSTRAINT`
  (schema unchanged) on an introduced collision, and
- enforces the new collation for subsequent PK inserts,

matching the memory module. This likely means threading per-column collation into
`EncodeOptions` / `buildDataKey` / `buildIndexKey` (replacing the single table-level
collation), an ALTER-time re-encode of the data store (and any physical index stores)
under the new key bytes, and a dup scan during re-encode. Consider the interaction with
the table-level `config.collation` default and whether existing stores need migration.

## Acceptance

- A store PK column `SET COLLATE` that would introduce an existing-row PK collision is
  rejected with `CONSTRAINT`, table unchanged (parity with memory §3).
- After a successful PK-column `SET COLLATE`, a later collation-colliding PK insert is
  rejected (parity with memory §4).
- `41.7.1` PK sections move cross-module (removed from `MEMORY_ONLY_FILES`, or merged
  into `41.7.2`); `yarn test:store` green.
- `docs/sql.md` §2.7 and `docs/schema.md` store-collation notes updated to drop the PK
  deferral caveat.

## Notes / risks

- This is a physical-format change to key encoding — weigh against on-disk compatibility
  of existing LevelDB stores (migration vs. version gate).
- Physical index stores keyed under the old table collation also need re-encoding for the
  altered column to keep ordering/lookups consistent with the declared collation.
