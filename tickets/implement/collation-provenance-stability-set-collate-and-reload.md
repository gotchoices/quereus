description: Make a column's comparison-collation lattice rank a function of the current catalog schema, not of schema history. SET COLLATE must mark the collation explicit (rank 2) uniformly across the memory and store modules, regardless of the column's creation history; the session-default→declared rank upgrade on DDL reload is pinned as intended (option (a)) and documented rather than persisted.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts            # alterColumn ~1708 setCollation branch — set collationExplicit; fix early-return guard
  - packages/quereus-store/src/common/store-module.ts            # alterColumn ~1361 setCollation branch — same fix
  - packages/quereus/src/schema/table.ts                         # columnDefToSchema (reference: the ONLY other site that sets collationExplicit)
  - packages/quereus/src/schema/column.ts                        # ColumnSchema.collationExplicit doc comment
  - packages/quereus/src/planner/type-utils.ts                   # columnSchemaToScalarType — collationExplicit → 'declared'|'default' (no change; consumer)
  - packages/quereus/src/planner/analysis/comparison-collation.ts # the lattice (no change; consumer)
  - packages/quereus/src/schema/ddl-generator.ts                 # generateColumnDDL ~460 — elides BINARY regardless of collationExplicit (explains the reload story)
  - packages/quereus/src/schema/schema-differ.ts                 # emits SET COLLATE ~2313 (no change; inherits the fix via the apply path)
  - packages/quereus/test/logic/06.4.4-comparison-collation-precedence.sqllogic  # add a SET COLLATE provenance section (runs memory + store)
  - packages/quereus/test/logic/41.7-alter-column-collate.sqllogic               # existing SET COLLATE semantics (cross-module) — regression sanity
  - docs/types.md                                                # § Comparison collation resolution — document SET COLLATE = declared, default provenance session-transient
  - docs/sql.md                                                  # § 9.2.4 default_collation — note the reload provenance upgrade is intended/fail-louder
difficulty: medium
----

# Collation provenance must be stable across SET COLLATE and schema reload

## Problem (reproduced)

The provenance-ranked comparison lattice
(`planner/analysis/comparison-collation.ts`) gives a column's collation a rank
derived from `ColumnSchema.collationExplicit`: an explicit `COLLATE` clause ⇒
rank 2 (`'declared'`), a defaulted collation ⇒ rank 1 (`'default'`). The two
ranks have observably different semantics (rank-2 same-rank conflicts error at
prepare time; rank-1 conflicts resolve to BINARY silently and lose silently to
any rank-2 contribution).

`collationExplicit` is set in exactly one place —
`columnDefToSchema` (`schema/table.ts:288-295`, the CREATE-time `COLLATE`
constraint). `ALTER COLUMN ... SET COLLATE` does **not** set it: both
`alterColumn` sites build `newCol = { ...oldCol, collation: normalized }`
(memory `manager.ts:1713`, store `store-module.ts:1376`), so the flag is
inherited from the column's creation history rather than reflecting the SET
COLLATE the user just issued.

Reproduced (memory module; the repro file was removed after confirming):

```sql
create table r1 (id integer primary key, v text, r text collate rtrim);
insert into r1 values (1, 'xx', 'xx');
alter table r1 alter column v set collate nocase;
select id from r1 where v = r;          -- returns [{"id":1}]  ← BUG: rtrim wins silently

create table r2 (id integer primary key, v text collate binary, r text collate rtrim);
insert into r2 values (1, 'xx', 'xx');
alter table r2 alter column v set collate nocase;
select id from r2 where v = r;          -- error: ambiguous collation
```

Same `SET COLLATE NOCASE` statement, divergent semantics: rank 1 when `v` was
created without a `COLLATE` clause (silently loses to declared RTRIM), rank 2
when `v` happened to be created with one (rank-2 conflict ⇒ error).

## Decision (read before implementing)

**SET COLLATE marks the collation explicit (rank 2), uniformly across both
modules, including `SET COLLATE binary`.** A `SET COLLATE` is a user
declaration with exactly the standing of a CREATE-time `COLLATE` clause. This
makes the rank a function of the current catalog column, not its history.

