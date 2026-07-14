---
description: |
  One conformance test file mixes seven upsert scenarios; six run on any storage backend, but the seventh
  needs a standalone index that some backends deliberately don't support, which makes the whole file fail
  there and hides the six that pass. Split the odd scenario into its own file so the rest stays portable.
files:
  - packages/quereus/test/logic/47.3-upsert-conflict-target-collation.sqllogic  # remove § 6, renumber trailing sections
  - packages/quereus/test/logic/47.3.1-upsert-conflict-index-derived-collation.sqllogic  # NEW — carved-out § 6
difficulty: easy
---

# Split 47.3 § 6 (index-derived UNIQUE collation) into its own `.sqllogic` file

## Context

`47.3-upsert-conflict-target-collation.sqllogic` tests that `ON CONFLICT (cols)` upsert routing matches a
conflict under the *enforcement collation* (NOCASE case-variant, RTRIM trailing-space) rather than by byte
identity. Seven sections (numbered 1–8, but there is no § 3-vs-§ 5 issue here — see the file). All but one
establish their UNIQUE via a **column- or table-level constraint**, which every storage backend supports.

Section 6 is the exception. It establishes UNIQUE via a **standalone `create unique index` whose key
expression carries a per-column `COLLATE`**:

```sql
create table idx_coll (id integer primary key, tag text);
create unique index idx_tag_nc on idx_coll (tag collate nocase);
```

Its subject is specifically: *the enforcement collation is the INDEX's NOCASE, not the column's declared
BINARY* — so proposed `'HELLO'` matches stored `'Hello'` and routes to the `DO UPDATE` arm.

## Why split instead of migrate

The parent plan floated re-expressing § 6 as an inline UNIQUE constraint (or a covering materialized view).
Neither works **honestly** in quereus:

- A table-level `unique (tag collate nocase)` does **not** carry a per-column collation override into the
  schema. `UniqueConstraintSchema.columns` is a list of column *indices* only (see
  `extractUniqueConstraints`, `packages/quereus/src/schema/manager.ts` ~line 1780). For a non-index-derived
  constraint, `uniqueEnforcementCollations` (`packages/quereus/src/schema/unique-enforcement.ts:88`) falls
  back to the **declared column collation**. Column `tag` is BINARY, so the constraint would enforce under
  BINARY and `'HELLO'` would NOT match `'Hello'` — the opposite of what § 6 asserts. That is falsifying the
  test, not migrating it.
- Declaring the column itself `collate nocase` would make the test pass, but then it is no longer "index
  collation overrides the column's BINARY" — it collapses into § 1 (plain column-collation NOCASE UNIQUE),
  which is already covered.
- Covering materialized views are a downstream-backend (lamina) construct; quereus has no equivalent.

So § 6 has no portable inline form. The clean move is to **carve it into its own file**. The bulk of 47.3
(the actual collation-variant upsert-matching subject) then runs on any backend, including backends that
retired standalone `CREATE [UNIQUE] INDEX`; only the genuinely index-dependent scenario lives in a file such
backends skip/pin. Same net coverage, honestly expressed.

## What to do

**Create** `packages/quereus/test/logic/47.3.1-upsert-conflict-index-derived-collation.sqllogic` with exactly
the § 6 scenario, plus a header explaining the carve-out. Suggested content:

```
-- Index-derived UNIQUE enforcement collation via ON CONFLICT upsert.
--
-- Carved out of 47.3-upsert-conflict-target-collation: every other section of
-- 47.3 enforces UNIQUE through a column- or table-level constraint, but this
-- scenario derives its UNIQUE from a standalone `create unique index` whose key
-- expression carries a per-column COLLATE. Backends that retire first-class
-- CREATE [UNIQUE] INDEX cannot run it, so it lives in its own file to keep 47.3's
-- collation-variant upsert-matching subject portable across backends.
--
-- Subject: the enforcement collation is the INDEX's NOCASE, not the column's
-- declared BINARY — so proposed 'HELLO' matches stored 'Hello' and routes to the
-- DO UPDATE arm. Sibling: unique-enforcement-collation.spec.ts covers the same
-- index-derived-collation resolution directly.

create table idx_coll (id integer primary key, tag text);
create unique index idx_tag_nc on idx_coll (tag collate nocase);
insert into idx_coll values (1, 'Hello');

insert into idx_coll values (2, 'HELLO') on conflict (tag) do update set tag = 'seen';
select id, tag from idx_coll order by id;
→ [{"id":1,"tag":"seen"}]

drop table idx_coll;
```

**Edit** `47.3-upsert-conflict-target-collation.sqllogic`:
- Delete the entire § 6 block (the `-- 6. Index-derived UNIQUE ...` banner comment through the
  `drop table idx_coll;`).
- Renumber the trailing banners: § 7 → § 6, § 8 → § 7 (banner comments only; SQL unchanged).
- Add a one-line pointer near the top (alongside the existing 47.4 sibling note) that the index-derived
  collation scenario now lives in `47.3.1-upsert-conflict-index-derived-collation.sqllogic`.

Do **not** add either file to `MEMORY_ONLY_FILES` in `logic.spec.ts` — both must run on memory **and** store.
The store backend supports `create unique index`; NOCASE enforcement still holds there via full-scan
re-validation (the BINARY-only index-seek gate falls back to a scan — see the `canSeekForConstraint` NOTE in
`packages/quereus-isolation/src/isolated-table.ts`).

## Edge cases & interactions

- **Section independence:** each 47.3 section creates and drops its own table, so removing § 6 cannot leak
  state into the renumbered § 6/§ 7 (former § 7/§ 8). Verify the file still ends with all tables dropped.
- **Renumber is comment-only:** banners are `--` comments the harness ignores; a wrong edit that touches SQL
  would change behavior. Keep SQL byte-identical for the surviving sections.
- **Store backend:** run the store path for the new file too — `create unique index` + NOCASE enforcement is
  the interaction most likely to diverge store-vs-memory. Expected: identical pass.
- **File discovery:** the harness `readdirSync`s every `*.sqllogic`; the `47.3.1-` name is picked up
  automatically and sorts between 47.3 and 47.4. No registration needed.
- **Downstream (lamina) is out of this repo:** on landing, lamina drops 47.3 from its known-failures allow
  list (it will start passing there) and pins only `47.3.1-...`. No quereus change models that — just don't
  re-add 47.3 to any local skip list.

## TODO

- Create `packages/quereus/test/logic/47.3.1-upsert-conflict-index-derived-collation.sqllogic` (content above).
- Remove § 6 from `47.3-upsert-conflict-target-collation.sqllogic`; renumber § 7/§ 8 → § 6/§ 7; add sibling pointer.
- `yarn test 2>&1 | tee /tmp/t.log; tail -n 40 /tmp/t.log` — confirm both files pass on memory.
- Spot-check store: `yarn test:store 2>&1 | tee /tmp/ts.log; tail -n 60 /tmp/ts.log` (or grep the two file names) — confirm both pass.
- `yarn lint` (quereus) — no spec call-site drift (no .ts touched, but cheap to confirm).
