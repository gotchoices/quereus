description: The write scope labelled a random blob written to a text column as "fresh" (collision-free) whenever the insert listed every column in table order, although the stored value is a lossy text rendering of the bytes; fixed and reviewed.
architecture: docs/write-scope.md
files: packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/test/optimizer/value-provenance.spec.ts, docs/write-scope.md
----

Reported from Optimystic (`../optimystic`, ticket `quereus-labels-a-fresh-blob-written-to-text-as-fresh`), whose offline-sync outlook trusts the `fresh` label to mean an insert cannot collide with another machine's.

## Bug

```sql
create table t (id text primary key, body text) using memory;
insert into t (id, body) values (randomblob(16), 'a');
```

`writes[0].columns[0].provenance` was `{ kind: 'fresh', function: 'randomblob' }`, though the stored value is lossy text. With an omitted column (so the builder planned a `WriteCoercionNode`) it was correctly `other`.

## Cause

`createRowExpansionProjection` (`planner/building/insert.ts`) passes a source already in table shape through unchanged, so no `WriteCoercionNode` is planned; `emitInsert`'s `buildRowCoercion` converts the cell later (source attribute type → declared column type). The classifier applied the "fresh becomes `other` on lossy conversion" rule only at `WriteCoercionNode`.

## Fix

`classifyInsertColumns` (`planner/analysis/value-provenance.ts`) applies `afterWriteConversion(provenance, attr.type.logicalType, col.logicalType, col.name)` to every column — the same type pair `emitInsert` converts with. Behind a planned coercion the attribute already carries the declared type, so it is a no-op there. Statement `getWriteScope()` and the module hook `UpdateArgs.writeScope` share one memo, so both report the fixed label.

Landed in `ticket(fix): write-scope-fresh-blob-into-text-column` (code + test) and `ticket(implement): write-scope-fresh-blob-into-text-column` (doc comment on `classifyWriteCoercion`).

## Review findings

- **Correctness of the fix** — read `classifyInsertColumns`, `afterWriteConversion`, `conversionKeepsFresh`, `buildCellCoercion`, `buildRowCoercion`, `emitInsert`, `WriteCoercionNode.generateType`. The classifier now mirrors exactly the type pair `emitInsert` uses (`plan.source.getAttributes()[i].type.logicalType` → column type). No defect found.
- **Literal re-conversion behind a planned coercion (handoff focus 1)** — not a re-parse: with `from === to`, `buildCellCoercion` returns the identity guard, which passes an already-converted value through. Verified with a throwaway probe (deleted) that table-shape and reordered-column inserts agree for `date`, `datetime` (`'2024-01-01 10:00:00'` → `'2024-01-01T10:00:00'` on both paths), `json` object (`'{"a": 1}'` → `{a:1}`), and the JSON string-scalar hazard (`'"s"'` → `"s"` on both paths, not double-parsed). Side effect, correct: table-shape literals now also report their stored form, which previously they did not.
- **Other insert paths (handoff focus 2)** — probed `insert into tt select randomblob(16), 'x'`, `... on conflict (id) do nothing`, and `... returning id`: all report `id` as `other`. All flow through `classifyInsertColumns`; UPDATE / DO UPDATE already applied the rule via `classifyAssignments`.
- **Tests** — the one new spec case is the regression repro and also pins `hex(randomblob(16))` staying `fresh` into text; kept. Added none: the probe results above are covered by existing conversion logic and did not reveal a defect.
- **Docs** — `docs/write-scope.md` § labels already states the rule for "an inserted cell or an assigned one" without reference to the planned node; still accurate, no change.
- **Hygiene** — minor: the inline comment in `classifyInsertColumns` claimed the conversion is "the identity" behind a planned coercion; reworded to say a fresh label passes unchanged and a literal passes the identity guard. No other findings (function small, no new branches, no resource or error-handling surface).
- **Tripwires / tickets** — none filed. The existing `NOTE:` on `conversionKeepsFresh` (untyped fresh function returning a blob stays `fresh`) is an accepted tradeoff and its revisit condition has not tripped.
- **Validation** — `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus test` 10819 passing / 25 pending.
