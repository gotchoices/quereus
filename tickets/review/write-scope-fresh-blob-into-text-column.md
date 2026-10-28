description: The write scope labelled a random blob written to a text column as "fresh" (collision-free) whenever the insert listed every column in table order, although the stored value is a lossy text rendering of the bytes; fixed and ready for review.
architecture: docs/write-scope.md
files: packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/runtime/emit/insert.ts, packages/quereus/test/optimizer/value-provenance.spec.ts, docs/write-scope.md
----

Reported from Optimystic (`../optimystic`, ticket `quereus-labels-a-fresh-blob-written-to-text-as-fresh`), whose offline-sync outlook trusts the `fresh` label to mean an insert cannot collide with another machine's.

## Bug

```sql
create table t (id text primary key, body text) using memory;
insert into t (id, body) values (randomblob(16), 'a');
```

`writes[0].columns[0].provenance` was `{ kind: 'fresh', function: 'randomblob' }`, but the stored value is lossy text (U+FFFD replacement chars). Adding an omitted column made it `other`.

## Cause

`createRowExpansionProjection` (`planner/building/insert.ts`) returns the source unchanged when it already matches table shape (all columns, in order, no generated columns), so no `WriteCoercionNode` is planned. The cell is converted later in `emitInsert`'s `buildRowCoercion` (`runtime/emit/insert.ts`) from source attribute type → declared column type. The classifier only applied the "fresh becomes `other` on lossy conversion" rule (docs/write-scope.md) at `WriteCoercionNode`, so it missed this path.

## Fix

`classifyInsertColumns` in `planner/analysis/value-provenance.ts` now runs `afterWriteConversion(provenance, attr.type.logicalType, col.logicalType, col.name)` for every column — the same type pair `emitInsert` converts with. Behind a planned `WriteCoercionNode` the attribute already carries the declared type, so this is identity for `fresh` and an idempotent re-conversion for literals. `classifyWriteCoercion`'s doc comment now mentions the table-shape path. Statement `getWriteScope()` and module hook `UpdateArgs.writeScope` share one memo (`write-site-analysis.ts`), so both report the fixed label. UPDATE / DO UPDATE already applied the rule via `classifyAssignments`.

## Tests

- `test/optimizer/value-provenance.spec.ts` — new table-driven case on table `tt (id text primary key, body text)`: `insert into tt (id, body) values (randomblob(16), hex(randomblob(16)))` → `id` `other`, `body` `fresh`. Fails before fix, passes after. (Expanded-projection path already covered by existing `insert into t (id, v) values ('7', randomblob(16))`.)

Validation: `yarn test` full workspace green (quereus 10819 passing / 25 pending; all other packages passing). `yarn workspace @quereus/quereus run lint` clean at fix stage; this stage changed only a doc comment.

## Review focus / known gaps

- Literal `value` re-conversion behind a planned coercion assumed idempotent for all declared types (check `afterWriteConversion` for a type whose `parse` is not idempotent, e.g. temporal or JSON normalization).
- Other write paths that might skip a `WriteCoercionNode` (insert ... select in table shape, upsert insert arm, returning) — verified only by reasoning that they all flow through `classifyInsertColumns`.
- Ship in next patch release.
