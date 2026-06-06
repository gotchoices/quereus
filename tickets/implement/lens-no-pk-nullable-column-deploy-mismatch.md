description: |
  A table declared with NO primary key silently forces every column NOT NULL,
  overriding an explicit `null` declaration, because the no-PK "all columns become
  the key" fallback feeds into the unconditional `notNull: isPkColumn ? true : …`
  promotion in `buildColumnSchemas`. The lens prover then trips
  `lens.nullability-mismatch` deploying such a logical table over a nullable basis.
  Fix: a *synthesized* all-columns key must not promote its columns to NOT NULL;
  only an *explicitly declared* PK (column-level `primary key` or table-level
  `primary key (...)`) forces NOT NULL. Uniform across storage + logical tables.
files:
  - packages/quereus/src/schema/table.ts            # findPKDefinition — the no-PK all-columns synthesis (lines ~580-617); columnDefToSchema column-level PK→notNull (~272-274)
  - packages/quereus/src/schema/manager.ts          # buildColumnSchemas — the unconditional notNull promotion (lines ~1083-1099)
  - packages/quereus/src/schema/lens-prover.ts      # checkTypeAndNullability — the lens.nullability-mismatch emit site (~397-431)
  - packages/quereus/test/lens-prover.spec.ts       # nullability-mismatch coverage (~205-216)
  - packages/quereus/src/util/comparison.ts         # compareSqlValuesFast — NULL==NULL=0, NULL sorts first (key identity sanity)
  - packages/quereus-store/src/common/encoding.ts   # store key codec — TYPE_NULL=0x00 sorts first (store NULL-in-key support)
  - docs/lens.md                                     # § Coverage checklist (type/nullability conformance rule)
  - docs/schema.md                                   # no-PK all-columns-key behaviour, if documented there
----

# A no-PK table's synthesized all-columns key must not force its columns NOT NULL

## Root cause (confirmed by repro)

Two pieces collude:

1. **`findPKDefinition`** (`schema/table.ts` ~597-609): when neither a column-level
   nor a table-level PRIMARY KEY is declared, Quereus synthesizes an **all-columns**
   primary key (a deliberate Quereus-specific choice — the whole row is the row
   identity). The code there even comments *"Don't require NOT NULL, we want to be
   more flexible"* (table.ts ~611) — i.e. the no-PK path **intends not** to force
   NOT NULL.

2. **`buildColumnSchemas`** (`schema/manager.ts` ~1086-1097) overrides that intent:

   ```ts
   const isPkColumn = pkDefinition.some(pkCol => pkCol.index === idx);
   return { ...col, primaryKey: isPkColumn, pkOrder,
            notNull: isPkColumn ? true : col.notNull };   // ← forces NOT NULL on EVERY key column
   ```

   Because the synthesized fallback makes **every** column a key column, every column
   is forced `notNull: true`, silently discarding an explicit `null` declaration.

The lens prover (`checkTypeAndNullability`, lens-prover.ts ~422) then sees the
forced-NOT-NULL logical column over a nullable basis expression and emits
`lens.nullability-mismatch`. That is the surfaced symptom; the defect is in schema
building, not in the prover.

### Repro results (verified this run)

- **No-PK logical table, columns `null`, nullable basis** → deploy blocked:
  `lens.nullability-mismatch` on each non-PK-matching nullable column (`a`, `b`).
  (The `id` column escaped only because it name-matched a NOT NULL basis `id`.)
- **Same column declarations but WITH a primary key** → deploys clean (only the PK
  column is forced NOT NULL; the others keep their declared nullability).
- **Storage table** `create table t (a integer null, b integer null)` (no PK):
  both columns report `notNull=true, pk=true`; `insert into t (a,b) values (null,5)`
  is **rejected** with `NOT NULL constraint failed: t.a`. So this is a *general*
  schema-building bug, not lens-specific — the lens prover is just the loudest
  witness.

## Design resolution

