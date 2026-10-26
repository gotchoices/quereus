description: An internal classifier now labels every value a write statement produces by where it comes from (a literal, a statement input, a fresh unique-per-call function, a clock or random source, the row's own previous values, or other rows), and a module can register its own function as a fresh source. Reviewed; the review fixed two cases where a value was wrongly reported unique or reported in a form the write never stores.
architecture: docs/change-scope.md#written-value-provenance
files: packages/quereus/src/planner/analysis/value-provenance.ts, packages/quereus/src/planner/analysis/non-det-functions.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/common/constants.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/core/database.ts, packages/quereus/src/func/builtins/scalar.ts, packages/quereus/test/optimizer/value-provenance.spec.ts, docs/change-scope.md, docs/plugins.md, docs/usage.md
----

# Complete: written-value provenance

First of three write-scope tickets. Ships an internal analysis module plus one registration option (`fresh`). The next ticket (`write-scope-analyzer`) calls the entry points from a memo on the DML executor node.

## What landed (`ticket(implement): write-scope-provenance`)

- `FunctionFlags.FRESH = 0x000400000`: "every call returns a value unique with ≥128 bits of entropy, regardless of arguments". The registrant promises this; the engine does not check it.
- A `fresh?: boolean` option on `ScalarFuncOptions` (resolved by `scalarFunctionFlags`) and on `db.createScalarFunction`. It sets FRESH and clears DETERMINISTIC. Combining it with `deterministic: true` throws `MisuseError`.
- `planner/analysis/non-det-functions.ts`: `classifyNonDetFunction(name)`, moved out of `change-scope.ts`. Both analyzers now use this one mapping.
- `planner/analysis/value-provenance.ts`: the `ValueProvenance` / `WrittenColumn` types, `classifyExpression`, `FRESH_PRESERVING_WRAPPERS`, the `randomblob(n ≥ 16)` rule, and the entry points `classifyInsertColumns`, `classifyUpdateColumns`, and `classifyUpsertUpdateColumns`.
- Docs: `docs/change-scope.md` § Written-value provenance, `docs/plugins.md` § Fresh scalar functions, and option bullets under `docs/usage.md` § User-Defined Functions.

Departures the implementer flagged, all accepted by review:
- The classifier looks through `WriteCoercionNode` and `CollateNode`.
- The context-variable spec case was reshaped because VALUES cells cannot read context variables.
- A generated-column recompute resolves through any earlier assignment.
- A volatile call combines with its arguments.
- Multi-row VALUES stays `fresh` only when every row calls the same fresh function.
- Upsert DO UPDATE does not bind context variables. The probe confirmed the DO UPDATE scope rejects them ("Column not found").

## Review findings

Read the implement diff first, then the handoff. Probed edge cases with a scratch spec (since deleted) that built plans and printed classifications. Ran `yarn lint` in `packages/quereus`: clean. Ran `yarn workspace @quereus/quereus test`: 10,794 passing, 25 pending, 0 failing.

### Fixed in this pass

- **Lossy blob→text conversions kept `fresh` (soundness defect).** `util/value-text.ts` decodes a blob to text non-fatally, so invalid UTF-8 bytes become U+FFFD and different random blobs can render as the same text. Even so, `cast(randomblob(16) as text)`, `randomblob(16) || 'x'`, `lower(randomblob(16))` and `randomblob(16)` written into a `text` column were all classified `fresh`. A host trusting that label would treat values that can collide as unique.
  - The fix is `wrapperKeepsFresh`. `hex` stays injective over every operand (listed in the new `FRESH_PRESERVING_WRAPPERS.blobSafeFunctions`). `lower`, `upper` and `||` now require an operand whose static type is not a blob.
  - `cast` and the write conversion go through `conversionKeepsFresh`, which allows only identity, untyped (`ANY`) sources or targets, text→TEXT, and text/blob→BLOB.
  - Spec rows added: `cast(... as text)` → `other`, `cast(... as blob)` → `fresh`, and a blob written to a text column → `other`.
- **`literal.value` was the as-written form, not the stored form; UPDATE assignments skipped the write conversion entirely.** `'1'` into an integer column reported `'1'`, although the write stores `1`. So two writes of the same key spelled `'1'` and `1` looked different to a conflict predictor.
  - UPDATE and DO UPDATE assignments carry no `WriteCoercionNode`, because the executor converts them itself (`runtime/emit/update.ts`, `runtime/emit/dml-executor.ts`). So the classifier ignored that conversion completely, including for the fresh-blob case above.
  - Fixed with `afterWriteConversion`, which applies `buildCellCoercion` (the conversion the runtime uses) to a literal, and is used for the insert-path coercion node and every assignment. Generated recomputes therefore read post-conversion provenance, as the runtime does.
  - If the conversion rejects a literal, the result is `literal` with no `value`, plus a debug log (the statement raises the same mismatch when it runs).
  - `classifyUpsertUpdateColumns` now takes the target `TableSchema`, needed for column types: `(clause, table, insertColumns)`. The call in `tickets/implement/2-write-scope-analyzer.md` is updated to match.
  - Spec rows added for both the INSERT and the UPDATE arm. Docs (`change-scope.md`, `plugins.md`) are updated to the stored-value contract and the blob rule.

### Tripwires parked

- An untyped fresh function (no `returnType`, which includes everything registered through `db.createScalarFunction`) that returns a blob and is written to a text column stays `fresh`, although the decode is lossy. Parked as a `NOTE:` on `conversionKeepsFresh`. `docs/plugins.md` now tells registrants to declare `returnType`.
- `lower` / `upper` are injective only over single-case text. This was already parked by the implementer as a `NOTE:` on `FRESH_PRESERVING_WRAPPERS`; left as is.

### Checked, no change

- **Registration.** `db.createScalarFunction` forwards both `flags` and `fresh`, and `scalarFunctionFlags` clears DETERMINISTIC even from explicit flags. `fresh` + `replicable` is harmless: `replicable` matters only for a deterministic function (`schema/function.ts`). The FRESH bit does not collide with existing flags.
- **UPDATE has no FROM clause.** The UPDATE source's attributes are exactly the table columns (`building/update.ts`), so mapping by index to `self` is sound.
- **Upsert generated recomputes** bind the existing-row attributes (`appendGeneratedRecomputes`), which matches `selfAttributeColumns`.
- **Known conservative gaps** are left as documented. The handoff and the doc section both cover them: non-projection SELECT tops (`order by`, `limit`) classify `other`, `randomblob` is matched by name, and multi-source view-insert / FROM-position DML classify `other`. A multi-row VALUES `('1'), (1)` into an integer column loses its `value` because rows are joined before conversion. That is conservative (no wrong value is reported) and needs no ticket.
- **Tests.** Every implementer row pins one behaviour of the specification at the classifier layer. None restates the implementation or verifies a mock, so none were cut. Three rows were added, each reproducing a defect fixed above.
- **Source hygiene.** `value-provenance.ts` is about 490 lines of small single-purpose functions, and its comments explain why rather than narrate. `change-scope.ts` shrank. No new size debt.

No tickets filed: both defects were fixed inline, and nothing else met the filing bar.
