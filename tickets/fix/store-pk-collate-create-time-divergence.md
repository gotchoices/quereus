description: Close the CREATE-time counterpart of the store PK SET COLLATE silent-divergence gap — a store table whose PK column's *declared* per-column collation diverges from the fixed table key collation K (the default `create table t (x text primary key) using store` is born this way: column declared BINARY, key enforced NOCASE) reports the declared collation in `table_info` while enforcing K, the exact silent divergence the ALTER path now rejects.
prereq: store-pk-collate-physical-rekey
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/logic/41.7-alter-column-collate.sqllogic, packages/quereus-store/test/alter-table-conformance.spec.ts
----

## Background

`store-pk-collate-module-capability` closed the silent-divergence gap on the **ALTER**
path: `ALTER COLUMN … SET COLLATE` on a store PK column now rejects a target collation that
diverges from the fixed table-level key collation K (`config.collation`, one of
`BINARY` / `NOCASE`, default `NOCASE`) with a sited `UNSUPPORTED`, and applies a consistent
one (target == K) schema-only.

The **CREATE** path was explicitly out of that ticket's scope and still admits the same
silent divergence:

- `create table t (x text primary key) using store` — the engine builds the column with the
  default declared collation **BINARY** (`columnDefToSchema`), while the store encodes/enforces
  the PK key bytes under K = **NOCASE** (the store config default). The column reports
  `collation = BINARY` in `table_info`, but PK uniqueness and point-lookup are governed by
  NOCASE. Declared ≠ enforced — observable divergence, never surfaced.
- `create table t (x text collate binary primary key) using store` (default K = NOCASE), or any
  explicit per-column PK COLLATE that differs from K, is the same divergence stated explicitly.

The ALTER guard does not repair this: `alter … set collate binary` on the default PK
short-circuits as a no-op (target == the column's *current* declared BINARY) before the PK
divergence guard runs, so it "succeeds" while leaving the column declared BINARY / enforced
NOCASE. The only way a user reaches a consistent state today is to explicitly
`alter … set collate nocase` (the documented "repair").

This is store-specific: the memory module enforces the PK under each column's per-column
collation, so its default PK is declared BINARY *and* enforced BINARY — no divergence.

## Why it matters

The "no silent divergence" contract (docs/module-authoring.md § No silent divergence) is the
whole thesis of the module-capability work. Leaving the CREATE path (and the default table!)
in a declared-vs-enforced mismatch is the same class of bug, just at a different entry point —
`table_info().collation` lies about how the PK actually compares.

## Options

1. **Normalize at create (cheap, recommended interim).** In `StoreModule.create` (and the
   rehydrate/`connect` path), reconcile each PK column's declared collation to K so declared ==
   enforced. The default `create table t (x text primary key) using store` would then report
   `collation = NOCASE` in `table_info`, matching the physical key. An *explicit* divergent
   per-column PK COLLATE could either be silently normalized (with a note) or rejected with a
   sited `UNSUPPORTED` at CREATE, mirroring the ALTER guard. (Decision point for the
   plan/implement stage — reject is the more honest mirror of the ALTER behavior, normalize is
   the less surprising one for the implicit-default case.)
2. **Full per-column PK key collation (subsumes this).** `store-pk-collate-physical-rekey`
   makes the PK key collation genuinely per-column; once landed, declared always equals enforced
   and this divergence cannot arise — so that ticket is the structural fix and is listed as a
   prereq. This ticket exists to capture the cheaper interim reconciliation in case the on-disk
   re-key migration stays parked.

## Test expectations

- After `create table t (x text primary key) using store`, `table_info('t').collation` for `x`
  reports the same collation the store enforces (no BINARY-declared / NOCASE-enforced split).
- An explicit `create table t (x text collate <C> primary key) using store (collation=<K>)` with
  C ≠ K resolves per the chosen option (rejected with a sited `UNSUPPORTED`, or normalized to K
  with the declared collation updated to match) — never silently declared-C / enforced-K.
- The default PK no longer needs an explicit `alter … set collate nocase` "repair" to be
  consistent; a `set collate binary` on it is then a genuine divergent change and rejects like
  the other divergent ALTERs (rather than no-op'ing into a perpetuated divergence).
