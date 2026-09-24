description: Adding a rule like "this column must always be positive" to a table that already holds rows breaking that rule is accepted without complaint — and afterwards those rows silently vanish from query results that look for them, because the engine believes the rule.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/add-constraint.ts        # THE site: runAddConstraintViaModule / runAddCheckEngineSide — neither validates existing rows
  - packages/quereus/src/schema/constraint-builder.ts          # validateChecksOverExistingRows (~377) — the scan to reuse; also needs exporting from src/index.ts
  - packages/quereus/src/index.ts                              # ~220 — export list that already carries validateForeignKeyOverExistingRows
  - packages/quereus/src/runtime/emit/alter-table.ts           # validateBackfillAgainstChecks (~1114) — second arm: same scan, same new./old. blind spot
  - packages/quereus/src/planner/analysis/check-extraction.ts  # isRowInvariantCheck / walkConjunction (~130-210) — the exact predicate set the validation must cover
  - packages/quereus/src/vtab/capabilities.ts                  # permitsGrandfatheredCheckViolators (~85) — the opt-out the new rejection must honor
  - packages/quereus/src/core/derived-row-validator.ts         # referencesRowImageQualifier (~132) — existing new./old. detector, currently unexported
  - packages/quereus/src/vtab/memory/layer/manager.ts          # addCheckConstraint (~3070) — comment claiming schema-only is precedent; trim
  - packages/quereus-store/src/common/store-module-alter.ts    # alterAddConstraint check branch (~550-610) — same comment; trim
  - packages/quereus/test/alter-table-conformance.spec.ts      # memory leg of the generalized tightening test
  - packages/quereus-store/test/alter-table-conformance.spec.ts      # store leg
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts  # isolation-wrapped-memory leg
  - docs/sql-alter.md                                          # lines ~131 and ~142 state the old behavior as the contract
  - docs/design-isolation-challenges.md                        # § 6 "Row-validating DDL judges the issuer's rows" list omits CHECK
  - docs/optimizer-fd.md                                       # ~264 cites "ALTER ADD CHECK backfill validation" as covering pre-existing rows
  - docs/sync-schema.md                                        # ~273 table row citing this ticket
  - packages/quereus-sync/src/sync/store-adapter.ts            # ~697 comment citing this ticket
  - packages/quereus-sync/test/sync/schema-alter-replication.spec.ts  # ~738 comment citing this ticket
difficulty: hard
repro: verified

# `alter table … add constraint … check` must reject rows that already violate it

## What happens today

```sql
create table t (id integer primary key, n integer null);
insert into t values (1, -5), (2, 7);
alter table t add constraint c check (n > 0);   -- accepted
```

Both bundled backends accept it (verified: memory and store; also isolation-wrapped memory). The sibling forms of the same statement reject — `add constraint … unique` raises `UNIQUE constraint failed`, `add constraint … foreign key` raises `FOREIGN KEY constraint failed` — so the CHECK arm is one out of step, not a uniform posture.

## Why this is a wrong-result bug, not just untidy data

The stored row does not merely sit there contradicting the schema — **it disappears from queries that ask for it.** Verified on both backends, immediately after the `alter` above:

| query | before the alter | after the alter | rows actually stored |
|---|---|---|---|
| `select id from t where n <= 0` | `1` | *(empty)* | `1` is still there |
| `select count(*) from t where n <= 0` | `1` | `0` | — |
| `select id, n from t` | both rows | both rows | both rows |

The mechanism is deliberate and documented: the optimizer treats a declared CHECK as a proven fact about every stored row and lifts it into domain constraints, so `rule-filter-contradiction` folds `where n <= 0` to nothing. `docs/optimizer-fd.md` § Row-invariant gate states the soundness argument for that lift in so many words — "ALTER ADD CHECK backfill validation plus the `permitsGrandfatheredCheckViolators` consumer gate cover the pre-existing-rows path". The backfill validation it names exists only on the `ADD COLUMN` path (`validateBackfillAgainstChecks`). On the `ADD CONSTRAINT` path there is nothing, so the premise is simply false and the fold is unsound.

That also makes the fix's shape non-negotiable in one respect: **whatever the validation covers must be at least what the optimizer lifts.** The two must not drift, in either direction — validate less and rows vanish from results; validate more and legal statements start failing.

## Root cause and where to fix it

`ALTER TABLE … ADD CONSTRAINT` validates nothing itself and leaves existing-row validation to each storage module: the UNIQUE and FOREIGN KEY arms of the memory and store modules each run a scan, the CHECK arms of both are schema-only. Two modules, one omission each — and any third-party module inherits the same trap.

