description: Let a virtual-table module that opts in receive, with every row it is asked to write, the description of the statement performing the write — so a module that queues writes for later can decide at staging time whether another writer could make the queued write fail.
prereq: write-scope-analyzer
architecture: docs/change-scope.md
files: packages/quereus/src/vtab/table.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/planner/analysis/write-scope.ts, packages/quereus-isolation/src/isolated-table.ts, docs/module-authoring.md, docs/write-scope.md, packages/quereus/test/vtab/write-scope-hook.spec.ts (new)
difficulty: medium
----

Third of three tickets. The statement-level `WriteScope` exists and each `DmlExecutorNode` carries a memoized `WriteSiteAnalysis` producing its `TableWrite`. This ticket hands that `TableWrite` to the module.

## Why a field on `UpdateArgs`, not a connection callback

The request left the choice open between a field on `UpdateArgs` and a per-statement callback on the connection. The field wins:

- It is the shape the module already has for the closest existing feature: `wantStatements` / `UpdateArgs.mutationStatement` (docs/module-authoring.md § Mutation Statements). A module author learns one opt-in pattern.
- The module needs the description *at the row*, where it stages the write; a per-statement callback would make the module correlate statements with rows itself, and a connection need not exist for a module that does not implement transactions.
- It costs nothing when unused: the analysis is memoized on the plan node and only read when the table opts in, and one `TableWrite` object is attached to every row of one execution.

## Surface

- `VirtualTable.wantWriteScope?: boolean` — opt-in, declared next to `wantStatements`.
- `UpdateArgs.writeScope?: TableWrite` — the write site's description with the statement's bound parameters substituted into its selection values and read watches (a per-write `bindTableWrite(write, params)` applied with `ctx.params`; add it beside `bindWriteParameters`, which should delegate to it), so the module sees literal key values. The same object for every row of one execution; modules must treat it as read-only shared data.

Executor plumbing (`runtime/emit/dml-executor.ts`): where the executor resolves `vtab` for the statement, compute once per execution `const writeScope = vtab.wantWriteScope ? bindTableWrite(plan.writeSite?.analyze(ctx.db), ctx.params) : undefined` and attach it to the `UpdateArgs` at every `vtab.update(...)` call the executor makes for the statement's own write: the insert, update and delete row paths, and the upsert DO UPDATE path (which performs an `update` on the conflicting row — pass the same `TableWrite`; its `disposition.clauses` already describes the arm).

Engine-internal writes the executor issues as *consequences* of the statement — FK cascades, lens-routed parent-side writes, REPLACE displacement handled inside the module — carry no `writeScope` (leave the field unset). Say so in the doc; leave a `NOTE:` at the cascade site naming the revisit condition (a module that queues cascaded writes offline and needs them described).

## Edge cases & interactions

- **Opt-in false or absent** — no analysis runs; `writeScope` is absent. Verified by the spec's negative case (the capturing table records that the field is `undefined`).
- **Same object across rows** — a multi-row insert hands every row the same `TableWrite` reference. One `strictEqual` between two captured rows.
- **Parameters bound** — `update … set v = :v where id = :id` executed with params: `selection.values` the module sees is the literal id, not a placeholder. Spec case.
- **`db.exec` path (no `Statement`)** — the executor reads the memo from the plan node, not from `ctx.stmt`, so a transient exec statement is described too. Spec case runs one write through `db.exec` and one through a prepared statement.
- **Isolation overlay** — `packages/quereus-isolation` wraps a module's table; `IsolatedTable.update` spreads the incoming args into the overlay write, so `writeScope` reaches the *overlay* during staging but is not carried to the underlying module at flush (the flush path builds fresh `UpdateArgs`), exactly as `mutationStatement` is not. `IsolatedTable` must expose `wantWriteScope` mirroring the underlying table so the executor computes the scope when the wrapped module asked for it — check how (or whether) it mirrors `wantStatements` today (nothing in that package references `wantStatements` at the time of writing) and treat the two alike. The flush-time gap is parked in `tickets/backlog/feat-isolation-forwards-write-scope-at-flush.md`; do not solve it here.
- **Memo absent** — a `DmlExecutorNode` constructed without a `writeSite` (none should exist after the analyzer ticket, but the parameter is optional) yields no `writeScope`; never throw at the row.
- **Replay / mutation statements** — unaffected; `mutationStatement` and `writeScope` are independent fields.

## Documentation

`docs/module-authoring.md`: a `## Write scope` section after `## Mutation Statements` — the opt-in, the field, the shared-object rule, what is and is not described (consequence writes), and a short example of the intended decision ("fresh id and no natural key → cannot fail; parameter-sourced unique column → may fail"). Add the module-facing paragraph to `docs/write-scope.md` as well so the contract doc is complete on its own.

## Tests

One spec, `test/vtab/write-scope-hook.spec.ts`, with a minimal in-memory `VirtualTable` subclass (model it on `test/runtime/counting-vtab.ts`) that sets `wantWriteScope = true` and records `args.writeScope` per `update()` call, covering the cases above. It pins the hook's contract at the module boundary, which no other layer exercises.

## TODO

- Add `wantWriteScope` to `VirtualTable` and `writeScope` to `UpdateArgs`; add `bindTableWrite`.
- Compute once per execution in the executor and attach at the statement's own write sites; leave consequence writes unset with a `NOTE:`.
- Mirror the opt-in on `IsolatedTable`.
- Write the spec; run `yarn test` from the repo root (the isolation package's tests must still pass) and `yarn lint`.
- Document in `docs/module-authoring.md` and `docs/write-scope.md`.
