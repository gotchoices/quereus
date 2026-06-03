description: Plan-time dedup + NULL-drop of literal IN-list values in the memory-vtab multi-seek builders (plan=5), so the emitted `inCount` reflects the effective distinct non-null seek count instead of the raw literal-list length. Result semantics unchanged (strict subset of the runtime set-membership dedup already in scan-layer.ts).
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (single + composite multi-seek builders; helpers reduceLiteralSeekValues / reduceLiteralSeekTuples / createEmptyResultNode), packages/quereus/test/optimizer/in-multiseek-incount.spec.ts (regression spec, extended in review), packages/quereus/src/vtab/memory/layer/scan-plan.ts (runtime parse of inCount — read, unchanged)
----

## Summary

`WHERE col IN (v1..vn)` on an indexed memory-vtab column compiles to a multi-seek
`IndexSeekNode` (plan=5). The planner now reduces the **literal** IN list at plan time
before materializing it into the node:

- **Single-column builder:** `reduceLiteralSeekValues` drops NULLs and collapses
  duplicate literals (binary comparator); `seekKeys`, the per-value EQ constraints, and
  `inCount` all derive from the reduced list. Mixed/dynamic IN lists (OR-collapse) keep
  their raw shape — runtime stays authoritative.
- **Composite builder:** when every seek column is pure-literal, the cross-product is
  built from actual values, NULL-bearing tuples are dropped (mirrors runtime
  `seekKeyHasNull`), duplicate tuples collapse; `inCount`/`seekWidth` follow. Any dynamic
  column → original index-based cross-product retained.
- **All-NULL edge:** if reduction empties the list, the builder emits an `EmptyResultNode`
  rather than a zero-key multi-seek. This is correctness-required, not cosmetic:
  `inCount=0` parses back in `scan-plan.ts` to no `equalityKeys` and degrades to an
  unbounded full-index walk.

Plan-time dedup is a strict subset of runtime dedup (binary comparator only, since the
column collation is unknown at plan time). Never an under-count, never a wrong result.

## Validation

- `yarn typecheck`, `yarn lint`, `yarn test` (packages/quereus) all clean — **4437
  passing, 9 pending**.
- Regression spec `test/optimizer/in-multiseek-incount.spec.ts` reads `inCount` off the
  optimized `IndexSeekNode.filterInfo.idxStr`; extended in review (see findings).

## Review findings

Adversarial pass over commit `815d4328`. Read the diff fresh before the handoff.

**Checked — correctness / semantics:**
- **Dedup safety (the central risk).** The reduction now drives the actual seekKeys, not
  just the cosmetic count, so over-collapsing would *drop matching rows*. Verified
  `compareSqlValues` defaults to `BINARY` (finest collation) and compares cross-type by
  storage-class ordering (`compareSqlValuesFast`), so `=== 0` implies equality under any
  coarser collation (NOCASE/RTRIM) and across no type boundary. Plan-time dedup is
  therefore strictly conservative — it can never collapse two values the runtime would
  seek separately. The "strict subset of runtime dedup" invariant holds. The existing
  NOCASE case-variant test (`secondary-index-access.spec.ts`) confirms the runtime, not
  the planner, does the finer collapse.
- **EmptyResult is correctness-required.** Confirmed against `scan-plan.ts:333-335`:
  `inCount=0` → `equalityKeys` stays empty → degraded full-index walk. The EmptyResult
  emission prevents that. Verified empirically (`a IN (null,null) AND b IN (10,20)` →
  EmptyResult → `[]`).
- **allLiteral gating** (`valueExpr === undefined`) correctly separates pure-literal from
  dynamic/mixed; dynamic/mixed single + composite paths retain raw shape so the runtime
  remains authoritative. `argvIndex`/`seekConstraints` stay aligned with `seekKeys` and
  the `inCount * seekWidth` slicing in `scan-plan.ts` (both derived from the same arrays).
- **Composite NULL-equality is correct here.** `a IN (1,2) AND b = null` reduces to
  EmptyResult (`[]`) — the composite multi-seek builder is *immune* to the plan=2
  NULL-equality bug (below) because the all-NULL reduction catches it.
- `cartesianProduct` order preserved; widened return type (`+EmptyResultNode`) handled by
  the caller (`selectPhysicalNode` already returned it for the impossible-predicate case;
  typecheck green).

**Checked — quality:** `createEmptyResultNode` extraction is a clean DRY win (de-dups the
impossible-predicate path). Small single-purpose helpers, no `any`, comments accurate.

**Checked — docs:** searched `docs/` for `inCount`/multi-seek; no documented claim is
contradicted (result semantics unchanged). `docs/memory-table.md` / `docs/optimizer.md`
multi-seek descriptions remain accurate. No doc update needed.

**Minor — fixed in this pass:** the implementer flagged the test surface as narrow. Added
3 composite cases to `in-multiseek-incount.spec.ts` covering paths with no prior coverage:
(a) partial-NULL composite reduction with row-result assertion, (b) all-NULL-bearing
composite cross-product → EmptyResult + `[]`, (c) single-equality NULL component
(`b = null`) → EmptyResult + `[]`. Suite re-run green (11 passing in the spec; full
suite unaffected).

**Major — already filed by implementer, confirmed valid, left as-is:**
`tickets/fix/in-null-equality-returns-all-rows.md` — single-value `WHERE col = null` /
`col IN (null)` on an indexed column returns ALL rows (plan=2 point-seek gates on
`equalityKey != null`, falls through to a full walk with the constraint marked handled).
Confirmed real and pre-existing; those plan=2 branches were not touched by this ticket.
Out of scope here; the fix ticket carries full repro + analysis.

**Noted non-issues (accurately disclosed in the handoff):** cost is forwarded verbatim
(the memory module doesn't scale cost by IN-list length, so no behavior depends on it);
`inCount` is not surfaced through `query_plan()`/EXPLAIN (lives only in the `FilterInfo`
handed to `xFilter`) — a possible future enhancement, not a defect.

**Pre-existing test failures:** none. No `.pre-existing-error.md` written.
