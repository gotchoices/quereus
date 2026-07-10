---
description: When you ask the database to explain how it will run a query, it always claims it is reading the whole table, even when it has actually chosen to use an index. The explanation is wrong; the query itself runs correctly.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # ~614, 708, 782, 859, 985, 1053
  - packages/quereus/src/planner/nodes/table-access-nodes.ts               # ~132 usableIndex
difficulty: easy
---

## What happens

`EXPLAIN` reports a per-table-access `filterInfo.usableIndex` field, read from
`this.filterInfo.indexInfoOutput.idxStr` (`table-access-nodes.ts:132`).

The access-path rule builds one `FilterInfo` up front with
`indexInfoOutput.idxStr = 'fullscan'`, then each index-seek arm spreads it and overrides only
the **top-level** `idxStr`:

```ts
const fi: FilterInfo = {
	...filterInfo,                       // indexInfoOutput.idxStr is still 'fullscan'
	constraints: eqConstraints,
	idxStr: `idx=${idxStrName}(0);plan=2`,
};
```

So every equality seek, range seek, prefix-range seek, multi-seek, and OR-range seek reports
`usableIndex: 'fullscan'` in `EXPLAIN`. The two *ordering-only* arms (`plan=0`, lines ~885 and
~1078) do update both fields, which is why the inconsistency has gone unnoticed — those are the
only arms whose EXPLAIN output is right.

## Why it is only cosmetic today

Nothing on the execution path reads `indexInfoOutput.idxStr`. The in-memory vtab
(`vtab/memory/layer/scan-plan.ts`) and the store module
(`quereus-store/src/common/store-table.ts`) both read the top-level `filterInfo.idxStr`, which
is correct. So queries return the right rows via the right index; only the *explanation* lies.

That makes it a real defect rather than a tripwire — the wrong value is produced on every
index-seek plan today, not conditionally — but a low-severity one.

## Expected behavior

Every arm that sets `filterInfo.idxStr` should set `indexInfoOutput.idxStr` to the same value,
so `EXPLAIN` names the index the plan actually seeks.

## Notes

- Fixing this will change `EXPLAIN` output for any golden/plan test that currently bakes in
  `usableIndex: 'fullscan'` on a seek. Check `packages/quereus/test/plan/` and
  `packages/quereus/test/optimizer/` before starting; the churn, not the fix, is the work.
- Found while designing `iso-index-descriptor-engine-seam`, which introduces an `encodeIdxStr`
  helper and a `retargetFilterInfoIndex` that rewrites both fields together. Landing that
  ticket first makes this a one-line change per arm.
