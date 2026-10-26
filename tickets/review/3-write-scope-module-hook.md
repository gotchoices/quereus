description: Review the opt-in that lets a virtual-table module receive, with every row it is asked to write, a description of the statement performing the write — so a module that queues writes can tell at staging time whether another writer could make the queued write fail.
prereq: write-scope-analyzer
architecture: docs/change-scope.md
files: packages/quereus/src/vtab/table.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/analysis/write-scope.ts, packages/quereus/src/planner/analysis/write-site-analysis.ts, packages/quereus/src/core/database.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/vtab/write-scope-hook.spec.ts, docs/write-scope.md, docs/module-authoring.md, docs/stability.md, docs/.stability.json, tickets/backlog/feat-isolation-forwards-write-scope-at-flush.md
----

Third of three write-scope tickets. The analyzer ticket gave every `DmlExecutorNode` a memoized `WriteSiteAnalysis`; this one hands that site's `TableWrite` to a module that asks for it.

## What landed

- **Surface (`vtab/table.ts`).** `VirtualTable.wantWriteScope?: boolean` (next to `wantStatements`) and `UpdateArgs.writeScope?: TableWrite`.
- **Binder (`write-scope.ts`).** `bindTableWrite(write, params)` was already the per-write half of `bindWriteParameters`; it is now exported (module-internal, not added to the package's public `index.ts` — a module receives the scope already bound).
- **Executor (`emit/dml-executor.ts`).** `resolveWriteScope(rctx, vtab)` runs once per execution in `runInsert` / `runUpdate` / `runDelete`, right after `getVTable`: `undefined` unless `vtab.wantWriteScope`, the node has a `writeSite`, and the write is not an FK cascade child; otherwise `bindTableWrite(writeSite.analyze(db).writes[0], rctx.params)`. The result is threaded as a parameter (never stored on the emit closure — per-execution state) into all four `vtab.update` sites: insert row, update row, delete row, and the upsert DO UPDATE arm (`executeUpsertUpdate`), which gets the INSERT's object.
- **Cascade suppression.** FK cascade child writes are nested statements (`db._internalStatementCache.run`, wrapped in `withFkCascadeReentry`), each with a write site of its own. The ticket asked that consequence writes carry no scope, so `resolveWriteScope` checks `db._isFkCascadeReentry()`. This covers physical and lens cascades (both use the wrapper). The `NOTE:` naming the revisit condition sits on `resolveWriteScope`, not at the cascade call sites — the decision lives there. `Database._setFkCascadeReentry`'s doc said "nothing inside Quereus reads it"; updated.
- **Isolation (`isolated-table.ts`).** Constructor now mirrors `wantStatements` and `wantWriteScope` from the underlying table (nothing mirrored `wantStatements` before — the ticket said treat them alike). Both now reach `IsolatedTable.update` → overlay write via the args spread, and neither reaches the underlying module at flush. Recorded in the backlog ticket `feat-isolation-forwards-write-scope-at-flush`.
- **Memo freeze NOTE (`write-site-analysis.ts`).** The analyzer left a NOTE saying the hook "must make sure the plan is rebuilt" when `foreign_keys` toggles. I did not add invalidation: the DML builders already bake `foreign_keys` into the plan's own FK checks (insert.ts / update.ts / delete.ts), and the option has no `onChange`, so the description is no staler than the enforcement it describes. Rewrote the NOTE to say so, with a revisit condition.
- **Docs.** `docs/write-scope.md § Module hook` (full contract + example decision function); `docs/module-authoring.md § Write scope` (short hub section — the full version pushed that doc over its 12000-word cap, so the example lives in write-scope.md). Also fixed a docs-gate failure already there at HEAD: `docs/write-scope.md` was missing from `docs/.stability.json` (added as Beta, matching its banner) and from the stability table in `docs/stability.md` (row added).

## Tests (`test/vtab/write-scope-hook.spec.ts`)

A `MemoryTableModule` subclass whose tables set `wantWriteScope` and record `args.writeScope` per `update()`. I used the memory module, not a bare `VirtualTable` as the ticket suggested, so the upsert case gets a real conflict report.

- **opt-in absent** → `writeScope` is `undefined`.
- **multi-row insert** → both rows get the same reference (`strictEqual`); `operation` and `table` are correct.
- **prepared update with named params** → `selection` is `rows` with the literal id `[[7]]`.
- **`db.exec` with positional params** (delete) → described, with the literal key bound.
- **upsert DO UPDATE** → the insert attempt and the arm's update share one object; `disposition.kind` is `upsert`.
- **FK cascade** → the parent delete is described and the cascaded child delete is not. Mutation check: removing the cascade guard makes this test fail.

Validation: `yarn test` (all workspaces, including the 439 isolation specs) passes, as do `yarn workspace @quereus/quereus run lint`, `yarn docs:check`, `tsc -b tsconfig.build.json` and the isolation typecheck. `yarn test:store` was not run.

## For the reviewer — known gaps / judgment calls

- **Cascade suppression vs. self-description.** The ticket assumed cascades are writes the executor issues directly. They are actually full nested statements that could describe themselves (e.g. `delete from child where pid = ?`, bound). I followed the ticket and suppressed them. Check that this is the contract you want — the alternative is deleting one condition.
- **Mirroring `wantStatements` on `IsolatedTable` changes behaviour.** For a wrapped table whose underlying module sets it, the executor now builds a mutation statement for every row, and the overlay throws it away. Nothing in-repo sets `wantStatements`, so no current cost.
- **No isolation-package test.** The mirroring is two constructor assignments (wiring), so it ships without a test.
- **Memo analysed lazily, on the first opted-in execution.** `foreign_keys` is therefore frozen at first use, not at plan build; the two can differ only if the option is toggled between prepare and the first run.
- **No public export of `bindTableWrite`.** Add it to `index.ts` if a host wants to bind one write itself.
- **`docs/module-authoring.md` sits close to its word cap** after this addition: `wc -w` gives 11894 now and 11683 at HEAD. The docs gate passes.
