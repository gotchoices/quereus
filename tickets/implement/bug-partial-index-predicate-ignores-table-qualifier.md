---
description: When you create a partial index, the engine ignores any table name you write in front of a column in its WHERE clause — so a clause that names some other table is quietly treated as if it named the indexed table, instead of being rejected. Make it reject a foreign table qualifier at create time.
prereq:
files:
  - packages/quereus/src/vtab/memory/utils/predicate.ts        # compilePredicate — add owning-table-name arg, validate `table` qualifier
  - packages/quereus/src/vtab/memory/index.ts                  # MemoryIndex ctor — thread table name to compilePredicate
  - packages/quereus/src/vtab/memory/layer/base.ts             # createMemoryIndex — pass this.tableSchema.name
  - packages/quereus/src/vtab/memory/layer/transaction.ts      # 2 MemoryIndex ctor sites — pass schema.name / newSchema.name
  - packages/quereus/src/vtab/memory/layer/manager.ts          # 3 compile sites + probe MemoryIndex — pass schema.name
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # MV WHERE compile site — see "MV site" below
  - packages/quereus-store/src/common/store-module.ts          # 3 compile sites — pass tableSchema.name; retire stale bug-ref comment
  - packages/quereus-store/src/common/store-table.ts           # 2 compile sites — pass this.tableSchema.name
  - packages/quereus-isolation/src/isolated-table.ts           # 1 compile site — pass this.tableSchema.name
  - packages/quereus/src/runtime/emit/alter-table.ts           # predicateReferencesColumn — comment update only (see below)
  - packages/quereus/test/partial-index-column-rename.spec.ts  # reshape the foreign-qualifier test into a create-time rejection
  - docs/schema.md                                             # § index body-change detection, "cross-table reference" sentence (line ~767)
difficulty: medium
---

# Reject `CREATE INDEX ... WHERE <foreign-table>.<col>` at create time

## The defect

`compilePredicate` (`packages/quereus/src/vtab/memory/utils/predicate.ts`) resolves a
column reference by bare name against the indexed table's column list. It throws on a
*schema*-qualified ref (`main.active`) and on subqueries, but **never reads the `table`
field** of a `ColumnExpr` (AST field `ColumnExpr.table`, `parser/ast.ts:49`). So every
table qualifier compiles to the same read:

```sql
create table t (id integer primary key, name text, active integer);
create index ix on t (name) where zzz.active = 1;   -- accepted; behaves as `where active = 1`
```

Confirmed reproduction: the committed test
`packages/quereus/test/partial-index-column-rename.spec.ts:182`
("rejects DROP COLUMN when the predicate names the column through a foreign qualifier")
constructs exactly this index and passes *today* — it encodes the buggy accept-path.

Two ripple effects (from the source ticket, both real):

- **Stale predicate is read differently by other passes.** The rename rewriter honours
  the qualifier and declines to rewrite `zzz.active` on `ALTER TABLE t RENAME COLUMN
  active TO is_active`; the memory module then rebuilds the index by re-compiling the now-
  stale predicate and dies with `Partial-index predicate references unknown column
  'active'`. Rejecting at create time removes the possibility.
- **Downstream guards over-approximate.** `predicateReferencesColumn`
  (`alter-table.ts:692`) deliberately ignores the qualifier to match the compiler. Once
  creation rejects foreign qualifiers, no *live* predicate can carry one, so that guard
  is automatically correct — no code change needed there, only a comment update (below).

## Expected behaviour

`compilePredicate` on a predicate carrying a table qualifier must:

- **succeed** when the qualifier names the owning table itself, case-insensitively
  (`where t.active = 1` on table `t`, `where T.ACTIVE = 1` too) — this must keep working;
- **fail** at compile time with a clear message when the qualifier names anything else,
  in the same spirit as the existing schema-qualified rejection at predicate.ts:82-92.

Two SQL statements that read differently must never compile to the same index.

## Design

### Signature