This is **option (a)** from the plan ticket: a no-PK table's nullable columns
should **stay nullable**; the NOT NULL promotion is the bug. (Not option (b) — the
storage repro proves the behaviour is wrong end-to-end, not merely a misleading
message: an explicit `null` is silently overridden and `null` inserts are rejected.)

**The rule:** `notNull` is forced **only for an explicitly-declared PK column**
(column-level `primary key`, which `columnDefToSchema` already handles at
table.ts ~272-274, and table-level `primary key (...)`). A **synthesized**
all-columns key — the no-PK fallback — must **not** promote nullability; each
column keeps the nullability the author declared (or the session default).

This is applied **uniformly** to storage and logical tables (both flow through
`buildColumnSchemas`), restoring the documented intent at table.ts ~611 and
resolving the manager.ts ↔ table.ts contradiction.

**Soundness of a nullable synthesized key.** NULL-in-key is already supported by
both backends, so the all-columns key remains a valid row identity even with
nullable members:
- memory: `compareSqlValuesFast` (comparison.ts ~244-250) treats `NULL == NULL` as
  equal and orders NULL first — two fully-identical rows (including all-NULL)
  collide as duplicate keys, which is the correct *set* semantics for "the whole
  row is the identity";
- store: `encoding.ts` encodes `TYPE_NULL = 0x00` (sorts first), so NULL key parts
  round-trip through the persisted key codec.

So after the fix, `insert (null, 5)` succeeds, and a second identical row raises a
duplicate-key conflict (ABORT) rather than a NOT NULL error.

## Implementation approach

`findPKDefinition` must tell its caller whether the returned `pkDef` was
**synthesized** (all-columns fallback) or **declared**. Then `buildColumnSchemas`
forces `notNull` only in the declared case.

- Extend `findPKDefinition`'s return shape with a discriminator, e.g.
  `{ pkDef, defaultConflict, synthesized: boolean }` (set `synthesized: true` only
  on the no-PK fallback branch at table.ts ~597-609; `false` for column-level and
  table-level declared PKs, including the empty-key `primary key ()` singleton).
- In `buildColumnSchemas` (manager.ts ~1086-1097) thread that flag and compute
  `notNull: (isPkColumn && !synthesized) ? true : col.notNull`. Leave
  `primaryKey: isPkColumn` and `pkOrder` as they are — the synthesized columns are
  still the row-identity key; only their *nullability* changes.
