description: REVIEWED — durable-backing adopt fast path at rehydrate: a store-hosted `_mv_` backing is trusted (no body refill) when all five gates pass, anchored by a single-use clean-shutdown catalog marker; any failed gate keeps the drop+refill.
files:
  - packages/quereus/src/schema/manager.ts                          # ImportCatalogOptions; importCatalog/importDDL threading; adopt arm + tryAdoptPreExistingBacking
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # adoptMaterializedView; shared buildMaterializedViewRecord + assertDeclaredColumnArity (review)
  - packages/quereus/src/index.ts                                   # ImportCatalogOptions export
  - packages/quereus-store/src/common/key-builder.ts                # \x00meta\x00 prefix; buildMetaCatalogKey; CLEAN_SHUTDOWN_META_NAME; 'meta' classify kind
  - packages/quereus-store/src/common/store-module.ts               # closeAll marker write; consumeCleanShutdownMarker; phase-3 trust threading; loadAllDDL meta filter
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # 14-test reopen matrix (sentinel-divergence oracle; +1 in review)
  - docs/materialized-views.md                                      # adopt gate semantics + two trust caveats (review)
  - docs/schema.md, docs/module-authoring.md                        # importCatalog options; durable-host adopt guidance
----

# Adopt-without-refill at rehydrate — completed (implementation + review)

Third step after `store-backing-host`: `SchemaManager.importMaterializedView`'s
same-module pre-existing-backing arm upgraded from unconditional drop+refill to
gate-checked adopt. Only catalog import adopts; create and refresh never do.

**Engine**: `ImportCatalogOptions { trustBackings?, adoptedBackings? }` threaded
`importCatalog` → `importDDL` → `importMaterializedView`, both default off.
`tryAdoptPreExistingBacking` checks shape (gate 2), declared-column arity, and
sources (gate 4: same-module + `_mv_` sources in the session adopt ledger);
gates 1 (same module) and 5 (`trustBackings`) checked by the caller; gate 3
(bodyHash) automatic by construction. `adoptMaterializedView` re-stamps the
body-derived backing schema (phase-1 DDL round-trip loses ScalarType fidelity;
shape-verified identical), builds the MV record via the shared formula, and on
registration failure unlinks/deregisters but leaves the backing registered as a
plain table (durable rows preserved). Under trust, a body that cannot plan (or
whose declared-column arity mismatches — review fix) errors per-entry WITHOUT
dropping the backing — load-bearing for the MV-over-MV fixpoint.

**Store**: reserved `\x00meta\x00` catalog prefix; `closeAll` writes the
clean-shutdown marker after unsubscribe + persist-queue drain + table
disconnects, immediately before `provider.closeAll`; `rehydrateCatalog`
consumes it first (read + immediate delete — single-use) and threads
`{ trustBackings, adoptedBackings }` into every phase-3 `importCatalog` with one
shared ledger across fixpoint rounds; meta entries filtered from classification
and `loadAllDDL`.

**Tests**: `mv-rehydrate-adopt.spec.ts` — persistence-faking provider,
sentinel-divergence oracle (a row planted directly in the backing's KV store:
served ⇒ adopt proven, scrubbed ⇒ refill proven). 14-scenario matrix: adopt
happy path (+ live maintenance), marker single-use/re-arm, simulated crash,
shape-gate refill, module-gate refill, MV-over-MV (adopt composition across
fixpoint rounds, refilled-upstream and memory-upstream forcing), registration
failure preserving the backing, arity-mismatch preserving the backing (review),
catalog byte fixed point adopt==refill, and the engine arm without the store
wrapper (no options ⇒ refill; trust ⇒ adopt; trust does not bypass the
other-module CONSTRAINT arm).

## Review findings