`compilePredicate(expr, columns)` has no idea what table it compiles for. Add an
**optional** owning-table name:

```ts
export function compilePredicate(
	expr: Expression,
	columns: ReadonlyArray<ColumnSchema>,
	tableName?: string,          // owning table; when given, a foreign `table` qualifier is rejected
): CompiledPredicate
```

Thread `tableName` into `compileExpression` (and its recursive helpers, since a qualified
ref can appear at any depth). In the `'column'`/`'identifier'` arm, after the existing
schema-qualifier rejection, add:

```ts
if (ref.type === 'column' && ref.table && tableName !== undefined
	&& ref.table.toLowerCase() !== tableName.toLowerCase()) {
	throw new QuereusError(
		`Partial-index predicate cannot reference column '${ref.table}.${ref.name}' `
			+ `of a different table (predicate is scoped to '${tableName}')`,
		StatusCode.ERROR,
	);
}
```

Rationale for **optional / lenient-when-undefined**: it lets each call site opt in as its
table name becomes available, and lets the MV site (below) stay lenient deliberately. A
site that passes `undefined` keeps today's ignore-the-qualifier behaviour — acceptable
only where documented.

Note `IdentifierExpr` (`type: 'identifier'`) has **no `table` field** — only `schema`
(ast.ts:39-43). A bare name parsed as an identifier can't carry a table qualifier, so the
check only applies to the `'column'` branch. Verify the parser emits `type: 'column'`
(not `'identifier'`) for `zzz.active` before relying on this — a quick `db.exec`-then-
inspect, or trust that the existing schema-qualifier branch already special-cases both.

### Call sites — pass the owning table name

All index / UNIQUE compile sites have the owning `TableSchema` in scope; pass its `.name`:

- **MemoryIndex** (`index.ts:85`): the ctor takes `allTableColumnsSchema` but no table
  name. Add a `tableName: string` ctor param and pass it through to `compilePredicate`.
  Insert it **before** the optional trailing `baseInheritreeTable` param to avoid an
  optional-before-required ordering. Update all construction sites:
  - `layer/base.ts` `createMemoryIndex` → `this.tableSchema.name`
  - `layer/transaction.ts` `initializeSecondaryIndexes` → `schema.name`
  - `layer/transaction.ts` `adoptSchema` → `newSchema.name`
  - `layer/manager.ts` `validateUniqueOverEffectiveRows` probe → `schema.name`
  - test ctor sites: `test/performance-sentinels.spec.ts` (×1) and
    `test/vtab/memory-index-pk-value-identity.spec.ts` (`makeIndex` / `makeChildIndex`,
    ×2) — pass the literal schema name (`'orders'` / `'test'`) these tests already build.
- **manager.ts** direct `compilePredicate` calls (`:1017`, `:1083`, `:1347`) → `schema.name`.
- **store-table.ts** (`:1861` UNIQUE, `:1876` index) → `this.tableSchema!.name`.
- **store-module.ts** (`:1032` index build, `:1179` UNIQUE, `:1201` index) → `tableSchema.name`.
- **isolated-table.ts** (`:1205` UNIQUE) → `this.tableSchema!.name`.

### MV site — pass `undefined`, deliberately (`database-materialized-views-plan-builders.ts:360`)

This compiles a materialized-view body's `WHERE` against a **source** table's columns, and
the ref there is a source-table reference that may be written through a **table alias** used
in the view's `FROM`, not the source table's own name. Validating against `sourceSchema.name`
would wrongly reject a legal aliased body. Worse, this site **catches and floors** (returns
`null` → full-rebuild maintenance) rather than erroring, so a false rejection is a silent
performance regression, not a visible error.

Pass **`undefined`** here (no third arg) to preserve exactly today's lenient behaviour, and
add a one-line comment saying why (alias ambiguity + floor-not-error path). Resolving the
source alias set to make this strict is out of scope for this bug — the create-time defect
this ticket fixes is `CREATE INDEX` / partial `UNIQUE`, not internal MV maintenance. If a
follow-up wants MV strictness, it needs the alias set from the view's FROM, which this
builder does not currently thread. (Record that as a `NOTE:` at the site, not a ticket.)

