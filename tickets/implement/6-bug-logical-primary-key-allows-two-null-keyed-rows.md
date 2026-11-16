description: An application-schema table whose primary key column may be left empty accepts two rows with an empty key when written through its lens, although everywhere else in the engine two empty keys are the same key and the second row is rejected. Make both lens enforcement paths for primary keys follow the key rule.
architecture: docs/lens-constraints.md#set-level-unique-primary-key
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # synthesizeUniqueCountExpr (~1390), collectLensSetLevelConstraints (~1460) — arm 1
  - packages/quereus/src/schema/lens-prover.ts # classifyKeyConstraint (~1561, row-time branch ~1639), findBasisCovering (~2015) — arm 2
  - packages/quereus/src/planner/mutation/capture-correlation.ts # captureKeyEquality — the NULL-safe equality helper to reuse
  - packages/quereus/test/lens-enforcement.spec.ts # describe 'set-level (unique / PK) commit-time at the write boundary' (~748) — regression tests go here
  - docs/lens-constraints.md # § Set-level (`unique`, primary key) commit-time bullet; FD table row "enforced-set-level row-time" (~119)
  - docs/lens-prover.md # `lens.no-backing-index` row (~40) mentions covering structures for "a unique / primary key"
  - docs/schema.md # § Primary-key nullability — the rule being enforced (read-only reference)
difficulty: medium
repro: verified
----

# Lens-enforced primary keys must treat NULL as equal to NULL

## The rule

docs/schema.md § Primary-key nullability: primary-key columns may be nullable, and **key comparison treats NULL as a value equal to itself** — two rows whose key tuples are equal column-by-column, NULLs included, are a duplicate primary key. `UNIQUE` follows SQL instead: any NULL in the tuple makes it distinct from every other tuple. Both storage backends implement this split.

## The defect

When a logical (application-schema) table declares a primary key the lens cannot prove unique from the basis, the prover classifies it `enforced-set-level`, either **row-time** (a basis `UNIQUE` plus a covering materialized view answers it) or **commit-time** (a deferred count check). Both arms enforce the key with `UNIQUE`'s NULL-distinct semantics, so a primary key over a nullable column admits duplicate NULL-keyed rows.

Reproduced (temporary spec, since deleted) on both arms:

```sql
-- Arm 1: commit-time
declare schema y { table t (id integer primary key, code text null) }
apply schema y
declare logical schema x { table t (code text null primary key, id integer) }
apply schema x
insert into x.t (code, id) values (null, 1);
insert into x.t (code, id) values (null, 2);   -- accepted today; should fail (duplicate key)
-- synthesized check: (select count(*) from x.t as _u where _u.code = NEW.code) <= 1

-- composite variant (with `declare lens for x2 over y2 { view t as select a, b, id from y2.t }`):
--   logical  primary key (a, b), a/b nullable; inserting (1, null) twice is accepted today.

-- Arm 2: row-time
declare schema y { table t (id integer primary key, code text null, unique (code)) }
apply schema y
create materialized view y.ix_t_code as select code, id from y.t where code is not null order by code
declare logical schema x { table t (code text null primary key, id integer) }
apply schema x
-- obligations: [{enforced-set-level, row-time}, …]
insert into x.t (code, id) values (null, 1);
insert into x.t (code, id) values (null, 2);   -- accepted today: the basis UNIQUE is NULL-distinct
```

### Arm 1 — the commit-time count (`lens-enforcement.ts`)

`synthesizeUniqueCountExpr` correlates each key column with a plain `_u.lk = <newSide>`, which is never true when either side is NULL, so a NULL-keyed row counts 0 and is never rejected. Correct for `unique`, wrong for `primaryKey`.

