description: CREATE TABLE now refuses a CHECK rule or computed column that calls a function which does not exist, calls a real one with the wrong number of arguments, reads from an unknown table function, or uses an aggregate like sum() directly on the row — all of which used to be accepted and then made every write to the table fail.
architecture: docs/determinism.md#validation-timing
files:
  - packages/quereus/src/schema/declaration-calls.ts   # findUnbuildableCall, resolveCallSchema, isQueryBoundary
  - packages/quereus/src/schema/manager.ts   # rejectUnbuildableCalls, validateCheckConstraintDeterminism, validateGeneratedColumnDeterminism, findNonDeterministicCall
  - packages/quereus/test/logic/44-determinism-validation.sqllogic   # Test 9
  - docs/determinism.md   # § Validation Timing
repro: verified
----

# Unknown function in a CHECK or generated column is refused at CREATE TABLE

## Summary

`SchemaManager.createTable`'s CHECK and `GENERATED ALWAYS AS` gates run a resolution walk (`findUnbuildableCall` in `schema/declaration-calls.ts`) before the determinism walk, in both `nondeterministic_schema` modes. It rejects the first call the write-time build is certain to refuse, worded as the builder words it and prefixed with the site (`CHECK constraint '<c>' on table '<t>' is invalid: …` / `GENERATED ALWAYS AS for column '<c>' in table '<t>' is invalid: …`):

- a plain call with no registry entry by name + argument count (falling back to a variadic entry) — mirrors `resolveFunctionSchema`;
- a window call naming no registered window function (its inner call is not looked up as a plain function);
- an aggregate call outside every subquery (the body is evaluated per row; the CHECK and generated builds pass `allowAggregates = false`);
- (added in review) a subquery's `from f(…)` naming no registered table-valued function, or a non-table-valued one — mirrors `buildTableFunctionCall`, the single builder path for `functionSource` nodes.

Table references are never inspected, so a CHECK subquery naming a table created later still declares and writes. Catalog reload never reaches these gates. A `NOTE:` on `rejectUnbuildableCalls` records the quereus-sync replay exposure (a peer missing a plugin function refuses the replicated CREATE TABLE — same as DEFAULT already).

Landed in `ticket(implement): bug-unknown-function-not-caught-at-declaration` plus the review edits below.

## Review findings

**Checked**

- Builder parity, by reading `planner/building/function-call.ts`, `schema-resolution.ts`, `expression.ts` (`windowFunction` case), `table-function.ts`, `select.ts` (`functionSource` dispatch), `constraint-builder.ts` and `generated-column-scope.ts` (both build with `allowAggregates` defaulting to false): every refusal the walk raises is one the write-time build raises identically, so no false positives from the plain/window/aggregate arms. The parser's only synthesized `function` node (`->` / `->>` desugaring to `json_extract`) resolves.
- Traversal: `traverseAst` is pre-order and visits a `windowFunction`'s `function` child right after the parent, so the `windowCalls` set is populated before the inner call is seen; window arguments are still walked as plain calls. `return false` skips `exitNode`, but only after `found` is set, so the depth counter cannot drift on a path that matters.
- CTE-bodied CHECK subqueries (`07.8.2` `with c as (…) select max(x) from c`) stay inside a `select` boundary, so their aggregates are not flagged; full suite confirms.
- Docs: `docs/determinism.md` § Validation Timing reflects the new rule; `docs/sql-ddl.md`, `docs/architecture.md` (Determinism Enforcement) and `docs/schema.md` make no claim the change contradicts.
- Error handling / type safety: errors carry the call's line/column; the AST casts follow the existing visitor pattern. Hygiene: the new logic lives in its own 100-line module rather than growing `manager.ts`.

**Found and fixed in this pass (minor)**

- Unknown table-valued function in a CHECK/generated subquery's FROM (the implementer's flagged gap) still reached first write. Same class, same site, single builder path — added a `functionSource` arm (`checkTableFunctionSource`) and widened `UnbuildableCall.node`; `resolveCallSchema` now takes `(name, argCount)` so both node kinds share it. Pinned by one statement (`t_unknown_tvf`).
- The fix ticket asked for a positive case proving a forward table reference is still accepted if none existed; none did (the implementer probed it by hand only). Added `t_fwd_check`, which also covers a window function and an aggregate inside a subquery — the two branches of the walk that must *not* reject.
- `docs/determinism.md` CHECK bullet updated for the table-valued-function arm.

**Tests reviewed**

- The implementer's five Test 9 statements each pin a distinct branch (CHECK gate, generated gate, arity inside a subquery, row-level aggregate, mode independence) — kept.

**Not fixed — left as recorded (no ticket)**

- Window-call argument count and `requiresOrderBy` are not checked, only the name. A window call is legitimate only inside a CHECK subquery, so a wrong-arity one there is contrived; not ticketed, as noted by the implementer.
- A table-valued function used in scalar position (`check (json_each(a) is null)`) is not refused at declaration; the builder's handling of that shape is its own question, not a resolution miss. Not filed — contrived.
- The generated-column gate still does not reject bind parameters (pre-existing, not introduced here; `docs/determinism.md` "walked the same way" overstates that one point). Outside this ticket's site; no ticket filed by implement or review — recorded here only.

**Tripwires / accepted tradeoffs**

- None new. The sync-replay exposure is already recorded as a `NOTE:` on `rejectUnbuildableCalls`.

## Validation

- `yarn workspace @quereus/quereus test` — 11187 passing, 23 pending (new statements live inside the existing `44-determinism-validation` logic test).
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn test:store` not run: the change is in `createTable`'s authoring gates, which the store path shares unchanged, and reload does not reach them.