Fix it once, engine-side, in `packages/quereus/src/runtime/emit/add-constraint.ts`, **before** the module is dispatched to, rather than adding a third copy of the scan to each backend:

- `runAddConstraintViaModule` — the module-routed arm (memory, store, isolation, and any module with an `alterTable` hook).
- `runAddCheckEngineSide` — the catalog-only fallback for modules with no `alterTable` hook.

Pre-dispatch placement is what makes it cheap and safe: nothing has been mutated yet, so a rejection needs no unwind, and the catalog still holds the pre-ALTER schema — which matters, see the fold trap below. The existing FK-collation and UNIQUE-name guards in the same function are already placed there for the same reason and read as precedent.

The scan itself already exists: `validateChecksOverExistingRows` (`schema/constraint-builder.ts`), used today by the maintained-table path. It runs `select 1 from <t> where not (<expr>) limit 1` per CHECK, which gives the NULL-passes rule for free. It is not in `src/index.ts`'s export list yet; the store package would need it if any of this lands module-side, and exporting it is harmless either way.

**No `EffectiveRowSource` plumbing is needed.** Verified on all three legs: a plain `db.prepare` scan issued mid-statement already sees the issuing transaction's uncommitted rows — the memory layer chain, the store's buffered writes, and the isolation layer's overlay all serve them through the ordinary read path. A staged-but-uncommitted violating row is therefore caught. This matches how the FK arm and `validateNotNullBackfill` already work, and it matches the settled posture that a *foreign* connection's overlay is not consulted (`docs/design-isolation-challenges.md` § 6; the `set not null` leg does the same).

### Four things that will bite

**1. The self-fold trap.** If the CHECK is declared anywhere the optimizer can see it when the validation scan is planned, `rule-filter-contradiction` folds the scan's own `where not (<expr>)` to nothing and the validation passes vacuously — it trusts the very thing it is testing. Pre-dispatch placement avoids it (the catalog still carries the old schema, the module has not updated its cached one). `runAddColumn` documents the identical discipline at `alter-table.ts` ~910 and is worth reading first. Pin it with a test that would fail if someone later moves the call after the catalog swap.

**2. `new.` / `old.` row-image qualifiers.** `check (new.n > 0)` is legal and accepted today (`docs/sql-ddl.md` § 2.6), and a naive scan of it fails to plan — verified: `new.n isn't a column`. Turning a previously-accepted ALTER into that error would be its own regression. The three cases differ:

- `new.<col>` alone — a plain statement about the stored row, and the optimizer *does* lift it (`columnIndexFromExpr` tolerates the qualifier). It must be validated, so the qualifier has to be resolved to the row's own column before the scan. This is the case the live repro used.
- `old.<col>` — a transition constraint about the previous row image. It says nothing about a row sitting still, cannot be judged from stored rows, and the optimizer already refuses to lift any conjunct containing one.
- a mix — `check ((old.id is null or id = old.id) and status in ('a','i'))`. The optimizer screens `old.` **per top-level AND-conjunct** and still lifts the `status` domain, so skipping the whole check here would leave exactly the hole this ticket closes. Mirror that: drop the `old.`-bearing conjuncts, validate the rest.

`referencesRowImageQualifier` (`core/derived-row-validator.ts`, currently unexported) and `containsOldRowImageRef` (`check-extraction.ts`) are the two existing detectors; the conjunct walk to mirror is `walkConjunction` in the same file.

**3. The `ADD COLUMN` sibling has the same blind spot.** Verified: `alter table t add column v integer default -1 check (new.v > 0)` fails with `new.v isn't a column` instead of a proper constraint rejection, because `validateBackfillAgainstChecks` renders the expression the same naive way. Same defect, same resolution — which is the argument for putting the qualifier handling in one shared helper next to `validateChecksOverExistingRows` and routing both scans through it. `planner/building/schema-authored-context.ts` already warns, in a comment, that these two scan sites are two spellings of one rule and that a third must be given a shared helper rather than a fourth copy. This ticket is that third site; honor the instruction.

**4. `permitsGrandfatheredCheckViolators` is an opt-out, and the new rejection must honor it.** A module declaring that capability is promising exactly the behavior this ticket removes — "ADD CHECK against a non-conforming table succeeds and grandfathers the violator" — and in exchange the optimizer suppresses the CHECK lift for its tables, so nothing goes wrong. Skip the validation for such a module, the way `delegatesNotNullBackfill` gates `validateNotNullBackfill`. No shipped module sets it today (only test modules do), so this costs nothing now and keeps the two halves of the contract consistent. The operation mask deserves the same defensive filter the maintained-table path uses (`operations & (INSERT | UPDATE)`), even though the `ADD CONSTRAINT` grammar cannot currently produce anything else — the parser rejects `on delete` there.

