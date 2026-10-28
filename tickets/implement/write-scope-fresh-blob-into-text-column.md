description: The write scope labelled a random blob written to a text column as "fresh" (collision-free) whenever the insert listed every column in table order, although the stored value is a lossy text rendering of the bytes; the fix and its regression test are in place and need the full suite run and a review.
architecture: docs/write-scope.md
files: packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/runtime/emit/insert.ts, packages/quereus/test/optimizer/value-provenance.spec.ts, docs/write-scope.md
difficulty: easy
repro: verified
----

Reported from Optimystic (`../optimystic`, ticket `quereus-labels-a-fresh-blob-written-to-text-as-fresh`), whose offline-sync outlook trusts the `fresh` label to tell an application an insert cannot collide with another machine's.

## Reproduction (4.21.0)

```sql
create table t (id text primary key, body text) using memory;
insert into t (id, body) values (randomblob(16), 'a');
```

`writes[0].columns[0].provenance` was `{ kind: 'fresh', function: 'randomblob' }`; the stored value is text carrying U+FFFD replacement characters. Add an omitted `b blob` column and the same insert classified `other`.

## Actual cause (the fix ticket's guess was wrong)

The fix ticket blamed `coerceToDeclared` skipping `TEXT_TYPE`; it does not — `TEXT_TYPE` has both `parse` and `validate`. The skip is one level up: `createRowExpansionProjection` in `planner/building/insert.ts` returns the source unchanged when `sourceMatchesTableShape` holds (every column supplied, in order, no generated columns). No projection is built, so no `WriteCoercionNode` exists. The cell is converted later by `emitInsert`'s `buildRowCoercion` (`runtime/emit/insert.ts`), driven by each source attribute's static type against the column's declared type. The classifier applied the docs/write-scope.md rule ("a fresh value becomes `other` when the conversion is lossy") only at a `WriteCoercionNode`, so it never saw this conversion. An omitted column breaks the table-shape match, which is why the extra `b blob` column changed the label.

## Fix (applied during fix stage)

`classifyInsertColumns` in `planner/analysis/value-provenance.ts` now runs `afterWriteConversion(provenance, attr.type.logicalType, col.logicalType, col.name)` on every column, which is the same source-type → column-type pair `emitInsert` converts with. Where a `WriteCoercionNode` was planned, the source attribute already carries the declared type, so the extra pass is the identity for `fresh`, and for a literal it re-applies an idempotent conversion to the already-converted value. The statement's `getWriteScope()` and the module hook (`UpdateArgs.writeScope`) both read the one memo built in `planner/analysis/write-site-analysis.ts`, so they report the same label. UPDATE / DO UPDATE already applied the rule via `classifyAssignments`.

Regression case added to the table-driven `test/optimizer/value-provenance.spec.ts` (the lowest layer; new table `tt (id text primary key, body text)`): `insert into tt (id, body) values (randomblob(16), hex(randomblob(16)))` → `id` `other`, `body` `fresh`. The pre-existing case `insert into t (id, v) values ('7', randomblob(16))` already covers the expanded-projection path. This test failed before the fix and passes after. `value-provenance.spec.ts` + `write-scope-analyzer.spec.ts` pass (40) and `yarn workspace @quereus/quereus run lint` is clean.

docs/write-scope.md line 152 already says what the code now does; no doc change needed.

## TODO

- Run `yarn test` (full workspace) and confirm nothing else depended on the old label.
- Consider whether `classifyWriteCoercion`'s doc comment ("The insert builder wraps nearly every cell in one") should mention the table-shape fast path that plans no wrap.
- Ship in the next patch release.
