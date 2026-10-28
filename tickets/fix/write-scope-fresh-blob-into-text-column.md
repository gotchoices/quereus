description: The write scope labels a bare `randomblob(16)` written to a `text` column as `fresh`, although the stored value is a lossy text rendering of the bytes; docs/write-scope.md promises such a write classifies `other`.
files: packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/test/optimizer/write-scope-analyzer.spec.ts, docs/write-scope.md
difficulty: easy
----

Reported from Optimystic (`../optimystic`, ticket `quereus-labels-a-fresh-blob-written-to-text-as-fresh`), whose offline-sync outlook trusts the `fresh` label to tell an application an insert cannot collide with another machine's.

## Reproduction (4.21.0)

```sql
create table t (id text primary key, body text) using memory;
insert into t (id, body) values (randomblob(16), 'a');
```

`stmt.getWriteScope().writes[0].columns[0].provenance` is `{ kind: 'fresh', function: 'randomblob' }`, while executing it stores a string carrying U+FFFD replacement characters (`typeof(id)` answers `text`). Add a `b blob` column to `t` and the same insert's `id` classifies `other` — the label depends on an unrelated column.

## Cause

docs/write-scope.md says "a fresh value becomes `other` when the conversion is lossy … a fresh blob written to a `text` column, for one". `afterWriteConversion` in `packages/quereus/src/planner/analysis/value-provenance.ts` applies that rule only to a cell wrapped in a `WriteCoercionNode`, and `coerceToDeclared` in `packages/quereus/src/planner/building/insert.ts` skips the wrap for a column whose logical type has neither `parse` nor `validate` — which `TEXT_TYPE` has not. The executor still converts the cell; the plan never describes the conversion.

## Proposed fix

Apply the fresh-conversion rule to every fresh cell written to a typed column whether or not a `WriteCoercionNode` was planned: the classifier knows the cell's static type and the column's declared type at the projection, so `conversionKeepsFresh(from, to)` can run there. Rejected: planning the `WriteCoercionNode` for text columns too, since every plan over a text column would then carry the identity conversion the skip exists to avoid.

## TODO

- Reproduce in `packages/quereus/test/optimizer/write-scope-analyzer.spec.ts` with the two-text-column table above (`id` → `other`), beside `hex(randomblob(16))` into the same column (`fresh`) and the `b blob` variant (`other`, unchanged).
- Apply the rule at the projection; confirm `UpdateArgs.writeScope` (the module hook) reports the same label.
- Check docs/write-scope.md still matches; ship in the next patch release.
