description: A query run with values supplied at execution time used to be planned as if those values' types were unknown, so a comparison between a text column and a number quietly returned no rows. Each parameter's type is now taken from the first value bound to it, whenever that happens, and every way of running a query gives the same answer.
architecture: docs/types-parameters.md
files:
  - packages/quereus/src/core/statement.ts (`establishParameterTypes`, `hasUntypedBinding`, `dropStalePlanOnBind`, `invalidatePlan`, the constructor, `compile`, `bind`, `bindAll`, `nextStatement`, `getAnalysisPlan`)
  - packages/quereus/src/core/database.ts (`_evalGenerator`)
  - packages/quereus/src/core/param.ts (`boundKeyToParamKey`, `getParameterTypes` bare-key precedence)
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts (comment only)
  - packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/parameter-array-scalar.spec.ts, packages/quereus/test/property.spec.ts
  - docs/types-parameters.md, docs/usage.md
----
# Parameter types are established from the first value bound to each parameter

## What shipped

`Statement.compile()` used to freeze `parameterTypes` from `getParameterTypes(this.boundArgs)` on the first compile. With nothing bound that call returns an **empty Map**, not `undefined` — an established map with no entries — so every parameter stayed at `ANY` for the statement's whole life and values bound afterwards never reached the planner. Every entry point that introspects (`getColumnNames()`, `getColumnDefs()`, `isQuery()`) before binding landed there, and a cross-type comparison such as `where text_col = ?` bound to a number silently matched nothing.

The shape after implement + review:

