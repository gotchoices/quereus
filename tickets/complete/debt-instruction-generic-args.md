description: The SQL runtime built each instruction by casting its run-function to shut the type checker up (86 casts across 58 files); those casts are now funneled through one small audited helper so the rest of the code is cast-free.
files: packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/*.ts, packages/quereus/src/func/builtins/mutation.ts, packages/quereus/src/func/builtins/json.ts, docs/runtime.md
----

## What was built

Added one audited cast helper `asRun` to `packages/quereus/src/runtime/types.ts`:

```ts
export function asRun(run: (ctx: RuntimeContext, ...args: never[]) => unknown): InstructionRun {
	return run as unknown as InstructionRun;
}
```

Every `X as InstructionRun` cast across 58 files became `asRun(X)`. After the
change, the **only** `as`-to-`InstructionRun` in the whole runtime is the single
line inside `asRun`. `InstructionRun` remains imported in exactly three emit
files (`dml-executor.ts`, `set-operation.ts`, `subquery.ts`), each for a
legitimate `let run: InstructionRun;` / `let runFunc: InstructionRun;`
declaration; the import was dropped everywhere else. `docs/runtime.md` emitter
example updated to show `run: asRun(run)` plus a paragraph explaining why the
wrap is needed and that `createValidatedInstruction` sites wrap the same way.

The helper was intentionally left **loose** (`(ctx, ...args: never[]) => unknown`)
rather than a tight generic, because ~8 run-functions have imprecise signatures
that a tight generic rejects; keeping it loose preserved the ticket's
zero-behavior-change / types-only mandate. See review findings for the trade-off
and the filed follow-up.

## Review findings

Adversarial pass over commit `1feaa7d8`. Scrutinized: mechanical-transform
correctness, import hygiene, the `asRun` design choice, the tricky branch/ternary
sites, docs accuracy, and full lint+test.

**Checked — clean:**

- **Mechanical transform (58 files).** Diffed every touched file. Every edit is a
  pure `X as InstructionRun` → `asRun(X)` plus an import swap — no behavior
  change. Confirmed the tricky sites read correctly: branch-assignment
  (`dml-executor.ts:1098`, `set-operation.ts:234`), ternary (`case.ts:82`),
  async-arrow wrap and dropped-redundant-cast (`subquery.ts:208-236, 239`),
  `createValidatedInstruction` run-arg sites (`scan.ts`, `cte-reference.ts`,
  envelope-scan, scalar-function, table-valued-function).
- **Cast centralization verified.** Grep confirms the *only* `as InstructionRun`
  (and the only `as unknown as InstructionRun`) in `src/` is `types.ts:88`, inside
  `asRun`. 85 real `asRun(...)` call sites.
- **Import hygiene.** `InstructionRun` no longer imported by any emit/func file
  except the 3 with a genuine `let` declaration (dml-executor, set-operation,
  subquery); `emitters.ts`/`types.ts` retain it legitimately (type def +
  `createValidatedInstruction` signature). `noUnusedLocals` passing corroborates.
- **Docs.** `docs/runtime.md` "Creating an Emitter" example now type-checks
  (previously showed a bare `run,` that would not) and explains the wrap + the
  `createValidatedInstruction` case. Accurate.
- **Validation.** From `packages/quereus/`: `yarn typecheck` EXIT 0, `yarn lint`
  EXIT 0, `yarn test` 6511 passing / 9 pending EXIT 0. Reproduced green.

**Found — filed as follow-up (major, non-blocking):**

- The `asRun` helper is deliberately loose: it checks only that the first arg is
  `RuntimeContext` and that a function was passed — **not** that params are
  `RuntimeValue`-shaped or the return is `OutputValue`-shaped. This is exactly as
  permissive as the raw casts it replaced (no regression) and honors the
  types-only mandate, but it means a future emitter could ship a genuinely wrong
  `run` signature undetected. The blocker to a tight generic is ~8 run-functions
  with imprecise annotations (nested `Promise<OutputValue>` in block/view-mutation;
  `Promise<SqlValue | undefined>` returning only `null` in create-index/create-table/
  drop-table/transaction; optional-callback tuple-inference break in the three
  joins). Verified two of these first-hand (block.ts, create-index.ts) — analysis
  is accurate. Filed `tickets/backlog/debt-tighten-asrun-run-signatures.md` to
  tighten those signatures and swap in the tight generic. Left in backlog (future
  hardening, not required for correctness) because it changes run-function type
  surfaces — outside this ticket's scope.

**Empty categories:**

- **Bugs / behavior changes:** none. The change is a pure cast-site rename;
  runtime behavior is untouched and the full suite is green.
- **Tripwires:** none beyond the filed follow-up — the loose-helper concern is
  concrete queued work (a refactor across ~10 files), not a conditional
  code-site note, so it belongs in a ticket rather than a `NOTE:` comment. The
  `asRun` JSDoc already documents the looseness at the site.
- **Resource cleanup / error handling / perf:** not applicable — no runtime paths
  added or altered.
