---
description: Primary-BTree range scan on a DESC-leading composite PRIMARY KEY no longer drops rows; the secondary-branch isDescFirstColumn handling was ported into the primary branch of scanLayer. Reviewed and completed.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What shipped

A leading-column range scan over a composite PRIMARY KEY whose leading column is
`DESC` previously returned **zero** rows (`SELECT a FROM td WHERE a >= 15` over
`PRIMARY KEY (a DESC, b)` → `[]` instead of `[{"a":20},{"a":30}]`). The primary
branch of `scanLayer` built its seek key only from `plan.lowerBound` and iterated
forward, so the DESC-aware comparator positioned the seek *past* the matching rows
(which sit at the front of the physical descending order) and the scan yielded
nothing.

The fix ports the secondary-index branch's `isDescFirstColumn` handling into the
primary branch of `scanLayer` (`scan-layer.ts`, the `plan.indexName === 'primary'`
block):

1. **Direction detection** — `isDescFirstColumn = schema.primaryKeyDefinition?.[0]?.desc === true`
   (the synthesized all-columns fallback carries no `desc`, so the `?.` chain
   yields `false`, which is correct).
2. **Direction-aware seek start** — DESC leading column seeks from `plan.upperBound`
   (wrapped in a single-element array for composite PKs), or tree start when
   absent. ASC-leading keeps the existing lower-bound wrap.
3. **Direction-aware early termination** — gated on `isAscending = !plan.descending`,
   mirroring the secondary branch: DESC-leading breaks once the leading column
   drops below the lower bound; ASC-leading breaks once it passes the upper bound.
   The `equalityPrefix` prefix-mismatch break is preserved ahead of the bound
   checks.

## Review findings

**Scope checked:** the full implement diff (`9700f429`) read first with fresh
eyes; `scan-layer.ts` (both primary and secondary branches), the composite
comparator (`primary-key.ts`), and the plan-construction path (`scan-plan.ts`,
`rule-select-access-path.ts`) for reachability analysis. Aspects considered: SPP,
DRY (mirrors the secondary branch verbatim — good), correctness of the seek-start
comparator interaction, early-termination among equal/duplicate keys, exclusive
vs. inclusive bound boundaries, error handling, type safety. Lint + full quereus
suite run green.

**Correctness — ascending path (the only reachable path): PASS.** Traced the
comparator (`createCompositeColumnPrimaryKeyFunctions`, incl. the
`arrA.length - arrB.length` short-key branch) by hand for the seek-start `[upper]`
wrap across `<`/`<=`, lower-bound-only, upper-bound-only, and between-keys upper
values; all position the cursor correctly. The leading-column-only early-break
correctly handles duplicate leading values (does not truncate siblings, fires only
after exhausting them).

**Tests — strengthened (minor, fixed in this pass).** The implementer's cases were
a reasonable floor (repro, inclusive/exclusive lower bound, lower+upper range,
`ORDER BY DESC` interaction, 3-column PK, `count(*)`). Added adversarial coverage
to `05.1-composite-pk-range-scan.sqllogic`: a `tdup` table with **duplicate
leading-column values** exercising (a) lower-bound-only with two rows sharing the
boundary value, (b) exclusive lower bound landing on the duplicated value, (c)
inclusive-lower `count(*)`, (d) **upper-bound-only** range (no lower bound → the
DESC early-termination guard never fires; correctness rests entirely on
`planAppliesToKey`), and (e) inclusive `<=` upper bound on a duplicated key. All
pass.

**Major finding — filed, not fixed: latent descending-range seek-start bug.** The
implementer flagged `plan.descending=true` + upper bound as an unproven worry. I
**proved it is unreachable today**: `isDescendingScan()` keys off `ordCons==='DESC'`
(never emitted) or `planType` 1/4 (never emitted — only `{0,2,3,5,6,7}` are
produced by `rule-select-access-path.ts`), so `plan.descending` is *always false*
and the `isAscending` branch is always taken. The latent defect: the seek-start
selection for a DESC-leading key picks `upperBound` regardless of physical walk
direction (in **both** primary and secondary branches), so a future descending
range emitter would mis-start the backward walk and drop front-of-order rows.
Since the path is unreachable, no regression test can be written for it now, so
this is filed as `backlog/desc-leading-descending-range-seek-start-latent` rather
than fixed speculatively.

**Docs:** searched `docs/` — no file documents the memory-vtab scan direction /
seek-start behavior, so no doc update was warranted.

**Not run:** `yarn test:store` (memory-module scan-layer change; store path not
exercised). The natural (no-ORDER-BY) emit order for a DESC-leading forward scan
is descending; tests assert with explicit `ORDER BY` for determinism rather than
relying on natural order.

## Validation (review pass)

- `yarn workspace @quereus/quereus run lint` → exit 0.
- Full quereus suite → **3584 passing, 9 pending** (baseline preserved; the added
  assertions ride within the existing `05.1` logic test case).
- Targeted: `--grep "05.1-composite"` → passing with the new adversarial cases.
