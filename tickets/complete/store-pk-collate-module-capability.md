description: Store PK-column SET COLLATE negotiation — accept-when-consistent (schema-only when target == fixed table key collation K) / reject-when-divergent (sited UNSUPPORTED). Closes the silent-divergence gap on the ALTER path with no new capability flag and no engine routing branch.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/vtab/module.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic, packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic, packages/quereus/test/logic.spec.ts, docs/module-authoring.md, docs/sql.md, docs/schema.md
----

## What shipped

The store enforces PRIMARY KEY uniqueness **physically** under a single fixed table-level key
collation K (`StoreTable.encodeOptions = config.collation || 'NOCASE'`), not the PK column's
declared per-column collation. A PK-column `SET COLLATE` to a collation C was previously applied
schema-only and silently unenforced when C diverged from K.

`StoreModule.alterColumn`'s `setCollation` arm now resolves the PK case via the behavioral
*throw `UNSUPPORTED`* contract (no new `ModuleCapabilities` flag, no engine pre-dispatch routing):

1. **No-op short-circuit (first):** target == column's *current* declared collation → return
   `oldSchema` untouched.
2. **Consistent change (C == K):** apply schema-only — forward PK uniqueness is already physically
   correct under C. The common `set collate nocase` on a default NOCASE-keyed store PK lands here.
3. **Divergent change (C != K):** throw `QuereusError(StatusCode.UNSUPPORTED)`, sited (names
   `schema.table`, the column, and K). No mutation, no persist; data-independent (rejects on an
   empty table). The PK divergence guard runs **before** the existing non-PK UNIQUE re-validation,
   so a column that is both PK and separately UNIQUE rejects on divergence first.

Engine-side honoring of a divergent PK collation (write-time logical PK scan, or per-column key
collation + physical re-key) was explicitly parked as `store-pk-collate-logical-enforce` and
`store-pk-collate-physical-rekey`. Reject is the complete, honest resolution today.

## Review findings

**Scope reviewed:** the implement-stage diff (commit `f61bdd33`) read first with fresh eyes — the
core `store-module.ts` guard, the `module.ts` contract doc, the conformance-spec arms, the two
sqllogic file rewrites + `MEMORY_ONLY_FILES` comment, the three doc edits, and the two parked
backlog tickets. Cross-checked against `encoding.ts` (collation lookup), `comparison.ts` /
`table.ts` (collation normalization), `store-table.ts` (`encodeOptions`, getConfig), and the
isolation `alterTable` forwarding path.

**Correctness / logic — verified sound.**
- Collation casing is consistent end-to-end: `normalized` comes from `normalizeCollationName`
  (UPPERCASE); K is `(config.collation || 'NOCASE').toUpperCase()`; the physical encoder
  (`getCollationEncoder`) is itself case-insensitive (upper-cases the name) — so the guard's
  C-vs-K compare faithfully reflects the bytes actually written. The no-op compare
  (`normalized === (oldCol.collation || 'BINARY')`) is uppercase-vs-uppercase (column collation is
  stored normalized via `columnDefToSchema`/`validateCollationForType`).
- The PK membership test (`primaryKeyDefinition.some(def => def.index === colIndex)`) matches the
  index-based shape used elsewhere in the same method (e.g. the DROP NOT NULL PK guard).
- `UNSUPPORTED` (not `CONSTRAINT`) is the right code — matches the `alterPrimaryKey`
  try-native→`UNSUPPORTED` exemplar; "the module structurally can't do this," not a data condition.
- **Isolation propagation (handoff flagged as untested):** confirmed by reading
  `isolation-module.ts alterTable` — for a non-addColumn change `addColumnCtx` is undefined, the
  issuer-overlay pre-validate only runs the tombstone guard (no mutation), and the throw originates
  at `underlying.alterTable` (which the issuer path does not wrap in try/catch). The store rejects
  *before* `updateSchema`/`saveTableDDL`, so a divergent PK `SET COLLATE` through isolation→store
  propagates `UNSUPPORTED` cleanly with nothing half-applied. No isolation change needed.

**Tests — extended this pass (minor, fixed inline).** The implementer flagged RTRIM/custom-collation
and composite-PK reject as "asserted only by reasoning." Added two live arms to
`packages/quereus-store/test/alter-table-conformance.spec.ts`:
- *RTRIM target on a PK column* → `UNSUPPORTED` (exercises the general `normalized != K` branch with
  a collation outside the {BINARY, NOCASE} pair; K's type can only ever be BINARY/NOCASE, so a third
  collation always rejects).
- *Composite-PK single-member divergent change* → `UNSUPPORTED` (exercises the membership test for a
  multi-column PK; the non-altered member is unaffected; table stays writable after the reject).
Both confirm the column collation is unchanged and the table writable post-reject. Store suite:
**370 passing** (was 368).

**Docs — verified accurate against the new reality.** `module.ts` `setCollation` contract,
`docs/module-authoring.md` (inventory cell reclassified Silent-divergence → Negotiated-rejection,
rules 4/5, the mandate row, the no-silent-divergence note), `docs/sql.md` §ALTER COLUMN SET COLLATE,
and `docs/schema.md` (new fixed-key-collation note) all read correctly and consistently.

**Major finding — filed, not fixed:** the CREATE path still admits the *same* class of silent
divergence the ALTER path now closes. `create table t (x text primary key) using store` is born
with the column declared `BINARY` (engine default) while the store enforces the PK under K=`NOCASE`
— `table_info().collation` reports BINARY but uniqueness/lookup use NOCASE. The ALTER no-op
short-circuit (target == current declared) even lets `set collate binary` on the default PK
"succeed" while perpetuating the divergence. This was explicitly out of this ticket's ALTER scope
(the handoff acknowledges "does not surface the pre-existing CREATE-time col-vs-K divergence") and
is **not** covered by the two existing backlog tickets (which honor *divergent ALTERs*, not the
declared-vs-K mismatch at create). Filed `tickets/backlog/store-pk-collate-create-time-divergence.md`
(prereq: `store-pk-collate-physical-rekey`, which structurally subsumes it) capturing both a cheap
create-time reconciliation option and the structural fix.

**Empty categories:** No DRY / dead-code / type-safety / resource-cleanup / error-handling findings —
the change is a localized guard reusing existing imports and helpers, throws (never swallows), adds no
new state to clean up, and is fully typed (store `tsc --noEmit` clean). No performance concern — the
guard is an O(PK-columns) membership test with no scan on either the consistent or divergent path.

## Validation run

- `yarn workspace @quereus/store test` → **370 passing** (added 2 arms; the "Error: boom" /
  rehydrate-skip log lines are deliberate fixtures, not failures).
- `yarn workspace @quereus/store typecheck` (`tsc --noEmit`) → clean.
- `yarn workspace @quereus/quereus lint` → clean.
- `node packages/quereus/test-runner.mjs --grep "41\.7"` (memory) → 3 passing.
- `node packages/quereus/test-runner.mjs --store --grep "41\.7"` (store) → 2 passing, 41.7.1 skipped
  (memory-only as intended).

## Deferred to CI / out-of-band

The full `yarn test:store` (all logic files against LevelDB) was **not** run here — the store-mode
sweep was scoped to the 41.7 collate files to stay inside the agent idle window. The targeted store
run, full memory run, and store unit suite all pass; a full store regression sweep should run in CI.
