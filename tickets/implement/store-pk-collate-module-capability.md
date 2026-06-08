description: Close the store's PK-column `SET COLLATE` silent-divergence. Resolve the per-arm `setCollation` negotiation to **accept-when-consistent / reject-when-divergent**: the store applies a PK-column collation change schema-only when the target collation equals its fixed physical key collation, and throws a sited `UNSUPPORTED` when it diverges — never silently no-ops.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/module.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic, packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic, packages/quereus/test/logic.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, docs/module-authoring.md, docs/sql.md, docs/schema.md
----

## Resolved design (plan stage, 2026-06-08)

The plan ticket left a binary open between **logical-enforce** (the "target") and
**reject** (the "fallback") for the store. Research into the store's actual key
mechanics resolves it decisively to a **refined reject**, with logical-enforce and
module-side physical re-key parked as future backlog enhancements.

### Key facts that drive the decision

1. **The store enforces PK uniqueness *physically* under a single fixed collation.**
   `StoreTable.encodeOptions = { collation: config.collation || 'NOCASE' }`
   (`store-table.ts:173`) drives every PK key's bytes via `buildDataKey`; PK conflict
   detection is `store.get(key)` against those bytes. Call this collation **K** (the
   *physical key collation*); it is one of `BINARY` | `NOCASE` (the only two
   `StoreTableConfig.collation` admits) and the store does **not** change it on ALTER.

2. **The PK column's *declared* collation (C) and K already diverge by default.** A
   default store text PK column is declared `BINARY` (column default) while K is
   `NOCASE` (store default). The store has always enforced the PK under K, not under
   the column's declared C. This is pre-existing CREATE-time behavior, **out of scope**
   here — this ticket governs only the `SET COLLATE` *action*.

3. **A PK-column `SET COLLATE` to C is honorable iff C == K.** After the change the
   column declares C but the store still enforces K physically. Correctness (declared
   collation == enforced collation) holds **only when C == K**:
   - **C == K** → consistent. Schema-only update is correct; forward PK uniqueness is
     already enforced under exactly C by the physical key. (This is the common
     `SET COLLATE nocase` on a default store PK — it *repairs* the default
     col-vs-key divergence.)
   - **C != K** → divergent, and **not fixable without a physical re-key**:
     - K stricter than C (K=`NOCASE`, C=`BINARY`): the physical key already merged
       rows C wants distinct (`'a'`/`'A'` share one NOCASE key) — they cannot even
       coexist, so the store would over-reject valid `BINARY` inserts. Irreparable
       logically.
     - K looser than C (K=`BINARY`, C=`NOCASE`): the physical key keeps rows distinct
       that C wants merged — the store under-enforces (the silent-divergence bug).
       *Could* be repaired by a write-time logical PK scan (the "logical-enforce"
       target), but that only covers this one direction and adds a full-scan to the
       hot PK write path.

   Because logical-enforce covers only the looser-K direction and buys **nothing** for
   the overwhelmingly common default (`NOCASE`-keyed) store — where the only meaningful
   change is `→NOCASE` (== K, already correct) and `→BINARY` is physically impossible —
   it is **not worth the write-path cost or complexity now**. Reject is honest, cheap,
   and complete.

### Resolved behavior (the store's `alterColumn` `setCollation` arm)

For a `setCollation` change on a column that **is part of the primary key**:

1. **No-op short-circuit (unchanged, runs first):** if the normalized target equals
   the column's *current* collation, return `oldSchema` untouched. Same-collation
   `SET COLLATE` stays supported on every module (per the conformance contract), and
   this deliberately does **not** surface the pre-existing CREATE-time col-vs-K
   divergence as an ALTER error.
2. **Consistent change (C == K):** apply schema-only — update the column's collation in
   the schema, persist DDL. Forward uniqueness is already physically correct under C.
   **Honored.**
3. **Divergent change (C != K):** throw `QuereusError(StatusCode.UNSUPPORTED)` with a
   sited message naming table + column, e.g.: *"Cannot SET COLLATE to '<C>' on PRIMARY
   KEY column '<col>' of '<schema>.<table>': this module enforces PK uniqueness
   physically under a fixed table key collation ('<K>'); a divergent per-column PK
   collation is unsupported."* No mutation, no persist — table left unchanged and
   writable (matches the existing reject-rollback shape). **Clean reject.**

Non-PK columns keep their existing behavior entirely (the non-PK UNIQUE existing-row
re-validation block landed by `store-set-collate-existing-row-revalidation`). A column
that is **both** PK and covered by a separate non-PK UNIQUE: run the PK divergence check
**first** (so a divergent change rejects before any UNIQUE re-scan); a consistent change
then falls through to the existing UNIQUE re-validation.

### Why no new `ModuleCapabilities` flag / engine routing branch

