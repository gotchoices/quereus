---
description: A CSV import using INSERT…SELECT with row_number() crashes ("No row context found") and imports 0 rows whenever the CSV has fewer columns than the import's fixed column schema; pad short table-function rows to their declared width so the row number lands in the right slot.
prereq:
files:
  - packages/quereus/src/runtime/emit/table-valued-function.ts
  - packages/quereus/src/runtime/emit/array-index.ts
  - packages/quereus/src/planner/building/select-window.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/test/logic/03.5-tvf.sqllogic
difficulty: easy
features: [DAT-IMP]
aspect: lamina-smoke
owner: quereus
---

# Pad table-valued-function rows to their declared column width

## Summary

A table-valued function (TVF) declares a fixed column schema in its
`returnType.columns`, but its implementation may `yield` rows that are **narrower**
than that declared width. When such a TVF feeds a window function inside an
`INSERT…SELECT`, the query throws an INTERNAL error and imports 0 rows:

```
No row context found for array index N
```

This is the DAT-IMP CSV-import regression in the ticket. The site-cad `csv_rows`
TVF advertises a fixed-width schema (`row_index, col_0 … col_K`) but emits rows
only as wide as the actual CSV, so any CSV narrower than the declared schema trips
the bug.

## Root cause (reproduced + confirmed)

Mechanism, verified end-to-end with a prototype:

1. `buildWindowProjections` (`select-window.ts:164-209`) computes
   `sourceColumnCount = windowType.columns.length - windowFunctions.length` — i.e.
   the **declared** column count of the window's source relation.
2. Each window-function reference is rewritten into an `ArrayIndexNode` whose
   `index = sourceColumnCount + matchingWindowFuncIndex`
   (`findWindowColumnIndex`, `select-window.ts:267-282`). For `row_number()` over a
   257-column source that index is `257`.
3. At runtime the window emitter builds each output row as
   `[...sourceRow, ...functionValues]` (`runtime/emit/window.ts`, e.g. the
   `outputRow.push(...values)` path). It appends the function slots **after the
   actual runtime row**, whose length is whatever the TVF yielded — *not* the
   declared width.
4. If the TVF yields a row narrower than its declared schema, the appended
   `row_number` lands at position `actualWidth`, but the `ArrayIndexNode` reads
   position `declaredWidth (= sourceColumnCount)`. `emitArrayIndex`
   (`runtime/emit/array-index.ts:7-27`) finds no context row wide enough and throws
   `No row context found for array index N`.

So `N` in the error is the *declared* source column count, and the bug fires
exactly when **declared TVF width > yielded row width** under a window function.
The production `257` corresponds to a `csv_rows` schema of `row_index + col_0…col_255`.

Note the engine is currently *inconsistent*: a plain `select col_5 from csv_rows(...)`
over a short row silently resolves to NULL (positional `ColumnReference` read of a
missing index), while the window/`ArrayIndex` path hard-errors. Normalizing row
width removes the inconsistency.

### Reproduction (confirmed failing on HEAD, passing with the fix)

Registering a TVF that declares 7 columns but yields 2-value rows, then:

```sql
create table Entity (
  id integer primary key, type text, component_id integer, name text,
  p_x real, p_y real, p_z real, s_x real, s_y real, s_z real);

insert into Entity (id, type, component_id, name, p_x, p_y, p_z, s_x, s_y, s_z)
select ? - row_number() over (order by row_index) as id,
       'g', ? as component_id,
       (? || coalesce(col_0, 'CP ' || row_index)) as name,
       0, 0, 0, 1, 1, 1
from csv_rows(?, ?);
```

throws `No row context found for array index 7` and inserts 0 rows. A full-width
TVF (yielding all 7 values) works fine — confirming width-mismatch is the trigger.

## Fix (verified)

Normalize each row a TVF yields to its **declared column count** at the TVF emitter
boundary — the single chokepoint where caller-supplied rows enter the relational
pipeline. Pad short rows with `null` (missing columns ⇒ SQL NULL, matching the
existing silent `ColumnReference` behavior) and truncate over-wide rows (an
over-wide row would otherwise make `ArrayIndex[declaredWidth]` read a real data
column — silently wrong). This keeps positional access (`ArrayIndex`) and
attribute access consistent for every downstream consumer, not just windows.

Concrete change in `packages/quereus/src/runtime/emit/table-valued-function.ts`:

- After `const rowDescriptor = buildRowDescriptor(plan.getAttributes());`, capture
  `const declaredColumnCount = plan.getAttributes().length;` and a `normalizeRow`
  helper:

  ```ts
  const normalizeRow = (row: Row): Row =>
      row.length === declaredColumnCount
          ? row
          : row.length < declaredColumnCount
              ? [...row, ...new Array(declaredColumnCount - row.length).fill(null)]
              : row.slice(0, declaredColumnCount);
  ```

- In **both** `runIntegrated` and `run`, change the yield loop to normalize before
  setting the slot and yielding:

  ```ts
  for await (const row of iterable) {
      const normalized = normalizeRow(row);
      slot.set(normalized);
      yield normalized;
  }
  ```

This was prototyped and the reproduction passes; `tvf`/`json_each`/`json_tree`/
`window` test groups (101 tests) stay green.

### Alternatives considered (and why not)

- **Pad in the window emitter only** (`runtime/emit/window.ts`, pad `currentRow`
  to `plan.source.getType().columns.length` before appending function slots) — too
  narrow; other positional consumers of short TVF rows would remain inconsistent.
- **Make `emitArrayIndex` tolerant** (return NULL when `index >= row.length`) —
  masks genuine bugs and yields silently-wrong results; the strict invariant check
  is worth keeping. Fix the row shape upstream instead.
- **Fix in site-cad `csv_rows`** (yield full-width rows) — different repo, and the
  SQL is well-formed; the engine should be robust to the declared-vs-yielded width
  gap regardless of TVF author.

## TODO

- Add `declaredColumnCount` + `normalizeRow` to `emitTableValuedFunctionCall` and
  apply it in both the `runIntegrated` and `run` yield loops (see Fix above).
- Add a regression test. sqllogic can't register a custom short-row TVF, so add a
  `.spec.ts` (model on `packages/quereus/test/basic.spec.ts`) that:
  - registers a TVF via `createTableValuedFunction` declaring N columns but
    `yield`ing rows with fewer values,
  - runs the `INSERT…SELECT … row_number() over (order by …) … from tvf(...)`
    shape from the Reproduction,
  - asserts the insert succeeds, the row count matches, and the missing TVF
    columns read back as NULL.
  - Also assert a plain `select <all declared cols> from tvf(...)` returns NULL for
    the unfilled columns (documents the now-consistent padding contract).
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
- If a TVF row-width contract is documented anywhere (`docs/runtime.md`,
  `docs/architecture.md`, or `createTableValuedFunction` JSDoc), add a sentence:
  rows yielded by a TVF are normalized (padded with NULL / truncated) to the
  declared `returnType.columns` width.