**Fix (verified in a throwaway patch — both repro cases then fail with `CHECK constraint failed: lens:pk`, and the emitted predicate becomes `_u.code = NEW.code or _u.code is null and NEW.code is null`):** build each key-column condition with `captureKeyEquality(left, right, nullSafe)` where `nullSafe = c.kind === 'primaryKey' && !logicalColumn.notNull` (read `slot.logicalTable.columns[li].notNull`; treat an unresolvable column as nullable, matching `keyColumnInfo`). Carry `nullSafe` on each `keyColumns` entry in `collectLensSetLevelConstraints` (three return sites: basis-mapped, authored-forward, bare-name fallback). `unique` and NOT NULL primary-key columns keep the plain, index-friendly `=`. Update the function's doc comment, which currently claims NULL-distinct "falls out for free" for every key.

### Arm 2 — the row-time classification (`lens-prover.ts`)

A row-time key is enforced only by the basis `UNIQUE` it maps to, and a basis `UNIQUE` is always NULL-distinct. docs/lens-constraints.md already notes that a row-time obligation is *always* over a nullable key (a NOT NULL key answered by a basis UC classifies `proved`). So a basis `UNIQUE` can never answer a logical primary key with a nullable column under key-equality semantics.

**Fix:** in `classifyKeyConstraint`, do not take the row-time branch (`findBasisCovering`) for a primary key when any key column is nullable — fall through to commit-time, where arm 1's NULL-safe count enforces it. Gate on nullability, not just `isPrimaryKey`, so the branch stays correct if the `proved` short-circuit ever changes. Consequences to check and accept:

- Such a key now emits the `lens.no-backing-index` warning; its remedy ("add a basis covering materialized view") cannot upgrade a nullable primary key. Adjust the message for this case (e.g. say the key is nullable and only a NOT NULL key can be answered by a basis covering structure), rather than giving advice that does nothing.
- A declared `on conflict replace/ignore` on such a key now reds `lens.unenforceable-conflict-action`, and statement-level `or replace` / `or ignore` / upserts are refused (commit-only). That is the honest outcome — the row-time path never enforced NULL keys.
- FD contribution drops from the guarded row-time FD to none (commit-time) — conservative, sound.

## Docs

- docs/lens-constraints.md § Set-level: the commit-time bullet's "NULL-distinct falls out for free" sentence must say it holds for `unique` only, and that a primary key correlates NULL-safely per nullable key column (key equality, docs/schema.md § Primary-key nullability). The row-time bullet should say a nullable primary key never classifies row-time, and why. Adjust the FD table's row-time row note accordingly (row-time is now always a `unique`).
- docs/lens-prover.md `lens.no-backing-index` row: reflect the nullable-primary-key remedy wording if changed.

## Tests

Two regression tests in `test/lens-enforcement.spec.ts`, in the set-level describe block next to "a re-keyed PK (commit-time set-level) ABORTs a duplicate logical key":

- commit-time: nullable single-column logical PK — a second all-NULL row ABORTs and the first survives; plus the composite `(1, null)` duplicate ABORTs while `(1, null)` and `(2, null)` coexist.
- row-time demotion: the arm-2 schema classifies the PK `commit-time` (use the file's `setLevelModes` helper) and a second NULL-keyed insert ABORTs.

The existing UNIQUE NULL-distinct tests (~750, composite unique ~815) must still pass unchanged — they pin that `unique` keeps its semantics.

Watch the decomposition suites in `test/lens-put-fanout.spec.ts` (~3000–3340) that use `integer null primary key` logical tables: they may now route a NULL-safe count; they should pass unless a test intentionally inserts two NULL-keyed rows.

## TODO

- Arm 1: thread `nullSafe` through `collectLensSetLevelConstraints` → `synthesizeUniqueCountExpr`, build conditions with `captureKeyEquality`; update doc comments.
- Arm 2: gate the row-time branch in `classifyKeyConstraint` off for a primary key with any nullable column; adjust the `lens.no-backing-index` message for that case.
- Add the two regression tests.
- Update docs/lens-constraints.md (and docs/lens-prover.md if the warning text changes).
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