## The generalized test is the more valuable half

This arm fell out of a set of siblings that otherwise agree, and nothing was watching the set. Add one table-driven case per **tightening** form, each seeded with a violating row and each asserting a rejection (and that the table is unchanged afterwards):

- `alter column … set not null` against a row holding NULL
- `add constraint … unique` against duplicate rows
- `add constraint … check` against a violating row
- `add constraint … foreign key` against an orphan row
- `create unique index` against duplicate rows
- `add column … not null` with no usable default against a non-empty table

Run the table on all three conformance legs — `packages/quereus/test/` (memory), `packages/quereus-store/test/` (store), `packages/quereus-isolation/test/` (isolation-wrapped memory). The three `alter-table-conformance.spec.ts` files are deliberate per-package copies of one harness (each header explains why a shared module cannot serve all three); follow that shape rather than fighting it. A new tightening form added later without a scan then fails a test instead of shipping.

Worth adding alongside, in the memory leg: the wrong-result probe from the table above — add a CHECK to a conforming table, then assert that a query contradicting it still agrees with `select *`. That is the property the optimizer's lift depends on, stated directly.

## Expected behavior

- Adding a CHECK to a table holding a violating row fails with `CONSTRAINT` and leaves the table exactly as it was — no constraint in the catalog, none in the module's cached schema, nothing persisted.
- Adding one to a table whose rows all satisfy it succeeds, as today.
- Rows the issuing transaction has inserted but not yet committed count as present; a foreign connection's uncommitted rows do not (matching every other row-validating ALTER).
- `check (new.<col> …)` is validated like the unqualified spelling; a conjunct referencing `old.<col>` is not validated (it cannot be) and does not block the statement.
- A module declaring `permitsGrandfatheredCheckViolators` keeps today's accepting behavior.

## Knock-on effects to expect

- **Declarative apply.** `apply schema` realizes an edited CHECK body as DROP + ADD CONSTRAINT, and `docs/sql-alter.md` ~142 currently documents that re-add as forward-enforcing only. After this lands, tightening a CHECK declaratively against violating rows fails — and, as that same paragraph warns, the DROP has already happened by then on the memory backend. Say so in the doc rather than leaving the old sentence.
- **Existing tests.** Some sqllogic cases add a CHECK to a populated table; any whose rows violate the new predicate will start failing and need their seed data or their expectation updated. Run the full suite, including `yarn test:store`.
- **Conformance matrix ADD CHECK arms.** The existing honored arms in all three legs must seed conforming rows, or they will start rejecting.
- **The sync layer needs no change** — `validatesExistingRows` in `packages/quereus-sync/src/sync/store-adapter.ts` already classifies a CHECK add as row-validating and applies it after a batch's rows. Only its comment (and the two other places citing this ticket by slug) needs trimming.

## TODO

- Add the shared existing-row CHECK scan helper next to `validateChecksOverExistingRows` in `schema/constraint-builder.ts`: resolve `new.<col>` qualifiers against the scanned table, screen out `old.`-bearing top-level AND-conjuncts, filter by operation mask. Export what the other packages need from `src/index.ts`.
- Route `validateBackfillAgainstChecks` (`runtime/emit/alter-table.ts`) through the same helper so the ADD COLUMN path stops erroring on `new.`-qualified inline CHECKs.
- Call the validation pre-dispatch in `runAddConstraintViaModule` and in `runAddCheckEngineSide` (`runtime/emit/add-constraint.ts`), gated on `permitsGrandfatheredCheckViolators`, with a comment stating why the call must stay ahead of the catalog swap.
- Trim the now-wrong "schema-only, matching the engine's prior in-emitter behavior" comments in `MemoryTableManager.addCheckConstraint` and the store's `alterAddConstraint` CHECK branch; say where validation now happens instead.
- Add the table-driven tightening-rejects-violating-rows suite to all three `alter-table-conformance.spec.ts` legs, plus the memory-leg wrong-result probe.
- Add a test that fails if the validation is ever moved after the constraint is declared (the self-fold trap).
- Update `docs/sql-alter.md` (~131, ~142), `docs/design-isolation-challenges.md` § 6 row-validating-DDL list, `docs/optimizer-fd.md` ~264, `docs/sync-schema.md` ~273.
- Trim the two comments citing this ticket by slug: `packages/quereus-sync/src/sync/store-adapter.ts` ~697 and `packages/quereus-sync/test/sync/schema-alter-replication.spec.ts` ~738.
- Run `yarn lint`, `yarn test`, and `yarn test:store`; fix whatever seed data the new rejection breaks.
