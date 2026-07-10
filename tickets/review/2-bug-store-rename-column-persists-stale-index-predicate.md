---
description: When renaming a table or column on a persistent store, the saved table definition was briefly written to disk in a wrong state before being corrected a moment later; a crash in that gap left a broken definition. It now writes the correct definition the first time.
prereq:
files:
  - packages/quereus/src/schema/rename-rewriter.ts              # new renameTableInIndexPredicates
  - packages/quereus/src/index.ts                               # exports both index-predicate rewriters + ResolveColumnInSource
  - packages/quereus/src/runtime/emit/alter-table.ts            # stale comment corrected (no behavior change)
  - packages/quereus-store/src/common/store-module.ts           # alterTable 'renameColumn' ~1402; renameTable ~1925
  - packages/quereus-store/test/index-persistence.spec.ts       # traceCatalogWrites + 3 new tests
  - docs/schema.md                                              # catalog-bundle rewrite ordering
difficulty: medium
---

# Review: store no longer durably writes a stale partial-index predicate

## Read this first: the ticket's premise was half wrong

The implement ticket predicted that after `RENAME COLUMN` on a store-backed table, the
**persisted** index DDL would still name the old column, and that **reconnecting** would
rebuild an index whose predicate names a column the table does not have.

The first half is true only for an instant. The second half does not happen.

Two tests already in `index-persistence.spec.ts` (added by an earlier ticket) assert
exactly the ticket's "expected behavior" — corrected persisted DDL, clean reopen, correct
partial-index filtering — for both `RENAME COLUMN` and `RENAME TABLE`. **Both were green
before this ticket's diff.** I confirmed that, then went looking for why.

The reason: `propagateColumnRename` (which runs *after* the module hook) rewrites the
predicate AST and fires a `table_modified` event. The store's catalog listener
(`persistCatalogIfChanged`) regenerates the bundle, sees it differs, and re-persists the
**corrected** DDL. So the on-disk end state was already right, and the tripwire that the
prereq ticket left in `alter-table.ts` described this dependency accurately.

## What the real defect was