### alter-table.ts — comment only

`predicateReferencesColumn` (`:692`) and its doc block (`:673-690`) explain that ignoring
the qualifier is a workaround matching the compiler. After this fix the reasoning changes:
no live predicate can carry a foreign qualifier (creation rejects it), so the guard's
qualifier-blindness is now moot rather than a deliberate mismatch. Update the doc comment
to say so; **do not** change the walk logic (still correct, and simpler than making it
qualifier-aware for a case that can no longer occur). Leave the subquery `NOTE:` intact.

### store-module.ts — stale bug reference

The comment at `store-module.ts:2208-2213` cites this bug slug as the reason a mis-reversal
is "harmless". Once fixed, tighten that comment: a foreign qualifier can no longer be
created, so the mis-reversal path is unreachable for a live predicate. Keep it accurate;
don't delete the surrounding rename-reversal reasoning.

### docs/schema.md — tighten the "cross-table reference" sentence

`docs/schema.md` § "Index body-change detection" (the long paragraph at ~line 767) currently
reads: *"A cross-table reference is meaningless here — `compilePredicate` … so a foreign
qualifier is silently ignored rather than rejected at create time — but the all-renames
scope mirrors the forward rewriter regardless."* Change it to state that a foreign qualifier
is now **rejected at create time**, so a live index body can only carry a self-qualified
(`where t.active = 1`) or bare reference; keep the point that the all-renames scope mirrors
the forward rewriter.

## Test reshaping

- `partial-index-column-rename.spec.ts:182` ("rejects DROP COLUMN … foreign qualifier"):
  its setup (`create index ix on t (name) where zzz.active = 1`) now throws at create.
  Reshape into a **create-time rejection** assertion: `create index … where zzz.active = 1`
  rejects with a message naming the foreign qualifier; assert no index `ix` was created.
  Update the stale comment at :184-187.
- Add a **positive** case proving a self-qualifier still compiles and scopes rows:
  `create index ix on t (name) where t.active = 1` (and a case-insensitive `T.ACTIVE`),
  then confirm the partial index filters as `where active = 1` does. Co-locate with the
  existing partial-index specs (this file, or `test/logic/*.sqllogic` if a SQL-level
  round-trip reads cleaner).

## TODO

- [ ] `compilePredicate`: add `tableName?` param; thread through `compileExpression` /
      `compileUnary` / `compileBinary` / `compileIn`; reject foreign `table` qualifier in
      the `'column'` arm (case-insensitive), keep schema-qualifier + subquery rejections.
- [ ] `MemoryIndex` ctor: add `tableName` param (before `baseInheritreeTable`); pass to
      `compilePredicate`. Update all 5 non-test ctor sites + 3 test ctor sites.
- [ ] Pass `schema.name` / `tableSchema.name` at the memory manager (×3), store-table (×2),
      store-module (×3), isolation (×1) compile sites.
- [ ] MV builder: pass `undefined`; add comment (alias ambiguity + floor-not-error) and a
      `NOTE:` on the deferred strict-MV option.
- [ ] `alter-table.ts` `predicateReferencesColumn`: update doc comment (logic unchanged).
- [ ] `store-module.ts:2208`: tighten stale bug-ref comment.
- [ ] `docs/schema.md` ~L767: rewrite the "cross-table reference is silently ignored"
      sentence to "rejected at create time".
- [ ] Reshape `partial-index-column-rename.spec.ts:182` into a create-time rejection;
      add positive self-qualifier + case-insensitive tests.
- [ ] `yarn workspace @quereus/quereus lint` (type-checks spec call sites — catches the
      MemoryIndex ctor-arity change in tests) and `yarn test`. If store paths are touched
      meaningfully, spot-check with `yarn test:store` for the ALTER/UNIQUE predicate paths.
