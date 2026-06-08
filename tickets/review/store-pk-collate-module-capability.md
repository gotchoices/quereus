description: Review the store's PK-column `SET COLLATE` negotiation — accept-when-consistent (schema-only when target == fixed key collation) / reject-when-divergent (sited `UNSUPPORTED`). Closes the former silent-divergence gap without a new capability flag or engine routing branch.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/module.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic, packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic, packages/quereus/test/logic.spec.ts, docs/module-authoring.md, docs/sql.md, docs/schema.md
----

## What shipped

The store enforces PRIMARY KEY uniqueness **physically** under a single fixed table-level key
collation **K** (`StoreTable.encodeOptions = config.collation || 'NOCASE'`), not the PK column's
*declared* per-column collation. A PK-column `SET COLLATE` to a collation C was previously applied
schema-only and never enforced when C diverged from K — the silent-divergence the ALTER-conformance
matrix forbids.

This work resolves the store's `alterColumn` `setCollation` arm to **accept-when-consistent /
reject-when-divergent**, realized entirely inside the module via the behavioral *throw
`UNSUPPORTED`* contract (no new `ModuleCapabilities` flag, no engine pre-dispatch routing branch —
the C-vs-K decision depends on the module's per-table K, which the engine does not track):

1. **No-op short-circuit (unchanged, first):** target == column's *current* collation → return
   `oldSchema` untouched (no scan, no persist). Does not surface the pre-existing CREATE-time
   col-vs-K divergence as an error.
2. **Consistent change (C == K):** apply schema-only — forward PK uniqueness is already physically
   correct under C. The common `SET COLLATE nocase` on a default (`NOCASE`-keyed) store PK lands
   here and *repairs* the default `BINARY`-declared / `NOCASE`-keyed divergence.
3. **Divergent change (C != K):** throw `QuereusError(StatusCode.UNSUPPORTED)`, sited (names
   `schema.table`, column, and K). No mutation, no persist — table left unchanged and writable.
   Data-independent: rejects even on an empty table.

The PK divergence guard runs **before** the existing non-PK UNIQUE existing-row re-validation block,
so a column that is both PK and separately UNIQUE rejects on divergence before any UNIQUE re-scan.
Non-PK behavior is entirely untouched.

## Core change

`packages/quereus-store/src/common/store-module.ts`, `alterColumn` → `setCollation` branch
(~line 1119): after the no-op short-circuit, if the altered column is in
`oldSchema.primaryKeyDefinition`, compute `K = (table.getConfig().collation || 'NOCASE').toUpperCase()`
and throw `UNSUPPORTED` when `normalized !== K`. `normalized` comes from
`validateCollationForType` → `normalizeCollationName` (UPPERCASE: `BINARY`/`NOCASE`/`RTRIM`); K is
upper-cased for a case-robust compare. `QuereusError` / `StatusCode` were already imported.

## How to validate

### Store conformance matrix (the home for memory↔store divergence)
`packages/quereus-store/test/alter-table-conformance.spec.ts` — two new live ARMS (the old
`it.skip` deferred cell was removed, replaced by a pointer comment):
- **Consistent honored:** `create table t (name text primary key) using store; insert ('abc'),('ABD')`
  → `set collate nocase` (target NOCASE == default K) → honored schema-only; `'abc'`/`'ABD'` coexist
  (distinct NOCASE keys), column becomes NOCASE, NOCASE ordering holds.
- **Divergent reject:** `create table t (name text collate nocase primary key) using store;
  insert ('abc'),('xyz')` → `set collate binary` (BINARY != K NOCASE) → `UNSUPPORTED`, site
  `/name|primary key|collat/i`; confirm `table_info` collation still NOCASE and the table still
  writable (`insert ('def')` succeeds).

Run: `yarn workspace @quereus/store test` → **368 passing** (clean run; the "Error: boom" and
rehydrate-skip log lines are deliberate fixtures in events.spec.ts / rehydrate tests, not failures).

### Cross-module sqllogic
- `41.7.2-...-store.sqllogic` **§9 (new, cross-module):** PK *consistent* collation change
  (`pko (k text primary key)`, `'alpha'`/`'Beta'`, `set collate nocase`) succeeds on both modules
  (memory re-keys; store schema-only), then a NOCASE-colliding `'ALPHA'` insert rejects with
  `UNIQUE constraint failed` on both. Migrated out of 41.7.1 §2.
- `41.7.1-...-unique.sqllogic` stays **memory-only** — only §1 remains (`'a'`/`'A'` PK re-key
  collision), which is *physically impossible* on the store (both rows map to the same NOCASE key).
  Headers of both files rewritten; `logic.spec.ts` `MEMORY_ONLY_FILES` comment updated.

Run: `yarn workspace @quereus/quereus test` → **5367 passing**, 9 pending (memory legs).
Store mode (scoped): `node packages/quereus/test-runner.mjs --store --grep "41\.7" --reporter spec`
→ 41.7 ✔, 41.7.1 skipped, 41.7.2 ✔.

### Docs touched
`module.ts` `SchemaChangeInfo.setCollation` doc; `docs/module-authoring.md` (inventory cell
reclassified *Silent divergence → Negotiated rejection*, the note, rule 5, the mandate row, the
no-silent-divergence note); `docs/sql.md` §2.7 ALTER COLUMN SET COLLATE; `docs/schema.md` (new
"Fixed physical key collation and PK SET COLLATE" note — there was no prior caveat to reword).

## Known gaps / things to scrutinize

- **Full store sweep deferred to CI.** I ran the store-mode logic sweep **scoped to the 41.7
  collate files** (`--grep "41\.7"`) to stay inside the agent idle window. The full
  `yarn test:store` (all logic files against LevelDB) was **not** run here — please run it in CI /
  out-of-band to confirm no broader store regression. The targeted run + full memory run + store
  unit suite all pass.
- **Type-checking the store change.** The store test runner uses Node type-stripping (no
  type-check), so I ran `yarn workspace @quereus/store typecheck` (`tsc --noEmit`) separately →
  clean. `yarn workspace @quereus/quereus lint` → clean. The store package has no lint script, so
  the conformance spec is type-checked but not ESLint'd.
- **Reject is intentionally one-sided coverage.** Reject closes *both* divergence directions
  honestly, but two narrower honor-the-change options were explicitly parked, not shipped, as
  backlog tickets — verify the scoping reads right:
  - `tickets/backlog/store-pk-collate-logical-enforce.md` — write-time logical PK scan so a
    `BINARY`-keyed store can honor `→NOCASE` (hot-path full-scan cost; narrow benefit).
  - `tickets/backlog/store-pk-collate-physical-rekey.md` — per-column PK key collation + ALTER-time
    physical re-encode (the original Option B; needs an on-disk key-format migration).
- **Edge cases asserted only by reasoning, not a dedicated test:** `RTRIM`/custom collations on a
  store PK always reject (never in `{BINARY,NOCASE}` == K) — covered by the general `normalized != K`
  logic but not a separate arm; a reviewer may want an explicit `RTRIM` PK reject arm. Composite-PK
  single-member alter and the PK+separate-UNIQUE ordering (PK guard first) are covered by code paths
  but could use a dedicated arm if the reviewer wants belt-and-suspenders.
- **Isolation wrapper:** `IsolationModule.alterTable` forwards to the underlying store, so a
  divergent PK `SET COLLATE` through isolation propagates the store's `UNSUPPORTED` unchanged — not
  separately tested here (no isolation-layer change was needed); worth a confirming glance.
- **Message wording / `StatusCode`** are a judgment call — confirm `UNSUPPORTED` (vs `CONSTRAINT`)
  is the right code for "the module structurally can't do this" (it matches the `alterPrimaryKey`
  try-native→`UNSUPPORTED` exemplar and the engine surfaces it as a clean user error).