**The reload story is option (a): the session-default→declared rank upgrade on
DDL persistence/reload is intended and is documented, not persisted.** Rationale
— `'default'` provenance is deliberately *session-transient*: the persisted
catalog is fully explicit (docs/sql.md § 9.2.4 already commits to "the catalog
always stores the concrete, resolved collation, and persisted DDL always emits
an explicit `COLLATE` for any non-`BINARY` collation"). A column that got NOCASE
from session `default_collation` therefore reloads through `columnDefToSchema`
with `collationExplicit: true` (rank 2). Every such reload flip is in the
**fail-louder** direction only (a silent BINARY/declared resolution becomes a
prepare-time ambiguous-collation error — never silently different results), so
the upgrade is defensible and needs no catalog/DDL representation change or
migration. Option (b) (persisting the explicit/implicit distinction) is **not**
taken.

`SET COLLATE binary` being rank 2 introduces **no new reload divergence**:
`generateColumnDDL` (`ddl-generator.ts:460`) elides BINARY collations regardless
of `collationExplicit`, so a CREATE-time `c text collate binary` column *already*
round-trips to rank 1 on reload. SET COLLATE binary inherits that identical,
pre-existing behavior — rank 2 in-session, rank 1 after a store reopen — so it
stays consistent with the create path. No reopen-preserves-rank test is
required (we deliberately accept the change across the persistence boundary).

The schema differ needs **no change**: it emits `SET COLLATE <name>` for
declared-collation diffs (`schema-differ.ts:2313`), and once `alterColumn`
marks the result explicit, the apply path produces rank 2 for free. The store's
`reconcilePkCollations` round-trip (store default applied in-session with
`'default'` provenance, persisted as explicit `COLLATE`, reloaded `'declared'`)
is the same fail-louder upgrade and is likewise accepted under option (a).

## Implementation notes / gotchas

**The early-return idempotence guard must become provenance-aware.** Both
`alterColumn` sites short-circuit when the requested collation name already
matches the current one:

```ts
if (normalized === (oldCol.collation || 'BINARY')) {
    return; // already in desired state — no re-sort needed
}
```

A bare name-equality check would **drop** the explicitness upgrade in two real
cases:
- `set collate binary` on a defaulted-BINARY column (name matches 'BINARY',
  but the column is not yet explicit — the user's rank-2 BINARY demand is lost).
- `set collate nocase` on a column whose NOCASE came from
  `default_collation='nocase'` (name matches 'NOCASE', `collationExplicit`
  undefined — must flip to rank 2).

Change the short-circuit to fire **only when the name matches AND the column is
already `collationExplicit`**. When the name matches but the column is not yet
explicit, perform a **metadata-only** schema update that sets
`collationExplicit: true`, re-registers the schema, and persists DDL, but does
**not** run the physical re-sort / re-key / UNIQUE re-validation (the collation
*bytes* are unchanged, so keep `collationChanged` false for that branch — no
structural work, no `rekeyRows`, no `validateUniqueOverExistingRows`). When the
name differs, take the existing full path **plus** set `collationExplicit: true`
on `newCol`.

**Both modules must agree** — the divergence is the whole point of the ticket.
Apply the identical guard + flag logic to memory `manager.ts` and store
`store-module.ts`.

**Persistence of the BINARY metadata flip is harmless but a no-op on reload:**
the DDL for an explicit-BINARY column is byte-identical to a defaulted-BINARY
one (BINARY elided), so `saveTableDDL` writes the same bytes and the reload
gives rank 1 again — exactly as for a CREATE-time `collate binary`. In-session,
the re-registered schema carries the flag, which is what the lattice consumes.

## Tests

Pin the corrected semantics (all should run under BOTH `yarn test` and
`yarn test:store`, since SET COLLATE re-registers the column schema on both
modules — see the 41.7 header):

- Extend `06.4.4-comparison-collation-precedence.sqllogic` with a SET COLLATE
  provenance section:
  - `set collate nocase` on a plain (defaulted) column, then compare against a
    declared RTRIM column ⇒ **ambiguous-collation error** (the repro's `r1`
    case, now fixed — was silently rtrim).
  - `set collate nocase` on a plain column, then compare against a declared
    BINARY column ⇒ **ambiguous-collation error** (rank-2 vs rank-2).
  - `set collate nocase` on a plain column, then compare against a plain
    (defaulted-BINARY) column ⇒ resolves NOCASE, returns the case-folded match
    (rank-2 wins over no-contribution).
  - history-independence: the *same* `set collate nocase` statement on a column
    created **with** `collate binary` and on one created **without** any
    `COLLATE` both yield the identical rank-2 result (one assertion each, same
    comparison).
  - `set collate binary` on a defaulted-BINARY column then conflict against a
    declared NOCASE column ⇒ **ambiguous-collation error** in-session (pins the
    "consistency argues yes" decision; no reopen assertion).
- Sanity-check that `41.7-alter-column-collate.sqllogic` still passes unchanged
  (its query-layer `=`/ORDER BY/table_info assertions are provenance-blind and
  must not regress).

## TODO

- [ ] Memory module: in `manager.ts` `alterColumn` setCollation branch, set
      `collationExplicit: true` on the changed-name path; replace the
      name-only early-return with a provenance-aware guard + metadata-only
      flag-flip branch (no re-sort when only the flag changes).
- [ ] Store module: apply the identical change to `store-module.ts`
      `alterColumn` setCollation branch (flag on changed-name path; metadata-
      only flip branch that skips `rekeyRows` / `validateUniqueOverExistingRows`).
- [ ] Extend `06.4.4-comparison-collation-precedence.sqllogic` with the SET
      COLLATE provenance section above.
- [ ] docs/types.md § Comparison collation resolution: document that `SET
      COLLATE` (incl. `binary`) yields rank-2 `'declared'` like a CREATE-time
      `COLLATE`, and that rank-1 `'default'` provenance is session-transient —
      it upgrades to `'declared'` across a DDL persistence/reload (fail-louder
      only) because the persisted catalog is fully explicit.
- [ ] docs/sql.md § 9.2.4: add a sentence noting the comparison-collation rank
      may rise from rank-1 (default) to rank-2 (declared) on reopen as an
      intended consequence of "catalog stores the concrete, resolved collation";
      the only effect is stricter (fail-louder) conflict detection.
- [ ] `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- [ ] `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`
- [ ] `yarn test:store 2>&1 | tee /tmp/test-store.log; tail -n 80 /tmp/test-store.log`
      (exercises the store `alterColumn` path the memory run does not).
