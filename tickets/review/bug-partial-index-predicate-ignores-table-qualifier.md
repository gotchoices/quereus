---
description: A partial index's WHERE clause that puts a foreign table name in front of a column is now rejected when the index is created, instead of being silently treated as if it named the indexed table.
prereq:
files:
  - packages/quereus/src/vtab/memory/utils/predicate.ts        # compilePredicate: new tableName? arg + foreign-qualifier rejection
  - packages/quereus/src/vtab/memory/index.ts                  # MemoryIndex ctor: new tableName param, passed to compilePredicate
  - packages/quereus/src/vtab/memory/layer/base.ts             # createMemoryIndex → tableSchema.name
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # 2 MemoryIndex ctor sites → schema.name / newSchema.name
  - packages/quereus/src/vtab/memory/layer/manager.ts          # 3 compilePredicate + probe MemoryIndex → schema.name
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # MV WHERE: deliberately undefined + comment/NOTE
  - packages/quereus-store/src/common/store-module.ts          # 3 compilePredicate → tableSchema.name; stale bug-ref comment tightened
  - packages/quereus-store/src/common/store-table.ts           # 2 compilePredicate → this.tableSchema!.name
  - packages/quereus-isolation/src/isolated-table.ts           # 1 compilePredicate → this.tableSchema!.name
  - packages/quereus/src/runtime/emit/alter-table.ts           # predicateReferencesColumn doc comment (logic unchanged)
  - packages/quereus/test/partial-index-column-rename.spec.ts  # reshaped: create-time rejection + positive self-qualifier cases
  - packages/quereus/test/performance-sentinels.spec.ts        # MemoryIndex ctor site → schema.name
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts  # 2 MemoryIndex ctor sites → 'test'
  - docs/schema.md                                             # § index body-change detection: "cross-table reference" sentence
difficulty: medium
---

# Review: reject `CREATE INDEX ... WHERE <foreign-table>.<col>` at create time

## What the bug was

`compilePredicate` resolved a partial-index/UNIQUE/MV predicate's column refs by **bare
name** against the indexed table's columns. It rejected a *schema*-qualified ref
(`main.active`) and subqueries, but **never read the `table` field** of a `ColumnExpr`. So
`create index ix on t (name) where zzz.active = 1` was accepted and behaved exactly as
`where active = 1` — two statements that read differently compiled to the same index. It
also let a stale foreign qualifier slip past the ALTER rename/drop machinery and blow up on
a later rebuild.

## What changed

`compilePredicate(expr, columns, tableName?)` gained an **optional** owning-table name.
When supplied, a `table`-qualified ref naming any table other than the owning one is
rejected at compile time (case-insensitive); a self-qualifier (`where t.active = 1`,
`T.ACTIVE`) is accepted. Threaded through the recursive helpers (unary/binary/in), so a
qualified ref at any depth is caught. Schema-qualifier and subquery rejections are
untouched.

Every real index / UNIQUE compile site now passes its owning `TableSchema.name`:
- `MemoryIndex` ctor gained a required `tableName` param (inserted **before** the optional
  trailing `baseInheritreeTable`), passed on to `compilePredicate`. All 5 non-test ctor
  sites (base, transaction ×2, manager probe) and 3 test ctor sites updated.
- Memory manager (×3 ad-hoc `compilePredicate`), store-module (×3), store-table (×2),
  isolation (×1) all pass the owning table name.

**Deliberately left lenient — the MV maintenance site**
(`database-materialized-views-plan-builders.ts`): passes **`undefined`** (no owning name).
Reason, documented at the site: an MV body may reference its source through a FROM **alias**
rather than the source table's own name, so validating against `sourceSchema.name` would
wrongly reject a legal aliased body — and this site **floors to full-rebuild on any throw**
rather than erroring, so a false rejection would be a silent maintenance regression, not a
visible error. Making it strict needs the view's FROM alias set, which this builder does not
thread today; recorded as a `NOTE:` at the site (a tripwire, **not** a ticket).

Comment/doc-only follow-ons: `alter-table.ts predicateReferencesColumn` doc block
(qualifier-blindness is now moot, not a deliberate mismatch — walk logic unchanged);
`store-module.ts` rename-reversal `NOTE:` (mis-reversal path now unreachable for a live
predicate); `docs/schema.md` "cross-table reference" sentence (now "rejected at create
time").

## How to validate

- **Create-time rejection (the fix):** `create index ix on t (name) where zzz.active = 1`
  must throw naming `zzz.active` / "different table", and leave no index behind.
- **Self-qualifier still works:** `create index ix on t (name) where t.active = 1` and the
  case-insensitive `T.ACTIVE` must compile and scope rows exactly as bare `where active = 1`.
- **Regression surface** — the `MemoryIndex` ctor-arity change touches every index build
  path (plain create, UNIQUE, transaction-layer inherit, ALTER rebuild, store, isolation).
  Full suite (`yarn test`) covers these.

Reshaped tests live in `packages/quereus/test/partial-index-column-rename.spec.ts`:
- the old "rejects DROP COLUMN … foreign qualifier" test (which encoded the buggy accept
  path) is now "rejects CREATE INDEX whose predicate names a foreign table qualifier";
- added a non-unique self-qualifier filter test and a case-insensitive self-qualified
  UNIQUE-enforcement test (proves the compiled predicate scopes the live DML path).

## Validation performed

- `yarn workspace @quereus/quereus lint` — clean (eslint + tsc typecheck of src **and** test
  files, which catches the ctor-arity change at spec call sites).
- `yarn build` — clean (`tsc -b` type-checks quereus, quereus-store, quereus-isolation).
- `yarn test` — **all green** (quereus 6920 passing / 13 pending; store 916; sync 474;
  others all passing). The reshaped `partial-index-column-rename` spec: 12 passing.

## Known gaps / honest flags for the reviewer

- **Pre-existing store-mode failure, NOT from this ticket** — `yarn test:store` has one
  failure: `packages/quereus/test/logic/41.2-alter-column.sqllogic:112`
  (`select id from t_conv where v = 9` returns 0 rows after `alter column v set data type
  integer`). It is a **full** index (no predicate), passes in memory mode, fails only in
  store mode, and my diff is provably inert on its code path (every `compilePredicate` call
  is guarded by `predicate ?`). Recorded in `tickets/.pre-existing-error.md` for the triage
  pass. Do not attribute it to this change.
- **Self-qualifier positive test uses `.keys()` + SQL, not base-index `.size`.** The base
  layer's `secondaryIndexes[ix].size` only reflects rows once a consolidation folds the
  committed transaction layers into the base (an ALTER triggers this; a plain autocommit
  insert does not). So the non-unique positive test asserts the index is registered
  (`.keys()`) and that `select ... where active = 1` filters correctly, and the scoping
  proof rides on a UNIQUE partial index's live enforcement instead. If a reviewer wants a
  direct base-`.size` assertion, add a consolidation trigger first (as the existing rename
  tests do).
- **MV strictness deferred by design** (see above) — if a reviewer disagrees that the alias
  ambiguity + floor-not-error path justifies leniency, that is a scope call, not a bug in
  this change. The strict path needs the FROM alias set threaded into the MV builder.
- **Coverage floor, not ceiling.** The added tests exercise the memory module directly.
  The store/isolation call sites were type-checked and run under `yarn test`, but no new
  test specifically drives a *foreign-qualifier* partial index through the store or
  isolation modules — those paths share the same `compilePredicate`, so the behavior is
  inherited, but a reviewer wanting belt-and-suspenders could add a store-mode create-time
  rejection case.