The store writes the catalog bundle **twice**: once from inside its own hook, with a
predicate naming the pre-rename column/table, and once from the async listener afterwards.
The first write is durable. A crash, a process kill, or a failed second write (the
listener's `enqueuePersist` only `console.warn`s on error) between the two leaves an
un-rehydratable bundle on disk forever.

Concretely, `create index ix_b on t (b) where b > 0` + `alter table t rename column b to c`
durably wrote:

```sql
create table "main"."t" ("id" integer not null primary key, "c" integer);
create index "ix_b" on "main"."t" ("c") where b > 0;   -- column `b` no longer exists
```

before overwriting it with the `where c > 0` form.

`renameTable` has the same shape — the ticket asked me to check, and **it does have the
bug**: a table-qualified predicate (`where t.b > 0`) is durably written as `where t.b > 0`
under the new table name `t2`, then corrected. Fixed here too.

No other `saveTableDDL` arm has this shape: `propagateTableRename` and
`propagateColumnRename` are the only post-hook AST rewrites in `alter-table.ts`
(`grep 'await propagate'`), and `RENAME CONSTRAINT` changes a name field, not an AST.

## What shipped

- **`renameTableInIndexPredicates`** in `schema/rename-rewriter.ts`, mirroring the prereq's
  `renameColumnInIndexPredicates`. Both are now exported from `@quereus/quereus`, along with
  the `ResolveColumnInSource` type.
- **`store-module.ts` rewrites predicates in place before `saveTableDDL`**, in the
  `alterTable` `'renameColumn'` arm and in `renameTable`. The predicate `Expression` is
  shared by reference with the catalog `TableSchema` and with a unique partial index's
  `derivedFromIndex` UNIQUE constraint, so one rewrite covers all of them. Both rewrites are
  reversed if anything in the enclosing `try` throws.
- **The later propagation pass is now a no-op** (the rewriters are idempotent), so its
  `table_modified` event compare-skips and the rename costs exactly **one** catalog write
  instead of two. One new test pins that.
- **The prereq's `NOTE:` tripwire in `alter-table.ts` is deleted**, because the condition it
  warned about no longer applies: the store no longer depends on that pass to fix its DDL.
  The surrounding comment now says both modules rewrite from inside their own hook.

## Tests

Three new tests in `packages/quereus-store/test/index-persistence.spec.ts`. Note they live
there, not in `alter-table-conformance.spec.ts` as the ticket's `files:` guessed —
`index-persistence.spec.ts` owns the persistent-provider + `reopen()` harness this needs.

The key move is a new `traceCatalogWrites()` helper that wraps the catalog store's `put` and
records **every** DDL value durably written. Asserting on the final catalog entry — which is
what the two pre-existing tests do — cannot see a stale intermediate write. That is exactly
why this bug survived them.

- `RENAME COLUMN never durably writes a partial-index predicate naming the old column` —
  also asserts exactly one catalog write.
- `RENAME TABLE never durably writes a partial-index predicate naming the old table` (uses a
  table-qualified `where t.b > 0`).
- `RENAME COLUMN under a UNIQUE partial index: uniqueness still enforced in scope after
  reopen` — the ticket asked for a unique partial index; covers the `derivedFromIndex`
  constraint surviving the rewrite, and that an out-of-scope duplicate is still allowed.

**All three fail against the pre-fix code and pass after.** Verified by neutralizing the two
forward `rename*InIndexPredicates` calls and re-running: 3 failing, and the two pre-existing
rename tests stayed green — direct evidence that the old tests could not catch this.

## Known gaps — treat these as things to attack, not accept

- **The rollback path is untested.** Nothing between the predicate rewrite and
  `saveTableDDL` can fail on any input the engine admits, so there is no natural fault to
  inject. The prereq ticket hit the same wall and reached past a private field to
  monkeypatch. I did not. If you think the `catch` arms are worth covering, they are the
  least-exercised lines in this diff.
- **A foreign-qualified predicate still persists stale.** `create index ix on t (b) where
  zzz.b > 0` is accepted today (`compilePredicate` ignores the table qualifier — filed as
  `backlog/bug-partial-index-predicate-ignores-table-qualifier`). The rename rewriter
  correctly declines to rewrite it, so nothing corrects the persisted DDL and the reopen
  fails. That is the pre-existing bug's blast radius, not new here, but this diff does not
  fix it and my tests do not cover it.
- **`renameTable`'s reverse rewrite has a hole** the `renameColumn` one does not, for the
  same foreign-qualifier reason. Parked as a `NOTE:` at the site (see Tripwires).
- **`renameTable` rolls back only the AST.** The physical stores have already moved by the
  time the rewrite runs, and `saveTableDDL` is the first thing after it. Reversing the AST
  on throw is strictly better than not, but it does not make the rename atomic — nor was it
  before. `docs/schema.md`'s "best-effort durability" paragraph already owns this.
- **`table.updateSchema(updatedSchema)` is not reversed** in the `renameColumn` catch. No
  other `alterTable` arm reverses it either, so I left the asymmetry alone rather than widen
  scope. Worth a second opinion on whether that is actually fine.
- **`yarn test:store` was run and is green**, but it replays the same `logic/*.sqllogic`
  corpus, none of which renames a column under a partial index. It adds no coverage for this
  diff. The real coverage is the three tests above.

## Tripwires (recorded, not ticketed)

- `packages/quereus-store/src/common/store-module.ts`, `renameTable` — `NOTE:` the reverse
  rewrite assumes no predicate legitimately named the new table before the rename. True for
  a real table (the rename-target guard), but `compilePredicate` currently accepts a
  qualifier naming a nonexistent table, so `where t2.b > 0` on a `t`→`t2` rename would be
  mis-reversed on failure. Harmless until that acceptance is tightened.

## Validation

- `yarn lint` from repo root: clean.
- `yarn test` from repo root: green — quereus 6776 passing / 9 pending / 0 failing (unchanged
  from the prereq's baseline), store 808 passing (up 3), every other package unchanged.
- `yarn test:store`: green — 6770 passing, 15 pending, 0 failing.
- `tsc -p tsconfig.test.json --noEmit` in `packages/quereus-store`: clean (the root `yarn
  lint` only type-checks `packages/quereus`'s test files, so the new spec's types are not
  covered by it — I ran it directly).
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
