description: Fix `WHERE col IN (<value-list>)` returning duplicated / spurious rows when the list has a duplicate literal or a NULL. Root cause confirmed: the memory-vtab IN multi-seek (plan=5) in `scanLayer` does not dedup seek keys and treats a NULL seek key as a full index scan.
prereq:
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts (THE FIX — multi-seek branch, ~line 19), packages/quereus/src/vtab/memory/layer/scan-plan.ts (where equalityKeys is built, plan=5, ~line 331), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (emits the multi-seek IndexSeekNode, ~line 338 single-col / ~line 374 composite), packages/quereus/src/vtab/memory/layer/interface.ts (Layer.getPkExtractorsAndComparators), packages/quereus/test/logic/ (new .sqllogic regression file), packages/quereus/test/fuzz.spec.ts (the differential property that caught it)
----

## Root cause (confirmed by reproduction)

The bug is **not** in the scalar `InNode` emit (`runtime/emit/subquery.ts` — that path
returns a correct boolean), nor in the decorrelation rule (which only handles IN
*subqueries*, `!node.values`). It is in the **memory-vtab IN-list multi-seek**.

Pipeline for `col IN (v1..vn)` when `col` has an index (PK or secondary/unique):

1. `constraint-extractor.ts` `extractInConstraint` produces a single `IN` constraint
   whose `value` is the **raw, un-deduped, NULL-inclusive** value array.
2. `rule-select-access-path.ts` (`selectPhysicalNodeFromPlan`, ~line 338) turns a
   multi-value IN on a single-column index into an `IndexSeekNode` with `plan=5;inCount=N`
   and one seek key **per list element** (no dedup, no NULL filtering). The composite
   case (~line 374) builds the cross-product of the per-column value lists — same flaw.
   The memory `xBestIndex` marks the IN filter **handled**, so the residual
   `col IN (...)` FilterNode is dropped — the multi-seek is now the *sole* filter and
   must therefore be set-membership-exact.
3. `scan-plan.ts` `buildScanPlanFromFilterInfo` (plan=5, ~line 331) copies those N args
   verbatim into `ScanPlan.equalityKeys`.
4. `scan-layer.ts` `scanLayer` multi-seek branch (lines 19-26) loops over `equalityKeys`
   and for each one recurses with `equalityKey = key`.

Two faults, both verified against the ticket's minimal repro on `memory`:

**Fault A — duplicate literal multiplies rows.** `equalityKeys = [5, 5]` ⇒ two identical
point seeks ⇒ the matching row is yielded twice. (Set membership degraded to a bag.)

**Fault B — NULL list element triggers a full scan.** For `in (5, null)`,
`equalityKeys = [5, null]`. The recursion sets `equalityKey = null`, and **both** seek
branches gate on `if (plan.equalityKey != null)` (loose `!=`, scan-layer.ts lines 49 and
136). `null != null` is **false**, so the point-seek branch is skipped and execution
falls through to the **unbounded range/full-index walk** below it — yielding *every*
row. That is the source of the spurious non-matching row (repro: `v=7`; fuzz
counterexample: `c_real2=-79.79`).

Reproduction (confirmed live, memory vtab, before any fix):

```
select * from t where v in (5)       → [{k:1,v:5}]                      (correct)
select * from t where v in (5, 5)    → [{k:1,v:5},{k:1,v:5}]            (Fault A)
select * from t where v in (5, null) → [{k:1,v:5},{k:1,v:5},{k:2,v:7}]  (Fault A + B)
select v from t where v in (5, 5, 9) → [{v:5},{v:5}]                    (Fault A)
plan op list                         → [...,'INDEXSEEK',...]            (confirms multi-seek path)
```

(table: `create table t (k integer primary key, v integer unique); insert into t values (1,5),(2,7)`)

Note: with **no index** on the IN column the IN stays as a residual scalar `InNode`
filter (correct), and the `quereus-store` module never marks IN as handled (also keeps
the residual filter). So the bug is **specific to the memory-vtab indexed multi-seek
path**. This is why `select distinct *` masked it — DISTINCT collapsed the bag back to a
set; `distinct-elimination` correctly removed a now-redundant DISTINCT over a
PK/UNIQUE-backed set, exposing the already-violated set invariant.

## The fix

Fix at the single runtime choke point: **`scanLayer`'s multi-seek branch**
(`scan-layer.ts` lines 19-26). This covers single-column and composite multi-seeks, and
both literal and dynamic (parameter/expression) seek keys — values are concrete here.

Two requirements:

- **NULL-skip (mandatory for soundness).** Before recursing, skip any seek key that is
  `null` (scalar) or contains a `null` component (composite array). In SQL, `x IN (…,
  NULL)` is `true` if `x` equals a non-null element else `NULL` ⇒ the WHERE excludes the
  row; a NULL element contributes **no** match. For a composite tuple seek, a NULL in any
  component makes the row-value comparison `NULL` ⇒ no match ⇒ drop the whole key. This
  also closes Fault B's full-scan fallthrough.

- **Dedup matches.** A duplicate seek key must not re-yield its row.
  **Recommended (collation-correct): dedup the *yielded rows by primary key*** across the
  whole multi-seek. The function already obtains
  `const { primaryKeyExtractorFromRow, primaryKeyComparator } = layer.getPkExtractorsAndComparators(schema)`
  in the body below (lines 42-43); lift an equivalent into the multi-seek branch and keep
  a `seen` set keyed by `primaryKeyComparator` (an `inheritree` `BTree<BTreeKey, BTreeKey>`
  built `(k) => k` with `primaryKeyComparator`, mirroring the pattern in
  `runtime/emit/subquery.ts`). Dedup-by-PK is collation-agnostic (it keys on physical row
  identity), so it also correctly handles two case-variant IN literals (`'A'`, `'a'`) that
  hit the *same* entry under a NOCASE index — which a naive key compare would miss.

  A simpler key-level dedup via `compareSqlValues` (element-wise for composite) was
  empirically verified to fix all four reported cases, but is **not** collation-correct
  for NOCASE/custom-collation indexes (it would leave `('A','a')` as two seeks → two
  rows). Prefer the PK-dedup unless you add explicit index-collation handling.