- **`Statement.establishParameterTypes()` is the single place types come from.** It records a type only for a parameter that has none yet, so "nothing bound yet" can never masquerade as "typed, and there are none", and a parameter first bound *after* the plan was built still gets its type. A parameter that already has one keeps it — the frozen contract `validateParameterTypes` checks.
- **`dropStalePlanOnBind()`** (called from `bind`/`bindAll`) discards the cached plan when a bind gives a value to a parameter that plan had no type for. That covers both the "compiled before any bind" case and the "compiled while only some parameters were bound" case with one rule.
- **An explicit hint map handed to `prepare()` is CLOSED** — never extended, never validated against for parameters it does not name. `parameterTypesDeclared` makes that explicit. `InternalStatementCache` depends on it: it prepares FK probes with an *empty* map precisely to get an affinity-neutral plan and no bind-time validation, so one cached probe can be rebound to an integer key on one row and a text key on the next.
- **`invalidatePlan()`** is the one invalidation set (`needsCompile`, `plan`, `emissionContext`, `scheduler`, `columnDefCache`), shared by the schema-change listener, `nextStatement()` and the stale-plan drop.
- **`getAnalysisPlan()`** (the `getChangeScope()` path) had the same bug and goes through the shared helper too.
- **`Database._evalGenerator`** prepares with `params` (and builds the multi-statement branch's last `Statement` with them), then passes `undefined` downstream so values are not rebound and re-validated.
- **`getParameterTypes`** skips a `:name` entry when the bare `name` key is also present, matching the precedence `validateParameterTypes`' scalar-guard lookup already uses; the shared `boundKeyToParamKey` maps a bound key to the parameter it names.

## Deliberate behaviour change

**`select ? = ?` (and `<`) with one numeric and one textual operand now answers differently.** Parameters are typed, so the planner mints the comparison-site coercion from `types/comparison-coercion.ts`: the text side converts to NUMERIC/REAL, and text that names no number lenient-casts to `0`. So `db.eval('select ? = ?', ['!', 0])` is now **true** where it was false.

This makes the parameterised spelling agree with the literal one — `db.get("select ('!' = 0) as r")` has always returned `true`. The property test was encoding the defect, not the rule; `property.spec.ts` Numeric Affinity now excludes numeric-vs-textual pairs from its storage-class oracle and pins them instead against the literal spelling over five hand-picked pairs.

## Validation

`yarn test` from the repo root: **all workspaces green**, `@quereus/quereus` at 10471 passing / 25 pending / 0 failing. `yarn lint` clean (eslint plus the `tsconfig.test.json` type pass). No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Review findings

Read the implement diff (`c31a295c6`) cold before the handoff summary, then read every touched file and `core/internal-statement-cache.ts`, `runtime/emit/parameter.ts` and `types/comparison-coercion.ts` around it.

### Fixed in this pass

- **The freeze-from-emptiness defect was still reachable through an empty parameter collection at `prepare()`.** The constructor inferred types a *second* time, inline, bypassing the new helper's non-empty rule, so `db.prepare(sql, [])` — the shape a `function run(sql, params = [])` wrapper produces — established an empty-but-frozen map and pinned every later-bound parameter at `ANY`. Verified before the fix: `db.prepare('select k from t where v = ?', []).all([5])` returned `[]` against a row that matches. Fixed by deleting the duplicate inference and routing the constructor through `establishParameterTypes()`.
- **The same wrong answer through partial binding.** `stmt.bind('x', 5); stmt.getColumnDefs(); stmt.bind('y', 7)` compiled with only `:x` typed, and `:y` then stayed `ANY` for life — `[]` instead of `[{k: 1}]`, verified. The implement-stage `planTypesProvisional` flag could not see this: the plan was not provisional, it was *partial*. Replaced the flag with `hasUntypedBinding()`, which asks the question that actually matters (does some bound value belong to a parameter this plan had no type for), and which subsumes the provisional case.
- **Explicit hint maps had to be exempted.** The first cut extended every map, which broke `InternalStatementCache`'s empty-map contract and failed `fk-restrict-runtime.spec.ts`. `parameterTypesDeclared` now marks a caller's map closed, and the reason is documented at the field, at `docs/types-parameters.md`, and at both guard sites — it is load-bearing and was previously implicit.
- **`nextStatement()` threw away a caller's explicit hint map** when advancing a batch. It now keeps a declared map (given for the prepared text as a whole) and clears only inferred types (which described the statement left behind).
- **DRY:** two copies of the bound-key → parameter-key normalization (`getParameterTypes`, and the new staleness check) collapsed into `boundKeyToParamKey` in `core/param.ts`.
- **Docs:** `docs/types-parameters.md` and `docs/usage.md` still described the implement-stage model ("the first binding source", one provisional plan). Rewritten to per-parameter establishment, with the empty-collection case and the closed-hint-map exception spelled out. The `scalar-param-usage.ts` and `parameter-array-scalar.spec.ts` comments the implementer rewrote were re-read against the new behaviour and are correct.

### Tests added

Four cases in `parameter-types.spec.ts`, plus a ninth entry point in the cross-entry-point parity table (`db.prepare(sql, []).all(params)`):

- a second parameter bound after an introspecting compile still gets its type;
- a parameter bound after preparing with an empty array *or* empty object gets its type;
- an already-typed parameter stays frozen while a newly bound one is typed (announced types go `['INTEGER', 'ANY']` → `['INTEGER', 'TEXT']`, and rebinding the first to a REAL is still a mismatch);
- `getChangeScope()` before any bind does not poison the executed plan — the gap the implementer flagged as untested.

**Negative controls, run deliberately.** Stubbing `dropStalePlanOnBind` to return immediately fails 7 tests including all four new ones. Deleting only the type-map extension arm fails the two partial-binding tests. Neither new test is vacuous.

### Filed

- `tickets/fix/bug-colon-prefixed-parameter-bindings-never-resolve.md` — **pre-existing**, unrelated to this diff, found while checking the `:name`-vs-`name` precedence rule the diff added. `stmt.bind(':name', v)`, `stmt.bindAll({':id': 1})` and `db.get(sql, {':p': 9})` all throw `Parameter with name 'p' not found.` at run time: bound keys are stored with the caller's spelling and never normalized, and the runtime emitter only ever looks for the bare name. `docs/usage.md` documents both broken spellings. It is masked wherever an object binds *both* spellings, which is why the one existing `:`-prefixed test passes. Root cause is one site (the bind ingress), and the ticket climbs to it rather than patching a fourth reader; it also carries the design decision the fix needs (what `{name: x, ':name': y}` means).
- `tickets/backlog/debt-oversized-source-files.md` — appended `core/statement.ts` as an arm: **1,170 lines** (`wc -l`, 2026-09-24; 1,136 before this review, 1,063 before the implement ticket), past the ~1,000-line threshold that ticket already argues, with the three separable concerns named. Evidence for an existing theme, not a new ticket.

### Parked as tripwires

- **The extra compile on the committed-read route.** `tryRouteConcurrent()` compiles to decide eligibility *before* params are bound, so `stmt.all(params, {readConcurrency: 'committed'})` pays that compile plus `getColumnNames()`'s before the real one. Harmless — eligibility comes from the node kinds in the tree and column names from the projection, neither of which reads parameter types — so it is a cost, not a defect. Folded into the existing `NOTE:` on `dropStalePlanOnBind`, which already carried the `all(params)`/`get(params)` case and the fix if it ever shows up in a profile.

### Checked, nothing found

- **Resource cleanup.** `invalidatePlan()` covers every member whose validity is the plan's; the schema-change listener is unsubscribed before every recompile and on `finalize()`, so the extra invalidations this change adds leak no listeners. `workCounters` is deliberately outside the set — its plan shape is captured at execution time, so a recompile cannot mispair it.
- **Concurrency / re-entrancy.** `bind`, `bindAll`, `clearBindings`, `reset` and `nextStatement` all refuse while `busy`, so no invalidation can run under a live cursor.
- **Error handling.** The diff adds no `catch`, swallows nothing, and changes no error path; `compile()`'s existing wrap-and-rethrow is untouched.
- **The property-test exclusion is precise.** `coercesAtComparison` mirrors `crossTypeCoercion`'s numeric-vs-textual arm exactly: `BOOLEAN_TYPE` declares neither `isNumeric` nor `isTextual`, so a generated boolean takes no coercion and stays under the storage-class oracle, and the arbitrary generates no BLOBs.

### Known gaps, honestly

- **No timing benchmark.** The filing consumer reported a storage module falling back to a full scan (250-400 ms vs 10-58 ms) because it would not seek on a parameter whose plan-time type it could not trust. What is now verified is the *premise*, not the timing: `db.prepare(sql, [5])` and `db.prepare(sql)` + introspect + `bindAll([5])` serialize to the same plan tree, differing only in monotonic attribute ids. Whether the seek is chosen in that consumer is untested here, and no benchmark was run — a wall-clock benchmark of that shape is not agent-runnable inside a ticket.
- **"At most one extra compile per late-typed parameter" is reasoned from the code, not profiled.** `prepared-statement-amortization.spec.ts` passes unchanged, which pins the no-extra-compile case (all parameters bound before the first plan) but not the count in the late-typed case.
- **The `{'1': x, ':01': y}` key collision is still open** — both normalize onto positional slot 1 with last-one-wins. Not reachable from any documented usage; carried as a scope note on the filed `:`-prefix ticket, whose fix has to settle collisions anyway.
