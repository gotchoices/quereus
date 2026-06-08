---
description: O(log N) pagination via OrdinalSlice + monotonic-limit-pushdown rule — replaces LimitOffset[/Sort]/access-leaf with a slice that stamps FilterInfo.offset/limit on the vtab call
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/ordinal-slice-node.ts, packages/quereus/src/runtime/emit/ordinal-slice.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/planner/rules/access/rule-monotonic-limit-pushdown.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/vtab/filter-info.ts, packages/quereus/test/optimizer/monotonic-limit-pushdown.spec.ts, packages/quereus/test/vtab/test-ordinal-seek-module.ts, docs/optimizer.md, docs/module-authoring.md
---

## Summary

Adds an O(log N) seek path for `select … order by <monotonic> limit n offset k` over vtab modules that advertise `monotonicOn` + `supportsOrdinalSeek`. Without the rule the runtime sorts/buffers `k + n` rows and discards `k`; with the rule the vtab seeks directly to the kth monotonic row.

## What was built

- **`OrdinalSliceNode`** (`src/planner/nodes/ordinal-slice-node.ts`): physical operator slotted directly above an access leaf. Children order `[source, offsetExpr?, limitExpr?]`. `computePhysical` propagates `ordering` / `uniqueKeys` / `monotonicOn` from the source but drops `accessCapabilities` (the slice consumes the ordinal-seek capability).
- **`emitOrdinalSlice`** (`src/runtime/emit/ordinal-slice.ts`): per-execution bounds in a `WeakMap<RuntimeContext, SliceBounds>`. The slice's `run()` resolves offset/limit before iterating the leaf's iterable; the leaf's `FilterInfoOverride` reads bounds back. Defensive streaming row-cap guard above the leaf preserves correctness if a module ignores the directive.
- **`FilterInfoOverride`** (`src/runtime/emit/scan.ts`): new optional callback parameter on `emitSeqScan`. Invoked after IndexSeek dynamic-args augmentation, before `vtabInstance.query()`.
- **`FilterInfo.limit` / `FilterInfo.offset`** (`src/vtab/filter-info.ts`): new optional pushdown directives with capability contract documented in `docs/module-authoring.md`.
- **`monotonic-limit-pushdown` rule** (`src/planner/rules/access/rule-monotonic-limit-pushdown.ts`): peels through `Sort?` and a chain of `Project`/`Alias` (only trivial column-ref projections) down to a `SeqScan`/`IndexScan`/`IndexSeek` leaf. On match, rewrites `LimitOffset[/Sort]/.../leaf` → `…/OrdinalSlice/leaf`, dropping the redundant Sort. Registered in `PostOptimization` pass at priority 8 so the leaf already carries its physical capabilities. Bails on direction mismatch, multi-key sort, residual filters, or missing capabilities.
- **Test fixture** (`test/vtab/test-ordinal-seek-module.ts`): in-memory vtab module backed by a sorted array with PK ordinal seek; advertises `monotonicOn` + `supportsOrdinalSeek` only on unfiltered single-column-PK scans, mirroring the memory module's narrow advertisement window.

## Validation

- `yarn workspace @quereus/quereus exec tsc --noEmit` — clean
- `yarn workspace @quereus/quereus lint` — clean
- `yarn workspace @quereus/quereus test` — 2585 passing, 2 pending

## Test coverage (`test/optimizer/monotonic-limit-pushdown.spec.ts`)

19 tests covering:
- **Positive plan-shape**: `ORDER BY id LIMIT n OFFSET k`, no-offset, no-`ORDER BY`, parameterized bounds.
- **Negative plan-shape**: `ORDER BY id DESC` (direction mismatch), multi-key `ORDER BY`, residual `WHERE`, leaf without `ordinalSeek`, leaf without `monotonicOn`.
- **Behavioral**: `(n=10, k=0/500/995/10000)` boundary cases, `LIMIT 0`, parameterized bounds at runtime, identical results when rule disabled via `tuning.disabledRules`.
- **Pushdown verification**: vtab observes `FilterInfo.offset`/`limit` exactly when rule fires.
- **Physical properties**: `OrdinalSlice` preserves `monotonicOn` in its physical JSON.

## Usage

```sql
-- When the vtab module advertises monotonicOn + supportsOrdinalSeek
select * from t order by id limit 5 offset 1000;     -- uses OrdinalSlice
select * from t limit 5 offset 1000;                 -- no ORDER BY needed if leaf is monotonic

-- Inspect plan
select op from query_plan('select id from t order by id limit 5 offset 100');
-- → BLOCK, PROJECT, ORDINALSLICE, INDEXSCAN, ...
```

Disable via `db.optimizer.updateTuning({ ..., disabledRules: new Set(['monotonic-limit-pushdown']) })`.

## Adoption notes

- The bundled `memory` module does NOT advertise `supportsOrdinalSeek` — its underlying BTree (inheritree 0.3.4) is path/key-based with no O(log N) ordinal-seek primitive. End-to-end testing uses the dedicated test fixture module.
- Plugin authors with native ordinal indexing (IndexedDB-backed stores, sorted external datasets) can opt in by setting `supportsOrdinalSeek: true` in `getBestAccessPlan` and honoring `FilterInfo.offset` / `FilterInfo.limit` in `query()`.

## Out of scope (intentional, deferred)

- Memory module ordinal-seek advertisement (would require upstream BTree work or a parallel pickByOrdinal index).
- DESC `ORDER BY` over an asc-monotonic leaf via reverse-iteration (would need a separate `reverseIteration` capability flag).
- Cost-based competition between this rule and the existing `LimitOffset` path — the rule fires whenever preconditions hold; the plan-shape rewrite is unambiguously a win.
