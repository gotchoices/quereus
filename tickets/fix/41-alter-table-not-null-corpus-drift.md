---
description: `41-alter-table.sqllogic:131-132` declares `alter table t_notnull add column required text;` (no NOT NULL constraint) and asserts `-- error: NOT NULL`. The column is nullable — `required` is just a column name in this context (line 142 reuses the name unambiguously as a column identifier in `add column required text not null default 'default_val'`), and the parser does not treat it as a constraint keyword. The alter correctly succeeds. Upstream cosmetically passes via the `executeExpectingError` substring tautology in `logic.spec.ts:564-588` — same family as `returning-corpus-check-name-drift` and `sqllogic-error-directive-ordering`.
prereq:
files:
  - packages/quereus/test/logic/41-alter-table.sqllogic
  - packages/quereus/test/logic.spec.ts
---

# Corpus drift — `41-alter-table.sqllogic` NOT-NULL assertion on a nullable column

## What the corpus asserts vs. what Quereus emits

`41-alter-table.sqllogic:126-132`:

```sql
create table t_notnull (id integer primary key);
insert into t_notnull values (1), (2);
-- run

-- NOT NULL without DEFAULT should fail (table has rows)
alter table t_notnull add column required text;
-- error: NOT NULL
```

`required` is a plain column name; the column is `text` with no `NOT NULL` constraint. The same name is reused unambiguously as a column identifier later in the same file:

```sql
-- 41-alter-table.sqllogic:142
alter table t_notnull add column required text not null default 'default_val';
```

So `alter table … add column required text` adds a nullable text column. The pre-existing rows get nulls (correctly), and the alter does not error. The expected `-- error: NOT NULL` directive is therefore mis-authored.

## Why upstream cosmetically passes

`logic.spec.ts:564-588`:

```ts
const executeExpectingError = async (sqlBlock, errorSubstring, lineNum) => {
    try {
        await db.exec(sqlBlock);
        const baseError = new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
        const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
        throw new Error(`${baseError.message}${diagnostics}`);
    } catch (actualError) {
        expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(), …);
        …
    }
};
```

When `db.exec` succeeds silently:
1. The `try` synthesises an error whose message contains `Expected error matching "NOT NULL" but SQL block executed successfully…` — note the verbatim `"NOT NULL"` from `errorSubstring`.
2. The same handler catches that synthesised error and asserts `.to.include("not null")` against the lower-cased message — which trivially passes because `"not null"` is a substring of `"expected error matching \"not null\" but sql block executed successfully…"`.

Substring tautology: every successful `db.exec` masquerades as a passing error-expecting assertion.

## Proposed changes

Two paths; pick whichever is preferable:

### Path A: Re-author the corpus (quick)

In `packages/quereus/test/logic/41-alter-table.sqllogic:130-132`, either (a) declare the constraint the corpus clearly intended:

```diff
 -- NOT NULL without DEFAULT should fail (table has rows)
-alter table t_notnull add column required text;
+alter table t_notnull add column required text not null;
 -- error: NOT NULL
```

…or (b) accept the alter and remove the `-- error:` directive (and rephrase the comment), since lines 138/142 already cover the NOT-NULL-without-default + with-default cases.

### Path B: Fix the `executeExpectingError` tautology (engine-side)

Move the no-error throw outside the surrounding `try/catch`, e.g.:

```ts
let succeeded = false;
try { await db.exec(sqlBlock); succeeded = true; } catch (actualError) {
    expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(), …);
    …
}
if (succeeded) {
    throw new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
}
```

This forces every silently-succeeding error-expecting block to surface as a real failure — exposing this corpus bug and any siblings (see "Notes" below).

The combined fix is Path A + Path B.

## Acceptance

- Either Path A (corpus rewording) or Path A + Path B (engine + corpus) lands. `41-alter-table.sqllogic` passes.

## Downstream impact

Lamina's `lamina-quereus-test` package maintains an `ALTER_TABLE_NOT_NULL_CORPUS_DRIFT` entry in its `KNOWN_FAILURES` list (`packages/lamina-quereus-test/src/sqllogic/known-failures.ts`). After this lands and lamina consumes the new quereus version, that entry is removed. Lamina's runner already implements the Path-B behaviour — its no-error throw is structured outside the catch clause, so this corpus bug surfaces honestly.

## Notes

- Third known instance of the `executeExpectingError` tautology masking real corpus authoring drift; see `returning-corpus-check-name-drift` and `sqllogic-error-directive-ordering` for the prior two.
- A grep for `add column \w+ text;` followed by `-- error:` may surface other instances of the same authoring pattern.
