description: Binding a query parameter using the colon spelling the query itself uses — `bind(":name", value)` — used to fail at run time saying that parameter was never bound. Parameter keys are now settled on one spelling the moment a value is bound, so every later reader agrees.
architecture: docs/usage.md
files:
  - packages/quereus/src/core/param.ts (new `normalizeBoundParams`; `boundKeyToParamKey` now strips `$` too; `getParameterTypes` bare-key precedence line deleted)
  - packages/quereus/src/core/statement.ts (constructor value branch, `bind`, `bindAll`, `validateParameterTypes`)
  - packages/quereus/src/core/database.ts (`_executeSingleStatement` — normalizes before `_buildPlan`)
  - packages/quereus/src/planner/analysis/change-scope.ts (`bindParameters` — own strip + dual lookup deleted)
  - packages/quereus/src/runtime/emit/parameter.ts (dead `:`-strip deleted)
  - packages/quereus/test/parameter-key-spellings.spec.ts (new, 151 cases)
  - packages/quereus/test/parameter-array-scalar.spec.ts, packages/quereus/test/parameter-types.spec.ts
  - docs/usage.md, docs/types-parameters.md, docs/change-scope.md
repro: verified
difficulty: medium
----
# Review: one spelling per parameter, settled at ingress

## What changed

`core/param.ts` gained `normalizeBoundParams(params, label)` — the single place a bound parameter key is now decided. It turns a caller's array or object into the `Record<string | number, SqlValue>` every downstream reader consumes: one key per parameter via `boundKeyToParamKey`, one canonical JS form per value via `canonicalizeSqlValue`, `isSqlValue` checked while iterating the caller's original entries so a rejection message names the spelling they wrote.

`boundKeyToParamKey` now strips a leading `$` as well as `:`, matching the parser (`parser.ts` matches `COLON, DOLLAR` and keeps only the bare lexeme). `@` is deliberately not stripped — the lexer has no `@` token, so `@p` can never be referenced from SQL.

All five ingresses route through it: the `Statement` constructor's value branch (so `db.prepare(sql, params)` / `db.get` / `db.eval`), `Statement.bindAll`, `Database._executeSingleStatement` (`db.exec`, normalized *before* `_buildPlan` so planning and runtime see the same keys), and `bindParameters` in `change-scope.ts`. `Statement.bind` takes the single-key form directly (`boundKeyToParamKey` on a string key) because a one-entry object can't collide and because the numeric branch must keep rejecting `bind(-1, …)`; its `>= 1` index check now runs **after** normalization, so `bind(':0')` raises the same `RangeError` as `bind(0)`.

Four compensations are gone, which was the point of the ticket:

- `getParameterTypes`' bare-key-wins line (`if (key.startsWith(':') && Object.hasOwn(...)) return;`)
- `validateParameterTypes`' `':' + key` fallback → a plain `this.boundArgs[key]` lookup (`undefined` still means "not bound"; a bound `null` still reads as `null`)
- `bindParameters`' `:`/`@`/`$` strip of the plan-side id and its two-way `key in obj` / `id in obj` lookup → one lookup against the normalized record
- the runtime emitter's `identifier.startsWith(':')` strip. Confirmed dead: the only three `new ParameterReferenceNode` sites produce bare keys (`ParameterScope` via `normalizeParamKey`, `key-filter.ts`'s `pk0`/`gk0` names, and `rule-predicate-inference-equivalence.ts` copying another node's `nameOrIndex`).

Decisions 1–3 from the implement ticket were implemented as recommended, with no deviations.

## Use cases to test / validate

The documented examples in `docs/usage.md` now work as written — that is the headline. Verified by hand against a memory-backed db:

```typescript
await db.exec('insert into users (id, name) values (:id, :name)', { ':id': 1, ':name': 'John' });
stmt.bind(':name', 'John');          // was: QuereusError: Parameter with name 'name' not found.
stmt.bindAll({ ':name': 'John' });   // same
await db.get('select :id as id, :name as name', { ':id': 1, ':name': 'John' });
```

What a reviewer should push on:

