description: Close the CREATE-time store PK collation silent-divergence gap — normalize an implicit/default text-PK column's declared collation up to the fixed table key collation K so `table_info` stops lying (declared BINARY / enforced NOCASE), and reject an *explicitly* declared divergent per-column text-PK collation with a sited UNSUPPORTED, mirroring the shipped ALTER guard.
prereq:
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/src/schema/column.ts, packages/quereus/src/schema/table.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus/test/logic/41.7-alter-column-collate.sqllogic, docs/module-authoring.md
effort: xhigh
----

## Reproduced (fix stage)

A throwaway store-conformance spec (in-memory KV provider) confirmed both halves of the gap:

```
create table t (x text primary key) using store
  → table_info('t').collation for x = "BINARY"        (declared)
  → insert 'a'; insert 'A'  →  "UNIQUE constraint failed: t PK."   (enforced NOCASE)

create table t (x text collate binary primary key) using store
  → table_info('t').collation for x = "BINARY"        (declared, explicit)
  → insert 'a'; insert 'A'  →  "UNIQUE constraint failed: t PK."   (enforced NOCASE)
```

Declared `BINARY` vs enforced `NOCASE` — the exact silent divergence the ALTER path now
rejects (`store-module.ts:1132-1143`), at the CREATE entry point and at the *default* table.

## Root cause

`StoreTable` encodes every text PK key segment under a single fixed table-level collation
**K** = `config.collation || 'NOCASE'` (`store-table.ts:173`, `encodeOptions`). The engine builds
each column's *declared* collation via `columnDefToSchema`, which defaults to `'BINARY'`
(`table.ts:220`; default also at `column.ts:59`) and only overrides it on an explicit `collate`
clause (`table.ts:250-255`). So a text PK column declared without a collation (the default
`create table t (x text primary key)`) carries declared `BINARY` while its key bytes are encoded
and compared under K = `NOCASE`. `table_info().collation` reports `BINARY`; PK uniqueness /
point-lookup / ordering are governed by `NOCASE`.

**Decisive plumbing fact — explicit vs implicit is NOT distinguishable store-side today.**
`module.create(db, baseTableSchema)` receives only the resolved `TableSchema`
(`manager.ts:2251`); the AST `stmt.columns` (which alone records whether the user wrote
`collate binary`) never reaches the module, and `vtabArgs` carries only the module args, not
`statementColumns`. After `columnDefToSchema`, an implicit-default column and an explicit
`collate binary` column are byte-identical (`collation:'BINARY'`, no explicitness bit). Therefore
the ticket's desired split — **normalize the implicit default, reject the explicit divergence** —
cannot be done from the store alone. It requires the engine to surface one bit of provenance.

**Why a store-side schema mutation in `create` is sufficient to fix `table_info`.**
`finalizeCreatedTableSchema` registers `tableInstance.tableSchema` (`manager.ts:1972`), i.e. the
schema the freshly-built `StoreTable` holds (`store-table.ts:170`). So if `create` hands
`StoreTable` a schema whose PK columns' declared collation has been normalized to K, `table_info`
reports K with no further engine change. Errors thrown from `create` propagate with their code
preserved and the original (sited) message embedded (`manager.ts:2251-2255`), so a `UNSUPPORTED`
thrown here surfaces exactly like the ALTER reject.

## Chosen approach — normalize implicit, reject explicit (full ALTER symmetry)

Add one additive engine signal, then act on it in the store:

1. **Engine: mark explicit collation.** Add an optional `collationExplicit?: boolean` to
   `ColumnSchema` (`column.ts`). Set it `true` in the `collate` case of `columnDefToSchema`
   (`table.ts:250-255`) — only when a `collate` constraint is present; leave it `undefined`
   otherwise (the implicit default). Purely additive; the memory module and all existing
   consumers ignore it.

2. **Store `create`: normalize-or-reject text PK columns.** Before constructing `StoreTable`,
   walk `tableSchema.primaryKeyDefinition`. For each PK member that is a **text** column
   (collation is meaningful only for text — see "Scope" below) whose declared collation,
   upper-cased, diverges from K (`(config.collation || 'NOCASE').toUpperCase()`):
   - if `col.collationExplicit` → throw a sited `QuereusError(StatusCode.UNSUPPORTED)` mirroring
     the ALTER guard message at `store-module.ts:1132-1143` (name the column, the table, K, and
     that a divergent per-column PK collation is unsupported because the module enforces PK
     uniqueness physically under a fixed table key collation);
   - else (implicit default) → normalize: produce an updated `ColumnSchema` with
     `collation = K` (canonical upper-case spelling, as `validateCollationForType` yields).
   Build the normalized `columns` array + `columnIndexMap` and hand THAT schema to `new
   StoreTable(...)` (and let it flow back through `finalizeCreatedTableSchema`). A non-divergent
   PK column (already K, or explicitly declared == K) is passed through untouched.

3. **Store `connect`/rehydrate: normalize only, never reject.** The load path must stay lenient —
   rejecting on reopen would make a table un-loadable. Apply the same text-PK normalization in
   `connect` (`store-module.ts:233-299`, before `new StoreTable`) but **without** the reject
   branch: an explicit-divergent persisted DDL (legacy / hand-authored) is normalized up to K and
   logged, not thrown. Note that post-fix this branch is largely a no-op: a normalized create
   persists `collate <K>` in its DDL, so reopen re-parses to K and finds no divergence.