- Audit the other `findPKDefinition` call sites (it is exported / shared) and any
  consumer that assumes "a column with `primaryKey === true` is `notNull === true`".
  Most key machinery reads `primaryKeyDefinition` (the array) and is unaffected;
  the known explicit-assumption site is the **ALTER PRIMARY KEY** validator
  (`runtime/emit/alter-table.ts` ~903 "Column … must be NOT NULL to participate in
  PRIMARY KEY"), which only governs an explicit re-key and is *not* on the
  synthesized path — confirm it stays correct (do not relax it).

Keep the change small and centralized: the single decision point is "was the PK
synthesized?". Do not change `primaryKeyDefinition` contents, the singleton path, or
the lens prover's nullability check (it becomes correct for free once the logical
column's `notNull` reflects the declaration).

## Edge cases & interactions

- **Storage no-PK + nullable column, NULL insert** — now succeeds (was rejected).
  Add coverage: `insert (null, …)` lands; a second fully-identical row conflicts on
  the synthesized key (duplicate-key ABORT), not a NOT NULL error.
- **Storage no-PK single-column** `create table t (a integer null)` — pkDef = `[a]`,
  `a` stays nullable; one NULL row allowed, a second NULL row is a duplicate.
- **Explicit table-level PK over a `null`-declared column** `primary key (a)` with
  `a integer null` — `a` is still forced NOT NULL (declared PK, standard SQL);
  non-PK columns keep their declared nullability. Must NOT regress.
- **Column-level `a integer null primary key`** — `columnDefToSchema` already forces
  NOT NULL (explicit PK wins over the contradictory `null`). Unchanged.
- **Empty-key singleton `primary key ()`** — declared, not synthesized; zero key
  columns, nothing to promote. Unchanged.
- **`default_column_nullability` session option** — when set to `not_null`, a no-PK
  table's columns are NOT NULL via the *session default* (`defaultNotNull`), not via
  key promotion. After the fix they must remain NOT NULL by that default; the fix
  only removes the *key-driven* override, it does not flip the session default.
- **Lens deploy paths** (all must be tested via `apply schema`):
  - no-PK logical table over a **nullable** basis → deploys clean (the original bug
    fixed); the table remains writable; verify obligations/round-trip unaffected.
  - no-PK logical table over a **NOT NULL** basis → still deploys clean.
  - logical column declared **NOT NULL** over a nullable basis → still errors
    `lens.nullability-mismatch` (the genuine case at lens-prover.spec.ts ~205-216
    must keep passing — it uses an explicit `id primary key`, so `note` keeps its
    Third-Manifesto NOT NULL default and the error stays correct).
  - `checkKeyReconstructibility` over the synthesized all-columns logical key is
    unchanged (pkDefinition contents unchanged); confirm a no-PK logical table is
    not spuriously flagged read-only by a faithful projection.
- **DDL round-trip / schema-differ** (`ddl-generator.ts`, `schema-differ.ts`) — a
  no-PK table's nullable columns must now render with the correct nullability
  annotation and round-trip without churning a NOT NULL/ALTER diff. Watch the
  single-column synthesized case (ddl-generator only emits column-level
  `PRIMARY KEY` when `primaryKeyDefinition.length === 1`).
- **Store path parity** — the same nullability now reaches the store key codec.
  Run the relevant store-backed logic (see TODO) to confirm NULL-in-key persistence
  and dedup behave identically to memory; this is the highest-risk cross-subsystem
  interaction.
- **`quereus-isolation`** — snapshot/sort-key building over PK columns
  (`isolated-table.ts` buildSortKey/extractPK) must tolerate NULL key parts (it
  uses the shared comparator, so expected fine — confirm no NOT-NULL assumption).

## Key tests (TDD)

- `test/lens-prover.spec.ts`: **add** a case — no-PK logical table with `null`
  columns over a nullable basis deploys without error and is writable; pin the
  outcome so it cannot silently regress. Keep the existing NOT-NULL-over-nullable
  error case green.
- A schema-building unit test (e.g. alongside `capabilities.spec.ts` /
  `memory-vtable.spec.ts`): a no-PK table's nullable columns report
  `notNull === false`; an explicit-PK column reports `notNull === true`.
- A sqllogic or memory test: no-PK nullable storage table accepts a NULL insert and
  rejects a duplicate identical row with a key/constraint conflict (not a NOT NULL
  error).
- Align `docs/lens.md` § Coverage checklist (type/nullability conformance wording)
  and, if it documents the no-PK all-columns-key, `docs/schema.md`, to state that
  a synthesized key preserves declared nullability.

## TODO

- Add the `synthesized` discriminator to `findPKDefinition` (table.ts) and set it
  only on the no-PK all-columns fallback branch.
- Thread it into `buildColumnSchemas` (manager.ts) and gate the `notNull`
  promotion on `!synthesized`.
- Audit `findPKDefinition` call sites and `primaryKey`-implies-`notNull` assumptions
  (esp. `runtime/emit/alter-table.ts` ALTER PRIMARY KEY validator — leave intact).
- Add the lens-prover deploy test (no-PK nullable over nullable basis → clean).
- Add the schema-building notNull-state unit test (synthesized vs explicit PK).
- Add the storage NULL-insert + duplicate-row test.
- Run `yarn build` and `yarn test` (memory). Then run the store path for the
  affected area — stream output, e.g.
  `yarn workspace @quereus/quereus run test:store 2>&1 | tee /tmp/store.log; tail -n 80 /tmp/store.log`
  — to confirm NULL-in-key parity. If full `test:store` wall-clock approaches the
  idle window, narrow to the constraint/transaction logic files and note the
  deferral.
- Update `docs/lens.md` (and `docs/schema.md` if applicable).