Sketch (PK-dedup variant — adapt imports: add `BTreeKey` from `../types.js`, `BTree`
from `inheritree`):

```ts
if (plan.equalityKeys && plan.equalityKeys.length > 0) {
    const schema = layer.getSchema();
    const { primaryKeyExtractorFromRow, primaryKeyComparator } =
        layer.getPkExtractorsAndComparators(schema);
    const seen = new BTree<BTreeKey, BTreeKey>((k) => k, primaryKeyComparator);
    const hasNull = (k: BTreeKey): boolean =>
        Array.isArray(k) ? k.some(v => v === null) : k === null;
    for (const key of plan.equalityKeys) {
        if (hasNull(key)) continue;                       // NULL contributes no match
        const singlePlan: ScanPlan = { ...plan, equalityKey: key, equalityKeys: undefined };
        for await (const row of scanLayer(layer, singlePlan)) {
            const pk = primaryKeyExtractorFromRow(row);
            if (seen.find(pk).on) continue;               // dedup duplicate matches
            seen.insert(pk);
            yield row;
        }
    }
    return;
}
```

Verify the exact `BTree` / `getPkExtractorsAndComparators` signatures against
`runtime/emit/subquery.ts` and `scan-layer.ts` lines 42-93 before finalizing — match
existing usage rather than the sketch literally.

### Optional secondary cleanup (not required for correctness)

In `rule-select-access-path.ts` the single-column (~line 338) and composite (~line 374)
multi-seek builders could also drop NULL literals and dedup *literal* values up front, so
`inCount` and EXPLAIN reflect the real seek count and a few redundant seeks are avoided.
This is a perf/clarity nicety only — it cannot fully replace the runtime fix because
dynamic (parameter) seek values are unknown at plan time. If you do it, keep it as a
pure subset and do not let it regress the dynamic path.

## Tests

- Add a new `packages/quereus/test/logic/NN-in-value-list.sqllogic` (pick an unused
  numeric prefix) covering, on a `memory` table with a **UNIQUE/indexed** IN column (so
  the multi-seek path is taken) AND on a non-indexed column (residual-filter path), each
  of: (a) duplicate literal `in (5, 5)`, (b) NULL element `in (5, null)`, (c) both
  `in (5, null, 5, 9)`, (d) IN on the PRIMARY KEY column (also multi-seeks), (e) a
  composite-index IN (cross-product) with a duplicate and a NULL, (f) the same WHERE both
  with and without `select distinct`. Assert exact set-membership row counts. Use the
  `→ [...]` expected-rows format (see `test/logic/08.1-semi-anti-join.sqllogic`). Mirror
  the ticket's acceptance: the four minimal queries return 1,1,1,1 rows, and
  `c_real2 in (0, null, 0, 820)` returns exactly the `{0, 820}` rows once each.
- Confirm the existing `test/optimizer/secondary-index-access.spec.ts` IN multi-seek
  tests still pass (they use distinct non-null values, so they should be unaffected).
- Run the `distinct elimination produces identical results` property in
  `test/fuzz.spec.ts` (raise `numRuns` locally) and confirm the divergence is gone. (The
  harness is not seed-reproducible — see the separate follow-up note in the original fix
  ticket; do not try to fix that here.)
- `yarn workspace @quereus/quereus test` (memory) must pass. The store path keeps IN as a
  residual filter, so `test:store` is unaffected, but a quick `yarn test:store` on the new
  logic file is a cheap confirmation if time permits.

## Acceptance (from the source ticket)

- `in (5)`, `in (5, 5)`, `in (5, null)`, `in (5, 5, 9)` each return exactly the
  set-membership rows (1, 1, 1, 1 matching rows for the repro table), once each.
- `select * from t1 where c_real2 in (0, null, 0, 820)` returns exactly the rows whose
  `c_real2 ∈ {0, 820}`, once each.
- New `.sqllogic` coverage as above, with and without DISTINCT.
- The `distinct elimination produces identical results` fuzz property stops finding this
  divergence.

## TODO

- [ ] In `scan-layer.ts`, rewrite the multi-seek branch (lines 19-26) to skip NULL /
      NULL-containing seek keys and dedup yielded rows by primary key (recommended) — see
      sketch above. Add the `BTreeKey` and `BTree` imports.
- [ ] Re-run the live reproduction (the four queries + the fuzz counterexample
      `c_real2 in (0, null, 0, 820)`) and confirm set-membership results.
- [ ] Add the new `test/logic/NN-in-value-list.sqllogic` regression file (cases a–f,
      indexed + non-indexed + PK + composite, with/without DISTINCT).
- [ ] Run `yarn workspace @quereus/quereus test` and the raised-`numRuns` fuzz property;
      confirm green and the divergence is gone.
- [ ] (Optional) Dedup/NULL-drop literal values in `rule-select-access-path.ts`'s
      single-column and composite multi-seek builders for honest `inCount`/EXPLAIN; keep
      it a pure subset of the runtime fix.
- [ ] If `test/optimizer/secondary-index-access.spec.ts` or any plan-shape test asserts
      an `inCount`/seek count that the optional cleanup changes, update it accordingly.