This reaches full symmetry with ALTER: an *explicit* divergent per-column PK collation is rejected
at BOTH CREATE and ALTER; the *implicit* default (which must never error — it is the default
table) is normalized so `table_info` is honest.

### Fallback (only if the engine bit is deemed out of scope)
Ship **normalize-only, uniform** (normalize every divergent text PK column, drop the reject). This
still closes the `table_info` lie for the default and all cases and is store-only, but it silently
coerces an explicit `collate binary` to K instead of rejecting it (a milder, *visible*-in-
`table_info` coercion rather than a silent declared≠enforced split). Document the asymmetry in the
review handoff if this fallback is taken. The recommended path is the engine-bit version above —
it is small, additive, and the faithful mirror.

## Scope / guardrails

- **Text PK columns only.** Collation is meaningful only for text; `encodeOptions.collation`
  affects only text key segments. An `integer primary key` must keep declared `BINARY` — do NOT
  normalize non-text PK columns. This is also why the existing memory+store sqllogic in
  `41.7-alter-column-collate.sqllogic` (all `id integer primary key`, text columns non-PK) is
  unaffected: integer PKs aren't normalized and non-PK text columns aren't touched.
- **Composite PK.** The membership walk must cover every text member of a composite PK (mirrors
  the ALTER guard's `primaryKeyDefinition.some(...)`), since `encodeOptions` applies K uniformly to
  all text key segments.
- **`default_collation` pragma interaction** (separate `default-collation-pragma` ticket, already
  in `plan/`): when a DB sets `default_collation = nocase`, columns are declared `NOCASE` == K, so
  no divergence arises and this code is a no-op for that case. K itself stays `NOCASE`-default
  (changing it is migration-unsafe; that lives with the parked `store-pk-collate-physical-rekey`).
- **Migration safety.** Normalize touches only the in-memory/declared schema and the regenerated
  DDL (which already emits the column collation). No on-disk key re-encoding — K is unchanged, so
  existing key bytes stay valid.

## Test expectations

Store-specific assertions belong in the **store** test package (the value differs from memory, so
they cannot go in shared sqllogic). Add to `packages/quereus-store/test/` — either extend
`alter-table-conformance.spec.ts` with a CREATE section or add a sibling
`create-table-conformance.spec.ts` using the same in-memory KV provider:

- `create table t (x text primary key) using store` → `table_info('t').collation` for `x` reports
  `NOCASE` (== enforced K); no BINARY-declared / NOCASE-enforced split.
- `create table t (x text collate nocase primary key) using store` (explicit == K) → honored,
  collation `NOCASE`.
- `create table t (x text collate binary primary key) using store` (explicit ≠ K) → rejected with
  a sited `UNSUPPORTED` (site regex on column/PK/collation); the table is not created.
- Composite PK with a text member declared divergent-explicit → rejected; with a text member
  left implicit → normalized to K, other members unaffected.
- An `integer primary key` text-less PK still reports `BINARY` (negative guard against
  over-normalizing non-text columns).
- The default PK no longer needs an explicit `alter … set collate nocase` "repair": after the
  default create, `alter t alter column x set collate binary` is now a genuine divergent change
  (current declared == NOCASE) and rejects via the existing ALTER guard — rather than no-op'ing
  into a perpetuated divergence.

## TODO

- [ ] Add `collationExplicit?: boolean` to `ColumnSchema` (`packages/quereus/src/schema/column.ts`);
      leave it out of `createDefaultColumnSchema`'s defaults (undefined == implicit).
- [ ] Set `schema.collationExplicit = true` in the `collate` case of `columnDefToSchema`
      (`packages/quereus/src/schema/table.ts:250-255`).
- [ ] In `StoreModule.create` (`store-module.ts:187-227`), after `parseConfig`, normalize-or-reject
      each text PK column vs K (reject when `collationExplicit`, else normalize to K), and pass the
      rebuilt schema (new `columns` + `columnIndexMap`) to `new StoreTable`. Factor the per-column
      logic into a small helper (e.g. `reconcilePkCollations(schema, K, { reject })`) reused by
      `connect`.
- [ ] In `StoreModule.connect` (`store-module.ts:233-299`), apply the same helper with
      `{ reject: false }` (normalize + log; never throw) before constructing `StoreTable`.
- [ ] Make the reject message a faithful mirror of the ALTER guard (`store-module.ts:1132-1143`):
      name column, `schema.table`, K, and the fixed-key-collation rationale; code `UNSUPPORTED`.
- [ ] Add the store-side CREATE conformance tests above (new spec or CREATE section in
      `alter-table-conformance.spec.ts`).
- [ ] Run `yarn test` (memory leg) AND `yarn test:store` (store leg). Grep the store-leg sqllogic
      for `text primary key` + `table_info(... collation ...)` assertions that could shift now that
      a text store PK reports K; reconcile `41.7.2-alter-column-collate-unique-store.sqllogic` and
      any other store-specific text-PK file if affected.
- [ ] `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- [ ] Update `docs/module-authoring.md` § "No silent divergence" (and the `docs/schema.md`
      store-collation note referenced in `store-module.ts` comments) to state that a store text PK
      column's declared collation is reconciled to the fixed table key collation K at CREATE/connect
      — normalized when implicit, rejected (`UNSUPPORTED`) when explicitly divergent.
