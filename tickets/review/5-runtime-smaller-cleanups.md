----
description: A batch of small runtime cleanups landed — dead code and a no-op GC hook removed, a wasteful dedup structure and type-safety escape hatches replaced, a mis-timed diagnostic fixed, and formatting normalized; two heavier items were spun off.
files: packages/quereus/src/runtime/emitters.ts, packages/quereus/src/runtime/utils.ts, packages/quereus/src/runtime/scheduler.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/module.ts, docs/module-authoring.md
difficulty: medium
----
Low-severity runtime cleanup bundle from the code review. Six items landed; three were deferred (two spun into backlog tickets, one delegated to an in-flight fix ticket). Build, lint, and the full logic-test suite are green.

## What landed

**1. Dead `shadowName` module hook removed** (`vtab/module.ts`, `docs/module-authoring.md`)
- Deleted the `shadowName?(name): boolean` hook from `VirtualTableModule` — it was marked "UNWIRED / DEAD" and is never called anywhere in the engine. Confirmed zero call sites (`.shadowName(` / `shadowName?(`) before removal.
- Removed its three references in `docs/module-authoring.md` (the signaling-style table row, the surface-inventory row, and the "`shadowName` is unwired" note).
- The local `const shadowName = ...` variables in `runtime/emit/alter-table.ts` are a *different, live* thing (rekey shadow-table names) — left untouched.

**2. No-op `global.gc()` / `cleanupUnreferencedLayers` removed** (`vtab/memory/layer/manager.ts`)
- `cleanupUnreferencedLayers()` only logged a debug line and, if `--expose-gc` was set, called `global.gc()` on the commit/collapse path. Removed the whole method and its single call site (`void this.cleanupUnreferencedLayers()` inside `collapseLayers`); kept the surrounding `logger.operation('Collapse Layers', ...)`.

**3. Multi-seek dedup: full BTree → `Set<string>`** (`vtab/memory/layer/scan-layer.ts`)
- The `IN (v1, v2, …)` multi-seek path allocated an entire `inheritree` `BTree` purely as a seen-set to dedup yielded rows by primary key. Replaced with a `Set<string>` keyed by the lossless, type-aware, collation-independent PK encoding already used elsewhere (`createPrimaryKeyFunctions(schema).encode`, from `vtab/memory/utils/primary-key-encode.ts`). Membership is all this path needs — ordered iteration of the seen-set was never used. Dropped the now-unused `BTree` import and `primaryKeyComparator` destructure in that block.

**4. Context-leak diagnostic re-timed** (`runtime/scheduler.ts`)
- `Scheduler.run()` checked `ctx.context.size` / `ctx.tableContexts.size` *synchronously* right after computing `result`. But a program's result is usually an unconsumed `Promise`/`AsyncIterable`, and row/table slots open and close *during* iteration — so the check fired before any leak could occur (false positives / missed real leaks). Moved the check into a new `checkContextLeaksOnSettle()` that runs it after a `Promise` settles or an `AsyncIterable` drains (sync results checked inline). The whole thing is now gated behind `contextLog.enabled`, so production/normal test runs pay nothing and the previous per-run size comparison is off the hot path.

**5. File-wide `eslint-disable no-explicit-any` removed** (`runtime/emitters.ts`, `runtime/utils.ts`)
- `utils.ts`: the only `any` was a `.catch((e: any) =>)` → `unknown`.
- `emitters.ts`: `instrumentRunForTracing` typed its wrapper `...args: any[]` / `result: any`; replaced with `RuntimeValue[]` / `OutputValue`, using `isAsyncIterable<Row>` narrowing and a typed `PromiseLike` duck-check (behavior-preserving — did not switch to `instanceof Promise` there). `validatedRun`'s `...args: any[]` → `RuntimeValue[]`.
- Both file-wide disable comments deleted. These two files' `any`s were unrelated to the `run as InstructionRun` casts — see deferred item below.

**6. Mixed tabs/spaces normalized** (`runtime/emit/scan.ts`)
- The file mixed 2-space and tab indentation. Rewrote with tabs throughout per `.editorconfig`. Pure whitespace change — no logic touched.

## What was deferred (and why)

- **AND/OR short-circuit** → `tickets/backlog/feat-and-or-short-circuit.md`. This is a real perf feature, not a cleanup. The review said "emit callback-style as CASE does," but I found CASE does **not** actually short-circuit today either (it has a `// TODO` and eager params). Building it needs callback emission, an async `run` path, a cost heuristic, and full 3VL truth-table tests. Filed as `feat-`.
- **Generic `Instruction<TArgs>`** (the 68 `run as InstructionRun` casts across 56 files) → `tickets/backlog/debt-instruction-generic-args.md`. A naive generic does **not** remove the casts — function-parameter contravariance blocks assigning `Instruction<[SqlValue,SqlValue]>` to the general `Instruction<RuntimeValue[]>` the scheduler holds. This is a genuine structural refactor touching 56 files; details/obstacle written up in the ticket.
- **~60 duplicated lines in `scan-layer.ts`** → delegated to `tickets/fix/1-runtime-scan-async-generator-stack.md`. That ticket restructures the same primary/secondary scan branches (sync generators, `yield*` delegation) and explicitly claims it "may subsume" this dedup. Per the original ticket's coordination note, the dedup should land once in whichever ticket touches the file last — that's the async-generator fix, which is a deeper rework of exactly those branches. Left as-is here; my item-3 change is at the top of the file (multi-seek block) and does not touch the duplicated region.

## Validation performed
- `yarn workspace @quereus/quereus run build` → exit 0 (src typecheck clean).
- `yarn workspace @quereus/quereus run lint` → exit 0 (eslint + test-file tsc; no new lint errors from removing the file-wide disables).
- `yarn workspace @quereus/quereus run test` → **6479 passing, 9 pending**, exit 0.

## Review focus / known gaps (treat tests as a floor)
- **No new tests were added.** The changes are covered indirectly by the existing 6479-test suite. Reviewer should decide whether the multi-seek dedup (item 3) and the re-timed diagnostic (item 4) warrant dedicated tests:
  - Multi-seek dedup: existing SQL-logic coverage exercises `IN (…)` with duplicate/NOCASE-variant keys, but there is no test *named* for the seen-set behavior. A targeted `select ... where pk in (5, 5)` / composite-PK / NOCASE-variant dedup assertion would lock it in. The encoder itself is well-tested (`test/vtab/memory-index-pk-value-identity.spec.ts`).
  - Context-leak diagnostic (item 4): it is **debug-only** (`contextLog.enabled`), so the normal test run never exercises the new deferred/wrapped path. If you want confidence, run a query with `DEBUG=quereus:runtime:context` and confirm the leak message now fires *after* iteration, and that wrapping an async-iterable result doesn't perturb output. Low risk (gated off by default) but genuinely unexercised by CI.
- **Item 3 (`createPrimaryKeyFunctions` per scan):** it is called once per multi-seek scan (not per row), same as `TransactionLayer.getPkExtractorsAndComparators` already does internally — negligible. Verify the sourcing of `primaryKeyExtractorFromRow` is unchanged (still from `layer.getPkExtractorsAndComparators`), which it is.
- **Item 5 (emitters.ts typing):** the tracing wrapper (`instrumentRunForTracing`) only runs when `ctx.tracePlanStack` is set. The `isAsyncIterable<Row>` narrowing and `PromiseLike` duck-check are behavior-preserving vs the old `any` code, but confirm the traced path (plan-stack tracing enabled) still pops the stack correctly for async-iterable and promise results.