The accept/reject decision is intrinsically **module-internal**: it depends on the
store's **per-table** physical key collation K (`config.collation`), which the engine
does not own or track. An engine-side pre-dispatch gate (the `concurrencyMode` static-
field model) cannot make the C-vs-K call without first being handed K — a larger change
with no payoff. So this ticket realizes the negotiation via the **behavioral contract**
signaling style already recognized in `docs/module-authoring.md`: the module **throws
`UNSUPPORTED` from `alterTable`**, exactly the `alterPrimaryKey` "try-native → throw
`UNSUPPORTED`" exemplar that rule 4 ("Hard contract — no silent divergence") promotes to
a universal rule. `runAlterColumn` (`runtime/emit/alter-table.ts`) already awaits
`module.alterTable` and propagates a thrown `QuereusError` cleanly — **no engine change
needed**; the engine's "policy for the unsupported case" is to surface the sited reject.
The plan's `native | logical-enforce | reject` trichotomy collapses, for the store, to
`reject` (with the consistent case handled as plain schema-only, not a special mode).
This ticket therefore **rewords** the doc's earlier promise of a `native |
logical-enforce | reject` per-arm *signal* to reflect the contract-based resolution.

Benefit: the fix lands once in shared `store-module.ts` and is inherited automatically by
every store-backed plugin (leveldb, indexeddb, react-native-leveldb, nativescript).

## Edge cases & interactions

- **No-op to same collation stays honored** on every module — short-circuits before the
  divergence check, even when the column's declared collation already diverges from K
  (the pre-existing CREATE-time state is not repaired and not surfaced as an error).
- **Consistent change repairs the default divergence:** `SET COLLATE nocase` on a
  default (`NOCASE`-keyed, `BINARY`-declared) store PK column → honored schema-only;
  column now declares `NOCASE`, matching physical enforcement.
- **Divergent change is data-independent:** reject even on an **empty** table — the
  store fundamentally cannot enforce C forward, regardless of current row count (unlike
  the data-dependent `CONSTRAINT`-on-collision case).
- **One-way on a `NOCASE`-keyed store:** after `→NOCASE`, a later `→BINARY` is an actual
  change and rejects (C=`BINARY` != K=`NOCASE`). `BINARY` PK is genuinely unsupported
  there; this is expected, not a regression.
- **`RTRIM` / custom collations** on a store PK always reject (never in {`BINARY`,
  `NOCASE`} == K) — honest, the store's key encoder only does `BINARY`/`NOCASE`.
- **Composite PK, one member altered** (`primary key (a, b)`, `SET COLLATE` on `a`): the
  altered column's C is compared to K; the other member is untouched. Reject iff the
  altered member's C != K.
- **Column that is both PK and non-PK-UNIQUE:** PK divergence check runs first.
- **Casing:** `validateCollationForType` → `normalizeCollationName` returns UPPERCASE
  (`BINARY`/`NOCASE`/`RTRIM`). Compare against `(config.collation || 'NOCASE')`
  upper-cased so the C==K test is case-robust.
- **Isolation wrapper:** `IsolationModule` forwards `alterTable` to the underlying store,
  so a divergent PK `SET COLLATE` through isolation propagates the store's `UNSUPPORTED`
  unchanged — no isolation-layer change required.
- **`store-set-collate-pk-physical-rekey`** (the original blocked Option-B ticket) is
  **superseded** and no longer present in `tickets/blocked/` — nothing to delete. The
  module-side physical re-key and engine-side logical-enforce remain *documented future
  options* (see backlog parking below), not requirements of the store.

## Test plan

### `packages/quereus-store/test/alter-table-conformance.spec.ts` (per-module expectations — the home for memory↔store divergence)

- **Un-skip the deferred cell** (`it.skip('alterColumn SET COLLATE on a PK column …')`,
  ~line 377). Under the resolved design its fixture
  (`create table t (name text primary key) using store; insert ('abc'),('ABD')`) is the
  **consistent** case: K=`NOCASE` default, target `NOCASE` == K → **honored** schema-only;
  `'abc'`/`'ABD'` coexist (distinct under NOCASE keys), column becomes `NOCASE`, NOCASE
  ordering holds. The existing test body already accepts the honored branch — flip
  `.skip` → live and confirm it passes the honored arm.
- **Add a new arm: divergent PK `SET COLLATE` → clean `UNSUPPORTED`.** Reachable on the
  default store by first moving the column off `BINARY`:
  `create table t (name text collate nocase primary key) using store; insert ('abc'),('xyz')`
  then `alter table t alter column name set collate binary` → expect
  `{ kind: 'reject', codes: [StatusCode.UNSUPPORTED], site: /name|primary key|collat/i }`;
  `confirm('rejected')` asserts `table_info` collation still `NOCASE` and the table is
  still writable (`insert ('def')` succeeds).

### `packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic` (cross-module)

- **Add a PK consistent-honored section** (migrated from 41.7.1 §2's `'alpha'`/`'Beta'`
  fixture): `create table pko (k text primary key); insert ('alpha'),('Beta');
  alter ... set collate nocase` → succeeds on **both** modules (memory re-keys; store
  applies schema-only because target == K), then `insert ('ALPHA')` →
  `error: UNIQUE constraint failed` on both, `order by k` identical. Update the file
  header to note PK consistent-collation cases now run cross-module.

### `packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic` (memory-only)

- **Keep §1** (`'a'`/`'A'` → `SET COLLATE nocase` → memory re-key collision reject): its
  fixture is **impossible** on the store (the two rows can't coexist under the NOCASE
  key), so it stays genuinely memory-only.
- **Remove §2** (migrated to 41.7.2 above) and **rewrite the file header**: drop the
  "deferred to store-set-collate-pk-physical-rekey / Option B" language; state that the
  store now rejects a *divergent* PK `SET COLLATE` (`UNSUPPORTED`, asserted in the store
  conformance spec) and honors a *consistent* one (cross-module in 41.7.2), and that only
  the physically-impossible memory re-key collision fixture remains here.
- `packages/quereus/test/logic.spec.ts`: 41.7.1 stays in `MEMORY_ONLY_FILES`; update its
  inline comment to match the rewritten header (no longer "PK re-key deferred").

### Docs

- `docs/module-authoring.md`:
  - Surface-inventory `alterColumn.setCollation (PK column)` cell (~line 330): change
    **"✗ silent no-op → SILENT DIVERGENCE"** → **"✓ negotiated rejection (throws
    `UNSUPPORTED` on a divergent PK collation; schema-only when the target equals the
    fixed key collation)"**; reclassify the row from *Silent divergence* to *Negotiated
    rejection*.
  - The note below it (~line 332) and rule 5 (~line 346): reword to record the
    resolution — the arm resolves to **reject** via the behavioral `throw UNSUPPORTED`
    contract (no new flag / engine routing branch), and that logical-enforce / physical
    re-key remain documented future options, not shipped.
  - The `setCollation` mandate in the Schema-Changes section (~line 535): note the
    fixed-physical-key-collation module variant (honor-iff-consistent, else
    `UNSUPPORTED`) alongside the re-key mandate.
- `packages/quereus/src/vtab/module.ts`: extend the `SchemaChangeInfo` `alterColumn`
  `setCollation` doc (~line 422) — a module that enforces the PK physically under a
  fixed key collation MUST throw `UNSUPPORTED` (sited) on a divergent PK-column
  `setCollation` and MAY apply it schema-only when the target equals that key collation;
  never silently no-op. (The re-key mandate stays for native modules like memory.)
- `docs/sql.md` §2.7 and `docs/schema.md` store-collation notes: document the store's
  PK `SET COLLATE` behavior (consistent → schema-only; divergent → `UNSUPPORTED`); drop
  / reword the PK-deferral caveat.

## Backlog parking (out of scope — file in `tickets/backlog/` as future enhancements)

- **`store-pk-collate-logical-enforce`** — engine/module-side write-time logical PK
  uniqueness scan so a `BINARY`-keyed store can honor a `→NOCASE` PK collation (the one
  divergence direction reject closes off). Carries a hot-path full-scan cost (or a
  covering-MV requirement); only meaningful for non-default `BINARY`-keyed store tables.
- **`store-pk-collate-physical-rekey`** — module-side per-column PK key collation +
  ALTER-time physical re-encode + dup scan (the original Option B), honoring any
  divergent PK collation like memory does. Requires an on-disk key-format change /
  migration for existing LevelDB stores.

## TODO

### Phase 1 — store reject logic
- In `store-module.ts` `alterColumn` `setCollation` branch (~line 1105), after computing
  `normalized` and the no-op short-circuit, add: if the altered column is in
  `oldSchema.primaryKeyDefinition`, compute `K = (table.getConfig().collation || 'NOCASE').toUpperCase()`
  and throw `QuereusError(UNSUPPORTED)` (sited, names schema.table.column + K + target)
  when `normalized !== K`. Place this **before** the `collationChanged` UNIQUE
  re-validation block so a divergent PK change rejects first.
- Leave the non-PK UNIQUE re-validation block and all other arms untouched.

### Phase 2 — module contract + docs
- Update `module.ts` `SchemaChangeInfo.alterColumn.setCollation` doc.
- Update `docs/module-authoring.md` (inventory cell + classification, the note, rule 5,
  the mandate line), `docs/sql.md` §2.7, `docs/schema.md`.

### Phase 3 — tests
- Store conformance spec: un-skip the PK cell (honored branch) + add the divergent-reject
  arm.
- Migrate 41.7.1 §2 → 41.7.2 as a cross-module PK consistent-honored section; rewrite
  both file headers; keep 41.7.1 §1 memory-only; update the `logic.spec.ts`
  `MEMORY_ONLY_FILES` comment.
- File the two backlog tickets.

### Phase 4 — validate
- `yarn workspace @quereus/quereus build` then targeted runs:
  - `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/q.log; tail -n 60 /tmp/q.log`
    (memory mode — exercises 41.7.1/41.7.2 memory legs).
  - `yarn workspace @quereus/quereus-store test 2>&1 | tee /tmp/qs.log; tail -n 60 /tmp/qs.log`
    (store conformance spec — the un-skipped + new reject arm).
  - Store-mode logic sweep for 41.7.2 cross-module:
    `yarn test:store 2>&1 | tee /tmp/store.log; tail -n 80 /tmp/store.log` (slower; if its
    wall-clock approaches the idle window, scope to the collate files or defer the full
    store sweep to CI and document the deferral).
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
