description: Binding a query parameter using the colon spelling the query itself uses — `bind(":name", value)` — used to fail at run time saying that parameter was never bound. Parameter keys are now settled on one spelling the moment a value is bound, so every later reader agrees. Reviewed; two reachable defects of a shared root class found and fixed, no follow-ups filed.
architecture: docs/usage.md
files:
  - packages/quereus/src/core/param.ts (`normalizeBoundParams`, `boundKeyToParamKey`, new `emptyBoundParams`)
  - packages/quereus/src/core/statement.ts (constructor value branch, `bind`, `bindAll`, `validateParameterTypes`, bound-args resets)
  - packages/quereus/src/core/database.ts (`_executeSingleStatement`)
  - packages/quereus/src/planner/analysis/change-scope.ts (`bindParameters`)
  - packages/quereus/src/runtime/emit/parameter.ts (the run-time value lookup)
  - packages/quereus/src/parser/lexer.ts (`KEYWORDS`)
  - packages/quereus/test/parameter-key-spellings.spec.ts, packages/quereus/test/parser.spec.ts
  - docs/usage.md, docs/types-parameters.md, docs/change-scope.md
----

# Complete: one spelling per parameter, settled at ingress

## What shipped

A parameter used to keep whatever key spelling the caller wrote all the way down, and five readers each guessed differently at which spellings named the same parameter. So `stmt.bind(':name', v)` — the spelling `docs/usage.md` itself used — type-checked and validated fine and then died at run time with `Parameter with name 'name' not found`, and `getChangeScope({':p': v})` failed *silently*, leaving `:p` in `unboundParameters` so a watcher watched the whole table.

`core/param.ts` now owns the decision. `normalizeBoundParams(params, label)` turns a caller's array or object into the record every downstream reader consumes: one key per parameter via `boundKeyToParamKey`, one canonical JS value form via `canonicalizeSqlValue`, `isSqlValue` checked while iterating the caller's original entries so a rejection names the spelling they wrote. `boundKeyToParamKey` strips a leading `$` as well as `:`, matching the parser (`parser.ts` matches `COLON, DOLLAR` and keeps only the bare lexeme). `@` is deliberately not stripped — the lexer has no `@` token, so `@p` can never be referenced from SQL.

All five ingresses route through it: the `Statement` constructor's value branch (so `db.prepare(sql, params)` / `db.get` / `db.eval`), `Statement.bindAll`, `Database._executeSingleStatement` (`db.exec`, normalized *before* `_buildPlan` so planning and runtime see the same keys), and `bindParameters` in `change-scope.ts`. `Statement.bind` takes the single-key form directly, and its `>= 1` index check now runs after normalization so `bind(':0')` raises the same `RangeError` as `bind(0)`.

Four compensating hacks are gone, which was the point: `getParameterTypes`' bare-key-wins line, `validateParameterTypes`' `':' + key` fallback, `bindParameters`' own strip plus two-way lookup, and the runtime emitter's `:`-strip.

Three deliberate behavior changes came with it, all of them judged and kept on review: `db.prepare(sql, params)` now validates values with `isSqlValue` (it did not before); a rejected `bindAll` leaves the previous bindings in place rather than clearing them; and `bindParameters`, which is exported from `index.ts`, now rejects a non-`SqlValue` or a duplicate-spelling object instead of ignoring what it could not resolve.

The review then found and fixed two more defects — both real, both reachable, both the same root class — described below.

## Review findings

Reviewed the implement diff (`bcf2544ed`) first, then the handoff. Lint, typecheck and the full test suite were run at the end; all green.

### Fixed in this pass

**A parameter named after an `Object.prototype` member resolved to a JavaScript function instead of erroring.** Bound args were a plain `{}` and the run-time lookup asked `identifier in params`, so `select :toString as v` with nothing bound returned `Object.prototype.toString` — a function — as the value of `v`, with no error. Verified by running it. Pre-existing rather than introduced (the old emitter used `in` too), but this ticket created the single chokepoint where it can be retired at the source, so it was fixed here rather than filed.

Fixed at the representation, not per reader: `emptyBoundParams()` in `core/param.ts` returns an `Object.create(null)` record, and every bound-args map now starts from it — `normalizeBoundParams`, `Statement`'s field initializer, `clearBindings`, `finalize`, and `Database._executeSingleStatement`'s empty case. `runtime/emit/parameter.ts` additionally moved from `in` to `Object.hasOwn`, because several run sites still build their `RuntimeContext` by hand with a plain `{}` (`const-evaluator`, `deferred-constraint-queue`, the materialized-view paths) and those are outside this ticket's reach. Tests added to `parameter-key-spellings.spec.ts`: each of `toString`, `constructor`, `valueOf`, `hasOwnProperty` is reported unbound when unbound and resolves when bound, through `db.get`, `db.exec` and `getChangeScope`.

