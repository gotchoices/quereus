description: When you ask the database to explain how it will run a query, it always claimed it is reading the whole table, even when it has actually chosen to use an index. Fixed so the explanation names the index actually used.
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # makeIndexFilterInfo, ~L73-88
  - packages/quereus/test/plan/basic/multi-filter-keyed.plan.json          # golden churn from fix
difficulty: easy
---

## Root cause

`EXPLAIN` reports a per-table-access `filterInfo.usableIndex` field, read from
`this.filterInfo.indexInfoOutput.idxStr` (`table-access-nodes.ts:132`).

Every index-seek arm in `rule-select-access-path.ts` builds its `FilterInfo` via the shared
`makeIndexFilterInfo` helper (introduced by the already-landed `iso-index-descriptor-engine-seam`
ticket). That helper set the top-level `idxStr` to the encoded seek descriptor (e.g.
`idx=_primary_(0);plan=2`) but left `indexInfoOutput.idxStr` untouched — it flowed through from
`base` (`filterInfo`), which is always seeded with `'fullscan'` at the top of
`ruleSelectAccessPath` (line ~371). So every equality seek, range seek, prefix-range seek,
multi-seek, and OR-range seek reported `usableIndex: 'fullscan'` in `EXPLAIN`, even though the
plan itself (and the runtime, which reads the top-level `filterInfo.idxStr`, not
`indexInfoOutput.idxStr`) correctly used the index. Ordering-only scans (`makeOrderedScanFilterInfo`)
already stamped both fields, which is why that one arm's `EXPLAIN` output was always correct.

## Fix

`makeIndexFilterInfo` now computes `idxStr` once and stamps it onto both the top-level field and
`indexInfoOutput.idxStr`:

```ts
function makeIndexFilterInfo(...): FilterInfo {
	const idxStr = encodeIdxStr(makeIdxStrSpec(indexName, plan, params));
	return {
		...base,
		constraints,
		idxStr,
		accessPath: buildIndexAccessPath(tableSchema, accessPlan, indexName, plan),
		indexInfoOutput: {
			...base.indexInfoOutput,
			idxStr,
		},
	};
}
```

Every seek arm (index-aware and legacy PK-based) funnels through this one helper, so the fix
is a single site.

## Verification

- `yarn build` — clean.
- `yarn test` — 4315 → 6918 passing (full suite incl. slow/property tests), 1 pre-existing golden
  mismatch (`basic/multi-filter-keyed`, exactly as the fix ticket predicted). Regenerated via
  `UPDATE_PLANS=true yarn test`; diff is the single expected line
  (`"usableIndex": "fullscan"` → `"usableIndex": "idx=_primary_(0);plan=2"`).
  `test/optimizer/` has no `usableIndex` goldens, so no churn there.
- `yarn lint` — clean.
- No other golden file's *content* changed (3 other `.plan.json` files were touched/rewritten
  by the `UPDATE_PLANS` run but are byte-identical per `git diff`, so nothing to review there).

## Review findings

(none yet — first pass)
