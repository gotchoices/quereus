description: `apply schema` is NON-IDEMPOTENT under a non-BINARY `default_collation` whenever it ADDs a column. The differ resolves the declared side to the default (e.g. NOCASE) but ADD COLUMN creates the column as BINARY, so every re-apply emits a spurious `SET COLLATE`. Fix it on two composable fronts: (A) the differ emits an explicit resolved `COLLATE` for added columns, and (B) the execution-layer ADD COLUMN path honors `default_collation` (closing the direct-ALTER CREATE-vs-ADD inconsistency). RENAME COLUMN is explicitly OUT of scope for B (it is a derived-DDL path and must stay BINARY).
files: packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-isolation/src/isolation-module.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus/test/logic/43.1-default-collation.sqllogic
----

## Confirmed bug (regression from `default-collation-pragma`, now landed)

`default-collation-pragma` made the declarative differ resolve an omitted `COLLATE` on the
**declared** side via the live `default_collation` (so a fresh whole-table `apply` matches direct
DDL and re-applies idempotently — see `extractDeclaredCollation` in `schema-differ.ts:1374`). But
the **ALTER TABLE ADD COLUMN** path was left resolving an omitted `COLLATE` to fixed `BINARY`.
These two now disagree, so an `apply` that needs to *add* a column to an existing table is
non-idempotent.

Verified in the codebase (all line numbers current at fix time):

- `computeTableAlterDiff` emits added columns via the raw `columnDefToString(col)` with **no**
  `COLLATE` resolution — `schema-differ.ts:1162`. `defaultCollation` is already threaded into this
  function (`schema-differ.ts:1141`), so the value is in hand.
- The three ADD COLUMN execution sites resolve an omitted `COLLATE` via
  `columnDefToSchema(def, defaultNotNull)` — i.e. the `defaultCollation` arg defaults to `'BINARY'`
  (`table.ts:240`, `resolveDefaultCollation` at `table.ts:223`):
  - memory: `vtab/memory/layer/manager.ts` `addColumn` (~`:1421`)
  - store:  `quereus-store/src/common/store-module.ts` `addColumn` case (~`:697`)
  - isolation: `quereus-isolation/src/isolation-module.ts` `deriveAddColumnBackfill` (~`:888`)
- The CREATE path DOES honor the default (`manager.ts` `createTable` → `buildTableSchemaFromAST`
  passes the live `default_collation`), which is why the whole-table-create path stays idempotent —
  only ADD COLUMN drifts.

### Repro (from the originating review)

```
db.setOption('default_collation', 'nocase');
await db.exec('create table t (id integer primary key, name text)');
await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT, extra TEXT } }');
await db.exec('apply schema main');        // adds column `extra`
// → catalog `extra.collation === 'BINARY'`  (ADD COLUMN ignores the default)
// re-diff under the same nocase default → tablesToAlter contains a spurious
//   ALTER TABLE t ALTER COLUMN extra SET COLLATE NOCASE  on every apply.
```

## Decision: implement BOTH A and B (they are composable and each carries its own merit)

