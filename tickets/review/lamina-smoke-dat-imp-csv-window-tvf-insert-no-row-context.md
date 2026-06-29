---
description: Review the TVF row-padding fix that resolves "No row context found" crashes when a table-valued function yields narrower rows than its declared schema.
files:
  - packages/quereus/src/runtime/emit/table-valued-function.ts
  - packages/quereus/test/tvf-row-padding.spec.ts
---

# Review: Pad TVF rows to declared column width

## What was done

Added a `normalizeRow` helper in `emitTableValuedFunctionCall`
(`packages/quereus/src/runtime/emit/table-valued-function.ts`) that normalizes every row
a TVF yields to its **declared column count** (`plan.getAttributes().length`):

- Rows shorter than the declared width are padded with `null` (matching existing silent
  `ColumnReference` behavior for missing columns).
- Rows wider than the declared width are truncated.
- Exact-width rows are passed through unchanged (zero allocation).

The normalization is applied in **both** the `runIntegrated` and `run` yield loops — the
only two code paths where caller-supplied rows enter the relational pipeline.

## Root cause recap

`buildWindowProjections` computes window-function output slots at index
`sourceColumnCount + windowFuncIndex`. If the TVF yielded a row narrower than its
declared schema, the slot index fell outside the row, and `emitArrayIndex` threw
`No row context found for array index N`. The fix ensures the row is always as wide
as the declared schema before it reaches any downstream consumer.

## Regression test

`packages/quereus/test/tvf-row-padding.spec.ts` — two cases:

1. **Plain SELECT**: registers a TVF declaring 5 columns but yielding 2-value rows;
   asserts that `col_1..col_3` read back as NULL (documents the padding contract).
2. **INSERT…SELECT with `row_number() over`**: exercises the exact crash shape from
   the ticket; asserts insert succeeds and all 3 rows land with correct values.

## Test results

- `yarn workspace @quereus/quereus test`: **6399 passing, 9 pending, 0 failures**
- TVF/window/json-specific run (`--grep "tvf|window|json"`): **76 passing**
- New regression tests: **2 passing**

## Known gaps / reviewer checklist

- **Lint pre-existing failure**: `yarn lint` fails with a `TS1360` in
  `test/runtime/fork-contract.spec.ts` (missing `signal` property in a
  `RuntimeContext` fork-policy fixture). This is pre-existing and unrelated to this
  fix — documented in `tickets/.pre-existing-error.md`.
- The fix only touches the TVF emitter. Reviewer should verify no other
  callers of `createRowSlot` / TVF row yield paths exist outside this file.
- The `normalizeRow` helper allocates a new array on every short/wide row. For
  high-volume TVFs this could matter; consider whether it warrants a note or
  optimization later.

## Review findings

<!-- populated by reviewer -->