- **The matrix is the contract.** `test/parameter-key-spellings.spec.ts` crosses every spelling (`p`/`:p`/`$p`, and `[9]`/`{'1'}`/`{':1'}`/`{':01'}`) with every ingress (`db.prepare`, `db.get`, `db.eval`, `db.exec`, `stmt.bind`, `stmt.bindAll`, `stmt.all`, `stmt.run`), against both SQL spellings of each parameter form (`:p` and `$p`; `:1` and `?`). 151 cases, all passing. If you can think of a binding surface it omits, that surface is where the next regression lives.
- **Collision rejection.** `{ p: 1, ':p': 2 }`, `{ ':p': 1, '$p': 2 }`, `{ '1': 1, ':01': 2 }` each raise `MisuseError` ("parameter 'p' bound twice, as 'p' and ':p'") at every object-shaped ingress including `stmt.getChangeScope`. Repeated `stmt.bind()` calls to one parameter remain last-wins and are tested as such.
- **`getChangeScope` under the colon spelling** — the arm that used to fail *silently*, leaving the parameter in `unboundParameters` so a watcher watched the whole table. Its own describe block asserts substitution plus an empty `unboundParameters` for all seven spellings, named and positional.
- **`@p` is not a spelling of `p`.** Asserted: `db.get('select :p as v', { '@p': 9 })` still reports `:p` unbound.

Commands run, all green: `yarn test` (full workspace fan-out, 5m26s), `yarn lint` (repo-wide), `tsc --noEmit` on `packages/quereus`.

## Behavior changes worth a reviewer's judgement

Three changes go slightly beyond "make `:p` resolve", and each deserves a look:

- **`db.prepare(sql, params)` now validates values with `isSqlValue`.** It did not before — only `bind`/`bindAll` did. Consolidating validation into the shared helper is what the implement ticket meant by "value validation stays where it is or moves in", and nothing in the suite depended on the old laxity, but it is a new rejection at a public entry point. A caller who previously passed, say, a `Date` to `prepare` and got a silent misbehaviour now gets a `MisuseError` at prepare time.
- **A rejected `bindAll` now leaves the previous bindings in place** rather than clearing them. `bindAll` used to assign `this.boundArgs = {}` before validating, so a rejection wiped prior state. The ticket asked for "untouched"; there is a test pinning it. Anyone relying on the clear-on-reject behavior would notice.
- **`bindParameters` (public, exported from `index.ts`) now validates and rejects.** It previously ignored anything it could not resolve. It now throws `MisuseError` for a non-`SqlValue` or a duplicate-spelling object. Reasonable for a public entry point, but it is a new throw on a surface `docs/change-scope.md` invites callers to use directly.

## Known gaps

- **`yarn test:store` was not run** — the LevelDB store path. Nothing here touches storage, but the claim is "reasoned", not "measured".
- **Odd-but-legal key edges are undefined and untested.** `{ '$': v }` normalizes to the empty-string key; `{ '-1': v }` stays the string `'-1'`. Both were reachable before this change too and neither names anything a statement can reference, so they are inert — but the helper does not reject them either.
- **The docs cross-references are prose, not anchors.** `docs/types-parameters.md` and `docs/change-scope.md` point at "[Usage](usage.md) under the prepared-statement binding methods" rather than linking the `#### stmt.bindAll(...)` heading, whose generated anchor is unpleasant. If the repo has a convention for linking code-signature headings, these should follow it.
- **No test asserts the plan-side effect of normalizing `db.exec` before `_buildPlan`.** The matrix proves `db.exec(sql, {':p': 9})` runs and writes the right value, which requires the runtime lookup to agree; it does not separately assert that `BlockNode.parameters` (debug output only) carries normalized keys.
- **`normalizeBoundParams` is not exported from `index.ts`.** Internal-only by design — `bindParameters` is the public surface that uses it — but if plugin authors are expected to build bound-args maps, that is the seam they would want.

## Adjacent, untouched

`tickets/backlog/debt-runtime-context-built-by-hand-at-every-run-site.md` covers the hand-assembled `RuntimeContext` literals, one of which is the `_executeSingleStatement` site edited here. Different root cause; deliberately not folded in.