**Process**: read the implement diff fresh before the handoff summary; traced
every helper the diff plugs into (`materializeView`, `createBackingTable` /
`finalizeCreatedTableSchema`, `Schema.addTable`, `deriveBackingShape` /
`collectSourceTables`, `backingShapeMatches`, the rehydrate reconciliation
loop, `MaterializedViewManager`'s stale listener); audited the LevelDB
provider's write durability; reviewed all 13 implement tests + docs diffs.
Validation: `yarn build`, `yarn lint`, `yarn test` (engine 5775 passing /
9 pending; store package 512 passing incl. the new test), `yarn test:store`
(5771 passing / 13 pending) — all green after the review fixes.

**Major — filed as new tickets** (both also documented as caveats in
`docs/materialized-views.md` § Cross-module atomicity):

- `fix/mv-adopt-stale-at-close` — the marker attests "no crash", not
  "maintenance was live": an MV marked stale mid-session (any `table_modified`
  on a source — even a `create index` — detaches row-time maintenance, so
  subsequent source writes never reach the backing) that is closed cleanly
  without a `refresh` passes every DDL-level gate at reopen and adopt registers
  the *behind* backing as `stale: false`. Refill would have recomputed.
  Confirmed against `database-materialized-views.ts`'s stale listener; `stale`
  is runtime-only state. Suggested fix: carry the stale set in the marker
  payload (or gate the marker on it).
- `backlog/mv-adopt-marker-sync-durability` — the consume-side marker delete
  and the session's data writes land in separate KV stores (separate LevelDB
  DBs, unsynced `put`/`del`), so a power loss can persist data writes while
  losing the delete, resurrecting the marker across a genuine crash window
  (never self-heals — each clean close re-arms). Process kill is safe. Needs a
  KVStore durability surface (sync flag / flush barrier).

**Minor — fixed in this pass**:

- Declared-column arity mismatch under `trustBackings` returned `false` from
  the gate check, so the caller DROPPED the durable backing and `materializeView`
  then threw the same sited error — destroying rows for an entry that can never
  materialize, contradicting the ticket's own data-safety principle (plan-failure
  and registration-failure paths both preserve). Now throws from the gate check
  with the backing preserved; shared `assertDeclaredColumnArity` keeps the
  diagnostic identical to the refill arm's; new matrix test + doc sentence.
- The MV record formula was duplicated verbatim between `materializeView` and
  `adoptMaterializedView` — the `bodyHash` line is load-bearing for the
  adopt==refill catalog fixed point, so drift there would be silent corruption.
  Extracted shared `buildMaterializedViewRecord(def, shape)`.

**Checked, accepted as-is** (no action):

- Refill registers the module-finalized schema (`finalizeCreatedTableSchema`,
  which can carry store PK-collation reconciliation) while adopt re-stamps the
  raw `buildBackingTableSchema` output — safe because gate 2 compares collation:
  any case where they would differ fails the gate and refills (conservative,
  marginally pessimal for reconciled-collation PKs).
- Secondary indexes a user created on a `_mv_` backing don't survive the adopt
  re-stamp — parity with refill, which drops and recreates the backing without
  them; not a regression.
- `estimatedRows` carry-over on the re-stamp; gate 4's `!source` arm is
  effectively unreachable (the body just planned against it) — defensive only;
  trusted-refill plans the body twice (gate check + `materializeView`) —
  planning is cheap relative to materialization per existing precedent.
- Marker written by every `closeAll` including never-rehydrated/empty catalogs —
  harmless, consumed-or-ignored.
- Docs (`materialized-views.md`, `schema.md`, `module-authoring.md`) verified
  against the as-built behavior; the implement-stage edits were accurate and
  were extended (arity semantics, trust caveats) rather than corrected.
- No pre-existing test failures encountered; nothing for
  `tickets/.pre-existing-error.md`.

**Known gaps carried from implement** (still true, acceptable): sentinel probe
is provider-level in-memory (no on-disk LevelDB crash test — out of agent
scope); gate 4's `_mv_` detection is name-convention (a user table literally
named `_mv_x` as a source ⇒ permanent refill for that MV — conservative);
live-instance re-stamp is host-reconciled (a host calling `importCatalog`
directly must reconcile its own connected instances — documented).
