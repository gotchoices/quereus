----
description: A collection of small runtime cleanups — dead code, wasteful allocations, type-safety escape hatches, a diagnostic that never fires, and formatting nits — bundled into one low-priority pass.
files: packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts
difficulty: medium
----
Low-severity runtime items from the code review, grouped into one cleanup pass. Each bullet is independent; land what is safe and note anything that turns out to be non-trivial (spin it into its own ticket rather than forcing it here).

## TODO
- **AND/OR cannot short-circuit.** Boolean AND/OR eagerly evaluate both operands because parameters are evaluated up front; expensive scalar subqueries always run even when the first operand already decides the result. Emit non-trivial operands callback-style (as `CASE` already does) so the second operand is only evaluated when needed. Gate on operand cost so trivial operands keep the cheap eager path.
- **File-wide `eslint-disable no-explicit-any`.** `emitters.ts` and `utils.ts` disable the no-`any` lint for the whole file. Replace the blanket disables with properly typed code (see the `InstructionRun` item below); if a genuinely unavoidable `any` remains, scope the disable to that single line with a justifying comment.
- **`run as InstructionRun` casts everywhere.** These casts pervade the emit layer because `Instruction` is not generic over its argument tuple. Make `Instruction<TArgs>` generic so the run function's argument types flow through and the casts disappear. (This is the structural fix that lets the `no-explicit-any` disables go.)
- **Dead `shadowName`.** Marked "UNWIRED / DEAD" in the source — remove it and any now-unreferenced supporting code.
- **No-op `cleanupUnreferencedLayers` calling `global.gc()`.** This runs `global.gc()` on a production code path (a no-op unless Node was started with `--expose-gc`, and undesirable in production regardless). Remove the `global.gc()` call; if the function is otherwise a no-op, remove it and its call sites.
- **Multi-seek dedup allocates a full BTree as a seen-set.** A multi-seek dedup uses an entire BTree just to track already-seen keys. Replace with a lighter structure appropriate to the key type (e.g. a `Set` of encoded keys) unless ordered iteration of the seen-set is actually required.
- **Context-leak diagnostic checks too early.** A diagnostic meant to catch context leaks runs its check before async execution has completed, so it can never observe the leaks it exists for. Either move the check to after execution settles so it can actually fire, or remove it if it cannot be made meaningful.
- **Mixed tabs/spaces in `emit/scan.ts`.** Normalize to tabs per `.editorconfig`.
- **~60 duplicated lines in `scan-layer.ts`.** De-duplicate. Note: the scan-async-generator ticket restructures this same file and may subsume this — coordinate so the dedup lands once, in whichever ticket touches it last.
- Run lint and the logic-test suite after the pass.
