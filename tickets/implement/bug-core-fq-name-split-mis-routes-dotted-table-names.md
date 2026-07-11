----
description: A table whose quoted name contains a dot (e.g. a table literally named "a.b") is mis-identified inside the SQL engine's change-tracking code, so assertions, materialized-view conflict checks, and explain output look up the wrong table or none at all. Fix the name splitting so the full name survives.
prereq:
files:
  - packages/quereus/src/core/database-watchers.ts             # ~81 getRowCount(base)
  - packages/quereus/src/core/database-assertions.ts           # ~148 getRowCount, ~302 pkIndicesByBase
  - packages/quereus/src/core/database-materialized-views.ts   # ~978 plan.sourceBase
  - packages/quereus/src/func/builtins/explain.ts              # ~1030 assertion-explain prepared params
  - packages/quereus/src/util/                                 # home for a new split helper
  - packages/quereus-sync/test/sync/dotted-table-name.spec.ts  # regression-test template
difficulty: medium
----

# Core engine: fully-qualified `schema.table` keys are re-split on `.`

## Root cause

The core engine represents a base table as a flat lowercased key
`` `${schemaName}.${objectName}` `` (built by `mvKey`, `relationToBase`,
`plan.sourceBase`, watcher `tables` sets, the delta-executor dependency keys,
etc.). Several sites later recover the `(schema, table)` pair with
`base.split('.')` and destructure the first two elements:

```ts
const [schemaName, tableName] = base.split('.');
const table = ctx._findTable(tableName, schemaName);
```

SQL permits a dot inside a quoted identifier:

```sql
create table "a.b" (id integer primary key, v text);
```

`'main.a.b'.split('.')` yields `['main', 'a', 'b']`, so `tableName` becomes
`'a'` and the `.b` segment is dropped. `_findTable('a', 'main')` then resolves a
different table or nothing.

Same defect class already fixed in `@quereus/store` (`buildDataStoreName`) and
`@quereus/sync` (ticket `bug-sync-tablekey-split-mis-routes-dotted-identifiers`).
Those fixes did not touch the core engine.

The flat key is unambiguous as long as the **schema** name has no dot: the
first dot always separates schema from table. Splitting on the **first** dot
recovers the pair correctly. A dotted *schema* name is still ambiguous, but
dotted schema names are effectively unreachable in practice — the accepted
convention elsewhere in the repo is to fix the dotted-table case and document
the dotted-schema case (do **not** try to solve it here).

## The five sites

Two degrade harmlessly (costing fallback → `undefined`, safe), three produce
wrong results and must be fixed:

| Site | File:line | Impact |
|------|-----------|--------|
| `getRowCount` (watchers) | `database-watchers.ts:81` | harmless — feeds `estimatedRows` costing; wrong/missing → `undefined` fallback |
| `getRowCount` (assertions) | `database-assertions.ts:148` | harmless — same costing fallback |
| PK-index lookup | `database-assertions.ts:302` | **real** — `pkIndicesByBase` never set for the dotted base; per-tuple assertion residual dispatch loses its PK columns |
| covering-conflict lookup | `database-materialized-views.ts:978` | **real** — `plan.sourceBase.split('.')` resolves the wrong source schema; `lookupCoveringConflicts` returns `[]` → a UNIQUE conflict on a dotted-name MV source is **missed** |
| assertion-explain | `explain.ts:1030` | **real (diagnostic)** — `explain` on a dotted-name assertion table emits wrong prepared-param names |

Fix all five for consistency (the two harmless ones are one-line and cheap), but
the three "real" rows are the ones with observable wrong behavior — cover them
with the regression test.

Note: the *construction* sites are already correct — watcher `tables` sets
(`database-watchers.ts:95,117`) build the flat key and compare it whole via
`Set.has`, so they never re-split. Only the destructuring sites are broken. Do
not change the key format.

## Fix

Add one small shared helper (no existing util splits a qualified name; parser's
`tableIdentifier` builds the pair from tokens, not from a joined string). Split
on the **first** dot only:

```ts
// packages/quereus/src/util/qualified-name.ts (new file)
/**
 * Recover the (schema, table) pair from a flat lowercased base key
 * `` `${schema}.${table}` ``. Splits on the FIRST dot only, so a quoted
 * table name that legally contains a dot (e.g. `"a.b"` → key `main.a.b`)
 * survives intact. NOTE: a dotted *schema* name is still ambiguous; dotted
 * schema names are effectively unreachable in practice and intentionally
 * unsupported — see bug-core-fq-name-split-mis-routes-dotted-table-names.
 */
export function splitBaseKey(base: string): [schema: string, table: string] {
	const dot = base.indexOf('.');
	if (dot < 0) return ['', base]; // defensive: no schema segment
	return [base.slice(0, dot), base.slice(dot + 1)];
}
```

Replace each `const [schemaName, tableName] = base.split('.')` (and
`plan.sourceBase.split('.')`, and explain's `base.split('.')`) with a
`splitBaseKey(...)` call. Confirm every existing call passed schema **first**,
table second — keep that order.

(Carrying the `(schema, table)` pair forward instead of re-splitting a joined
key is the ideal per the ticket note, but the flat key is embedded across the
delta-executor Map keys, `mvKey`, and `relationToBase`; a first-dot split at the
recovery sites is the scoped fix and matches the store/sync fixes. Do not
refactor the key representation in this ticket.)

## Regression test

Model on `packages/quereus-sync/test/sync/dotted-table-name.spec.ts`: create
`"a.b"`, drive each real-impact feature, assert the full name survives. Put it
in `packages/quereus`'s own test suite (Mocha, `test/` — a `.spec.ts` beside the
other core specs, or a `.sqllogic` if the behavior is observable from SQL alone;
prefer `.spec.ts` here since the conflict-miss and assertion-residual paths need
programmatic setup).

Minimum coverage:
- **Materialized view (real):** create an MV whose source is `"a.b"` with a
  UNIQUE constraint it covers; insert a duplicate; assert the conflict is
  detected (not silently missed). This exercises `lookupCoveringConflicts`.
- **Assertion (real):** create an assertion referencing `"a.b"`; drive a
  per-row/per-group residual dispatch; assert it evaluates against the real
  table (violation raised when it should be).
- **Explain (real, diagnostic):** `explain` an assertion over `"a.b"`; assert
  the emitted `base`/prepared column names carry the full `a.b` name.

## TODO

- [ ] Add `splitBaseKey` helper in `packages/quereus/src/util/qualified-name.ts`
      (split on first dot; JSDoc the dotted-schema limitation).
- [ ] Replace the destructuring split at `database-watchers.ts:81`.
- [ ] Replace both splits at `database-assertions.ts:148` and `:302`.
- [ ] Replace `plan.sourceBase.split('.')` at `database-materialized-views.ts:978`.
- [ ] Replace `base.split('.')` at `explain.ts:1030`.
- [ ] Add the regression spec (MV conflict + assertion residual + explain) under
      `packages/quereus/test/`.
- [ ] `yarn build` (project references) and `yarn workspace @quereus/quereus run test`
      green; stream output with `tee`.
- [ ] `yarn lint` (only `packages/quereus` has a real lint; catches spec
      signature drift too).
