description: Store module SET COLLATE does not re-key / re-validate existing rows — memory/store divergence on ALTER COLUMN SET COLLATE
files:
  - packages/quereus-store/src/common/store-module.ts        # alterColumn setCollation arm (~1047) — currently schema-only
  - packages/quereus/src/vtab/memory/layer/manager.ts        # memory reference impl: re-sort + uniqueness re-validation + rollback (~1635)
  - packages/quereus/src/vtab/memory/layer/base.ts           # rebuildAllSecondaryIndexesStrict / rebuildPrimaryTreeStrict
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic # memory-only; would become cross-module if store re-validates
  - packages/quereus/test/logic.spec.ts                      # MEMORY_ONLY_FILES (drop 41.7.1 once store parity lands)
----

# Store `ALTER COLUMN … SET COLLATE` — existing-row re-key / re-validation

## Background

`10.4-alter-column-set-collate` shipped `ALTER TABLE t ALTER COLUMN c SET COLLATE n`.
The **memory** module treats collation as semantic: on the ALTER it re-keys/re-sorts
every PK / UNIQUE / index that orders by the column and **re-validates uniqueness
under the new collation** — a value set unique under `BINARY` that collides under
`NOCASE` is rejected with `CONSTRAINT` and the ALTER is rolled back.

The **store** (LevelDB) module applies `SET COLLATE` as a **schema-only** change.
Its physical key encoding uses a fixed table-level collation (`encodeOptions`), so it
does not physically re-key the data store or re-validate existing-row uniqueness at
ALTER time. Query-layer `=` / `ORDER BY` / `table_info().collation` do pick up the new
collation from the column schema (verified by `41.7` passing under `yarn test:store`),
but the existing-row uniqueness re-validation is skipped.

## The divergence (why this is tracked)

Given identical SQL, the two modules disagree:

```
create table t (id integer primary key, email text unique);
insert into t values (1, 'a@x'), (2, 'A@x');   -- distinct under BINARY
alter table t alter column email set collate nocase;
```

- **memory:** ALTER rejected with `UNIQUE constraint failed`; table unchanged.
- **store:**  ALTER succeeds. The table now declares `email` as `NOCASE UNIQUE` yet
  physically holds two rows that collide under `NOCASE` — a silent integrity gap.
  (New inserts may then be checked under the declared collation while the
  pre-existing colliding rows are tolerated.)

This is a deliberate, *documented* limitation today (see the `41.7.1` header, the
store-module comment at the `setCollation` arm, and the store-module note in
`docs/sql.md` §2.7). `41.7.1-alter-column-collate-unique.sqllogic` is in
`MEMORY_ONLY_FILES` precisely because of it. It is filed here as a **future concern**,
not active blocking work: closing it requires store physical re-keying design
(per-column collation in the key encoder, or an ALTER-time full re-encode + dup scan).

## Desired outcome

Decide and implement store parity for `SET COLLATE` on a column that participates in a
PK / UNIQUE / index:

- **Option A (validate-only):** at ALTER time, full-scan existing rows and reject with
  `CONSTRAINT` when the new collation introduces a duplicate (matching memory's
  rejection semantics) — even if the physical key bytes are not re-encoded. Cheapest
  path to behavioral parity for the integrity guarantee; ORDER-BY/`=` already work.
- **Option B (full re-key):** re-encode physical keys under a per-column collation so
  the store's physical order also reflects the new collation (needed only if any code
  path relies on the store's physical order matching the declared collation).

Option A is likely sufficient given the query layer already sorts/compares from the
column schema. Once store parity lands, remove `41.7.1` from `MEMORY_ONLY_FILES` and
let it run cross-module (or split the now-shared assertions into `41.7`).

## Acceptance

- A store table rejects `SET COLLATE` that would introduce an existing-row PK/UNIQUE
  collision (or the chosen option's documented behavior is implemented + tested under
  `yarn test:store`).
- `docs/sql.md` §2.7 store-module note updated to reflect the new behavior.
