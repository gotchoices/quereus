description: The store↔memory collation-default divergence for a single-column TEXT PRIMARY KEY (store → NOCASE, memory → BINARY) is INTENTIONAL, load-bearing, K-parameterized, conformance-tested, and already documented in docs/schema.md. It is not a bug. Close the visibility gap that caused the confusion: add a cross-reference breadcrumb at the memory-side default-collation resolution site so a future reviewer landing there learns of the store's divergent default instead of re-discovering it as a "bug."
files:
  - packages/quereus/src/schema/table.ts                                  # resolveDefaultCollation (memory-side single source; ~line 193-235) — add cross-ref
  - packages/quereus-store/src/common/store-module.ts                     # reconcilePkCollations (~2496), keyCollation = config.collation || 'NOCASE' (~368)
  - packages/quereus-store/src/common/store-table.ts                      # StoreTableConfig.collation default 'NOCASE'; resolvePkKeyCollations (~97-136)
  - docs/schema.md                                                        # §"Per-column PK key collation" (~348-380) already documents the divergence
  - packages/quereus-store/test/create-table-conformance.spec.ts          # asserts text-PK → NOCASE default contract (store leg)
  - packages/quereus-store/test/alter-table-conformance.spec.ts           # SET COLLATE re-key contract
difficulty: easy

# Store single-column TEXT PK → NOCASE default: confirmed INTENTIONAL — document the cross-backend divergence

## Conclusion of the fix-stage investigation

The reported divergence is **real but intended**, not a bug:

- The in-memory backend resolves an undecorated text PK column's collation through
  `resolveDefaultCollation` (`packages/quereus/src/schema/table.ts`), which falls back
  to the session `default_collation` — **BINARY** out of the box.
- The store backend, at CREATE, runs `reconcilePkCollations`
  (`packages/quereus-store/src/common/store-module.ts:2496`) which applies the store's
  table-level **key collation K** to an *implicit-default* text PK column. K is
  `config.collation || 'NOCASE'` (`store-module.ts:368`) and defaults to **NOCASE**.
  This is deliberate: the store encodes PK uniqueness/ordering *physically* in the key
  bytes, and the default preserves the store's **historical NOCASE-keyed** semantics for
  an undecorated text PK rather than the engine's BINARY column default.

Properties that establish intentionality (all pre-existing, none introduced by the lens work):

- **K-parameterized, not hardcoded.** `create table t (x text primary key) using store
  (collation = 'binary')` yields a BINARY default; an explicit `collate binary` text PK
  is always honored and keyed under BINARY via per-column physical re-keying
  (`StoreTable.pkKeyCollations` / `resolvePkKeyCollations`). Only the *implicit* default
  tracks K.
- **Conformance-tested.** `create-table-conformance.spec.ts` ("implicit-default text PK
  reports the fixed key collation K (NOCASE), not BINARY") and `alter-table-conformance.spec.ts`
  (SET COLLATE re-key arms) lock the contract across explicit/implicit, BINARY/NOCASE/RTRIM,
  and composite-PK cases.
- **Already documented.** `docs/schema.md` §"Per-column PK key collation" (~lines 348-380)
  describes the divergence explicitly, including "the engine's BINARY column default becomes
  NOCASE under K = NOCASE, so an undecorated text PK keeps the store's historical
  NOCASE-keyed behavior."
- **Not LevelDB-specific.** The collation logic lives entirely in `quereus-store`; the
  LevelDB plugin has no collation code (it only supplies the KV provider). The ticket's
  "LevelDB store backend" wording is really "the store module," exercised under
  `QUEREUS_TEST_STORE=true`.

### Why NOT align the store default to BINARY

There is no longer a *hard* encoding constraint forcing NOCASE (per-column re-keying honors
any collation), so a BINARY default is technically possible. But the NOCASE default is a
**deliberate backward-compatibility / on-disk-semantics choice**, and flipping it would:
change case-sensitivity semantics for every undecorated text-PK table created against an
existing store, and break the conformance suite that asserts the current contract. That is a
semantics break requiring human sign-off, not a decision-free fix — and the evidence is
overwhelming that the current behavior is intended. So this ticket does **not** change the
default; it closes the *visibility* gap that made the divergence look accidental.

### The downstream lens effect is sound

The authored-bijection lens proves a text `upper/lower` inverse a bijection only when the
basis CHECK in-list is value-discriminating; under NOCASE `'a' ≡ 'A'`, so the
value-discrimination gate in `extractCheckConstraints` correctly drops the enum domain and an
authored text PK stays read-only under store while writable under memory. That is conservative
and correct *given the collation* — it is a consequence of the (intended) NOCASE default, not
an independent bug. 55.5 scenarios 18/19 use INTEGER keys to keep both backends identical; the
text upper/lower bijection stays covered by scenario 6 and the memory-only unit specs. No lens
or sqllogic change is required by this ticket.

## Scope of this ticket

Documentation/breadcrumb only — no behavior change, no schema change, no new collation logic.
The single missing piece is a cross-reference at the memory-side resolution site, since a
reviewer who lands on `resolveDefaultCollation` (as the lens implementer effectively did) has
no pointer to the store's divergent default.

## TODO

- In `packages/quereus/src/schema/table.ts`, at `resolveDefaultCollation` (and/or
  `columnDefToSchema` where it is invoked), add a short doc comment noting that this resolves
  the *engine/memory* default only (session `default_collation`, BINARY out of box), and that
  the **store module deliberately overrides an implicit-default text PK to its table-level key
  collation K (NOCASE by default)** — cross-reference `quereus-store`
  `reconcilePkCollations` (`store-module.ts`) and `docs/schema.md` §"Per-column PK key
  collation". Keep it to a couple of sentences; the authoritative description already lives in
  docs/schema.md.

- Verify `docs/schema.md` §"Per-column PK key collation" makes the *cross-backend* contrast
  unmistakable (same DDL ⇒ memory BINARY, store NOCASE; root cause of read-only-vs-writable
  lens differences for authored text PKs). If it already does (it largely does today), add at
  most a one-line note tying the divergence to the lens read-only-vs-writable consequence so a
  future reader does not re-file this. Do not duplicate the prose across files — link to it.

- Sanity check there is an existing assertion that a text PK round-trips case-sensitively
  under memory (BINARY) and case-insensitively under store (NOCASE). The store leg is covered
  by `create-table-conformance.spec.ts` ("implicit-default text PK … NOCASE … 'a'/'A' collide").
  If no memory-leg counterpart exists, add a tiny memory assertion that
  `create table t (x text primary key); insert 'a','A'` keeps both rows distinct (BINARY).
  Do not add a new cross-backend sqllogic file unless it is genuinely missing — prefer
  extending existing coverage.

- Run `yarn workspace @quereus/quereus run lint` (eslint + test-file typecheck) and the
  quereus + quereus-store unit tests touched. Doc-comment-only changes need no `yarn test:store`
  run; if a memory assertion is added, run the memory lane only (`yarn test`).