**The lexer rejected `constructor` and `__proto__` as identifiers.** Found while writing the test above. `lexer.ts` classifies identifiers with `KEYWORDS[text.toLowerCase()] || TokenType.IDENTIFIER`, and `KEYWORDS` was a plain object literal, so those two names — the only two whose lowercase form is an `Object.prototype` member — came back as inherited functions, which are truthy. `create table t (id integer primary key, constructor integer)` failed to parse with "Expected column name.", and `select 1 as constructor` with "Expected identifier or string after 'AS'." Verified both.

Outside this ticket's subsystem, but the same root class as the finding above and a one-line representation fix, so it was fixed rather than filed: `KEYWORDS` is now built on `Object.create(null)`. Note that `emit/ast-stringify.ts` already guarded its own read of this table with `Object.hasOwn` — the class was known at one site and not retired. Tests added to `parser.spec.ts` pinning both names as a column reference, a parameter name and a column definition.

**Documentation.** `docs/usage.md` listed the positional spellings as `1`, `'1'`, `':1'` but omitted `'$1'`, which the implement ticket's own test asserts works. Corrected.

**Comment hygiene.** The `getParameterTypes` comment had grown to eight lines stacked over one line of code, the new paragraph partly restating the old. Trimmed to the part that says something the code cannot.

### Checked and found sound

- **Key normalization is genuinely single-sourced.** Every reader of a bound key now goes through `boundKeyToParamKey` or reads an already-normalized record; grepped for `boundArgs`, `normalizeParamKey`, `boundKeyToParamKey` and `.params` across `packages/quereus/src` and found no sixth rule.
- **The `$` claim is true.** `parser.ts:1942` matches `TokenType.COLON, TokenType.DOLLAR` and keeps only the following lexeme, so `:p` and `$p` are the same parameter in SQL as well as in bindings. `ParameterScope` keys by the bare name.
- **The dead code the ticket deleted really was dead.** The emitter's `:`-strip: all three `ParameterReferenceNode` construction sites produce bare keys.
- **The test matrix is the contract it claims to be.** 151 cases crossing every spelling with every ingress, plus collision rejection at every object-shaped ingress and a `getChangeScope` block for the arm that used to fail silently. I could not name a binding surface it omits.
- **Odd-but-legal key edges are inert, as the handoff says.** `{ '$': v }` normalizes to the empty-string key and `{ '-1': v }` stays `'-1'`; neither names anything the parser can produce, so the binding is unusable but the referenced parameter then reports unbound with a clear error. Confirmed rather than taken on trust.

### Considered and not changed

- **`normalizeBoundParams` is labelled `'prepare'` from the `Statement` constructor**, so a collision passed to `db.get` reports `prepare: parameter 'p' bound twice`. Slightly off, but the constructor does not know its caller and the message still names the real problem. Cosmetic; left alone.
- **`hasUntypedBinding` re-runs `boundKeyToParamKey` over keys that are already normalized.** Only `normalizeParamKey` is needed there now. The difference is unreachable — a bare name from SQL cannot start with `:` or `$` — so the change would be diff noise, not a fix.
- **`db.exec` re-normalizes its parameters once per statement in a multi-statement batch.** The old code canonicalized per statement too, and the work is proportional to the parameter count, so this is not a regression and not a magnitude worth measuring.

### Not filed, and why

No tickets were filed. Both defects found were fixable inline at their root site, and neither leaves a residue: the null-prototype representation retires the bound-args class outright, and the `Object.hasOwn` at the emitter covers the hand-built `RuntimeContext` literals that the representation fix cannot reach. Those literals remain hand-assembled, which is already tracked by `tickets/backlog/debt-runtime-context-built-by-hand-at-every-run-site.md` — a different root cause, deliberately not folded in. No tripwires were recorded: nothing found was conditional-on-a-future-change rather than either wrong now or fine now.

## Validation

- `yarn lint` (repo-wide fan-out) — clean.
- `tsc --noEmit -p packages/quereus/tsconfig.json` — clean.
- `yarn test` (full workspace fan-out, 4m52s) — clean.
- `yarn workspace @quereus/quereus run test` — 10640 passing, 25 pending, 0 failing.
- `yarn test:store` (the LevelDB store path) was **not** run. Nothing in this change touches storage, and the run does not fit an agent's wall-clock budget; the claim is reasoned, not measured. Carried over unchanged from the implement handoff.