**A — differ emits explicit resolved COLLATE for added columns.** In `computeTableAlterDiff`'s
`columnsToAdd` loop (`schema-differ.ts:1159-1164`): for a column with **no** explicit `COLLATE`
whose `resolveDefaultCollation(inferType(col.dataType), defaultCollation) !== 'BINARY'`, emit the
ADD COLUMN DDL with an explicit resolved `COLLATE`. Clone the `ColumnDef`, append a
`{ type: 'collate', collation: resolved }` constraint, then `columnDefToString`. Do **not** mutate
the declared AST. This:
  - restores `apply` idempotency at the emit layer (explicit COLLATE wins regardless of B),
  - makes `diff schema` output **self-contained / portable** — a migration emitted under a
    `nocase` default still lands NOCASE when executed under a BINARY session (B alone would not
    guarantee this, since the raw `ADD COLUMN extra TEXT` would re-resolve to the *executing*
    session's default),
  - upholds the invariant `default-collation-pragma` established — *emitted DDL always carries an
    explicit non-BINARY `COLLATE`* — which the differ's ADD COLUMN emission currently violates.

The reuse: a `collate` constraint shape already round-trips through `columnDefToString`; mirror the
spelling `buildConstraintsFromColumn` uses (`alter-table.ts:1489`): only append when
`col.collation !== 'BINARY'`.

**B — execution-layer ADD COLUMN honors `default_collation`.** `ALTER TABLE t ADD COLUMN c text`
is user-authored DDL too; under `default_collation = nocase` a CREATE-d text column becomes NOCASE
while an ADD-COLUMN-ed one stays BINARY — the original consistency footgun. Thread the live
session `default_collation` into the **three ADD COLUMN sites** via the shared
`resolveDefaultCollation` helper (it already falls non-text types back to BINARY, so a non-text ADD
COLUMN under a non-BINARY default is correct automatically):
  - memory `addColumn`: `columnDefToSchema(columnDefAst, defaultNotNull, db.options.getStringOption('default_collation'))`
  - store `addColumn`:  same, threading from `db.options.getStringOption('default_collation')`
  - isolation `deriveAddColumnBackfill`: thread the option for symmetry. **Note:** this site only
    reads `.notNull` / `.name` off the resulting schema (it does not persist the collation — the
    underlying memory/store table is what materializes the real column), so threading is harmless
    and not strictly required for correctness. Thread it anyway so the shared call signature does
    not drift and a future reader of the collation here is correct.

Store round-trip: the store persists column DDL via `generateTableDDL`, which already emits an
explicit `COLLATE` for any non-BINARY collation (`alter-table.ts:1204` is the AST-emit twin; the
generator does the same) — so a non-BINARY ADD COLUMN reopens stably. No extra work needed there.

### CRITICAL CORRECTION to the originating ticket: RENAME COLUMN is OUT of scope for B

The fix ticket listed `renameColumn` (memory + store) as a B call site to thread. **Do not thread
`default_collation` into the renameColumn `columnDefToSchema` calls.** Verified why:

- `runRenameColumn` builds `newColumnDef` from the *existing* column schema via
  `buildConstraintsFromColumn` (`alter-table.ts:1476`), which appends an explicit
  `{ type: 'collate', collation: col.collation }` constraint **only when** `col.collation !==
  'BINARY'` (`alter-table.ts:1489`).
- So a renamed **NOCASE** column already carries an explicit `COLLATE NOCASE` in its AST →
  `columnDefToSchema` honors it regardless of the session default → collation preserved.
- A renamed **BINARY** column carries **no** `COLLATE` → it genuinely *is* BINARY. If we threaded a
  non-BINARY session default here, `columnDefToSchema` would resolve the omitted COLLATE to NOCASE
  and silently **flip an existing BINARY column to NOCASE on rename** — a regression.

RENAME COLUMN is a *derived-DDL* path (its AST is reconstructed from the live schema), analogous to
the `importTable` rehydrate path that deliberately passes `'BINARY'`. An omitted COLLATE there
means "this column is BINARY", not "author left it to the default". Leave both renameColumn sites
resolving to `'BINARY'`.

## Composition check (A + B together)

- Differ emits explicit `ADD COLUMN extra TEXT COLLATE NOCASE` (A); the execution layer already
  honors explicit COLLATE → lands NOCASE. B's omitted-COLLATE fallback is not exercised on the
  differ path, so A and B do not double-apply or conflict.
- Direct user `ALTER TABLE t ADD COLUMN c TEXT` (no COLLATE) under a `nocase` default → B resolves
  it to NOCASE, matching a CREATE-d column.
- Existing suites run under the default `default_collation = BINARY`, so `resolveDefaultCollation`
  returns BINARY and behavior is byte-for-byte unchanged. Only tests that set a non-BINARY default
  *and* add a column see the new (correct) behavior.

## Tests to add

declarative-equivalence (`packages/quereus/test/declarative-equivalence.spec.ts`, in the existing
`describe('declarative-equivalence: default_collation')` block — it already has a `diffOf(db)`
helper that threads the live default):
  - **The failing case:** an `apply` that ADDs a `text` column under `default_collation='nocase'`
    must re-diff to empty `tablesToAlter` (mirror the repro above). Also assert the added column's
    catalog `collation === 'NOCASE'`.
  - A non-text added column (e.g. `extra INTEGER`) under `nocase` re-diffs empty AND lands
    `collation === 'BINARY'` (the `resolveDefaultCollation` type-gate).
  - **RENAME-COLUMN guard (regression for the correction above):** under `default_collation='nocase'`,
    create a table with a BINARY text column, RENAME it, and assert its `collation` is still
    `'BINARY'` (the rename must NOT pick up the session default). Pair with a renamed *explicit*
    NOCASE column asserting it stays `'NOCASE'`.

sqllogic (`packages/quereus/test/logic/43.1-default-collation.sqllogic` — co-locate with the
existing default_collation cases; this file is also exercised by `yarn test:store`):
  - `set default_collation = nocase; ... alter table t add column name text;` then assert NOCASE
    comparison semantics on `name` (e.g. an equality / order that only holds under NOCASE), and a
    non-text add column staying BINARY. Keep it small — one positive (text→NOCASE) and one negative
    (non-text→BINARY). Running under `test:store` covers the store `addColumn` path and a reopen
    round-trip implicitly (the store persists + rehydrates DDL between statements).

## Docs

`default-collation-pragma` already documented the create/apply parity invariant. Update
`docs/schema.md` (or wherever the pragma's "emitted DDL always carries an explicit non-BINARY
COLLATE" invariant lives) to note that ADD COLUMN now honors `default_collation` and that RENAME
COLUMN deliberately does not (it preserves the existing column's collation). Keep it to the
existing section — no new doc file.

## TODO

### Phase 1 — Approach A (differ emit; smallest, restores idempotency on its own)
- In `computeTableAlterDiff`'s `columnsToAdd` loop (`schema-differ.ts:1159-1164`), for a column
  with no explicit `collate` constraint, compute
  `resolveDefaultCollation(inferType(col.dataType), defaultCollation)`; if `!== 'BINARY'`, clone the
  `ColumnDef`, append `{ type: 'collate', collation: resolved }`, and `columnDefToString` the clone.
  Otherwise keep the existing raw emission. (`resolveDefaultCollation` and `inferType` are already
  imported in this file.)
- Verify no declared AST mutation (clone the `constraints` array, not push onto it in place).

### Phase 2 — Approach B (execution layer honors default_collation on ADD COLUMN only)
- memory `vtab/memory/layer/manager.ts` `addColumn`: pass
  `db.options.getStringOption('default_collation')` as the 3rd arg of `columnDefToSchema`.
- store `quereus-store/src/common/store-module.ts` `addColumn` case: same.
- isolation `quereus-isolation/src/isolation-module.ts` `deriveAddColumnBackfill`: same (symmetry;
  harmless — reads only notNull/name).
- **Leave both `renameColumn` sites resolving to `'BINARY'`** (see CRITICAL CORRECTION). Do not
  thread the option there.

### Phase 3 — Tests + docs
- Add the declarative-equivalence cases (incl. the RENAME-COLUMN guard).
- Add the `43.1-default-collation.sqllogic` ADD COLUMN cases.
- Update the schema doc note.

### Phase 4 — Validate
- `yarn workspace @quereus/quereus run build` then `yarn test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`
  (memory-backed; covers differ + memory + isolation).
- `yarn lint` in `packages/quereus` (single-quote globs on Windows).
- `yarn test:store 2>&1 | tee /tmp/ts.log; tail -n 80 /tmp/ts.log` to exercise the store
  `addColumn` path + reopen round-trip. If `test:store` wall-clock approaches the 10-min idle limit,
  stream it; if it routinely exceeds ~10 min it is not agent-runnable — document the deferral and
  leave it to CI.
