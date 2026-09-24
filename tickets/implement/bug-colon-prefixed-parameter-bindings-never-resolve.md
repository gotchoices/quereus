description: Binding a named query parameter using the colon spelling the query itself uses — `bind(":name", value)` — makes the query fail at run time saying that parameter was never bound, even though the documentation shows exactly that call. Fix is to settle on one spelling the moment a value is bound, so every later reader agrees.
architecture: docs/usage.md
files:
  - packages/quereus/src/core/param.ts (`boundKeyToParamKey`, `normalizeParamKey`, `getParameterTypes` — home of the new shared ingress helper)
  - packages/quereus/src/core/statement.ts (constructor value branch ~line 151, `bind` ~line 399, `bindAll` ~line 420, `validateParameterTypes` ~line 1035, `getChangeScope` ~line 1110)
  - packages/quereus/src/core/database.ts (`_executeSingleStatement` bound-args build ~line 930 — the fourth ingress)
  - packages/quereus/src/planner/analysis/change-scope.ts (`bindParameters` ~line 981 — the fifth reader, with its own lenient lookup)
  - packages/quereus/src/runtime/emit/parameter.ts (the failing lookup; its own `:`-strip is dead code)
  - packages/quereus/src/planner/scopes/param.ts, packages/quereus/src/planner/resolve.ts (where the plan-side key is produced — read-only, for reference)
  - packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/parameter-array-scalar.spec.ts (existing specs that must change)
  - docs/usage.md, docs/types-parameters.md, docs/change-scope.md
repro: verified
difficulty: medium
----
# A named parameter bound as `:name` is never found at run time

## What happens

`docs/usage.md` documents both of these:

```typescript
stmt.bind(":name", "John");
stmt.bindAll({ ":id": 1, ":name": "John" });
```

Both throw when the statement runs:

```
QuereusError: Parameter with name 'name' not found.
```

Reproduced on `main` at 6d63e733c against a memory-backed database. The bare spellings (`'p'`) all work; the colon form — the form the SQL text itself uses, and the form `docs/usage.md` shows throughout — is the one that fails.

The fix stage reproduced every ingress point, including two the original report did not name:

| entry point | `{ p: 9 }` | `{ ':p': 9 }` |
| --- | --- | --- |
| `stmt.bind(key, 9)` | works | `Parameter with name 'p' not found.` |
| `stmt.bindAll({...})` | works | same error |
| `db.get(sql, {...})` / `db.eval` / `db.prepare(sql, {...})` | works | same error |
| **`db.exec(sql, {...})`** | works | same error |
| **`stmt.getChangeScope({...})`** | substitutes the value | silently leaves it in `unboundParameters`, no error |

The `db.exec` arm matters because it is the documented way to run a parameterised `insert`; the `getChangeScope` arm matters more, because it does not throw — it just reports the parameter as unbound, so a caller watching a change scope watches the wrong (wider) thing and never learns.

It is *partially* masked: if an object binds **both** spellings of one name (`{ needle: null, ':needle': [1, 2] }`) the bare key satisfies the lookup and the run succeeds, which is why the one existing test that exercises a `:`-prefixed key passes. No test executes a statement whose parameter is bound **only** under the colon spelling.

This predates the parameter-typing work; nothing in `parameter-types-frozen-before-first-bind` caused or touched it.

## Why

`Statement.boundArgs` (and the equivalent map `Database._executeSingleStatement` builds for `exec`) stores whatever key the caller used, verbatim — every ingress writes `boundArgs[key]` with no normalization. Five readers downstream then each apply their own rule for what key names a parameter:

- **the runtime parameter emitter** (`runtime/emit/parameter.ts`) looks up `plan.nameOrIndex`, which the planner has already reduced to the bare name (`planner/resolve.ts` builds the symbol key `:${name}`, `planner/scopes/param.ts` strips it back off and runs it through `normalizeParamKey`). So the emitter can only ever find a bare key. Its own `startsWith(':')` strip is dead code — no producer of `nameOrIndex` ever emits a colon;
- **`getParameterTypes`** (`core/param.ts`) strips the `:` from the *bound* key, so it types the parameter correctly whichever spelling was used — which is why `getColumnDefs()` announces the right type for a statement that then fails to execute;
- **`validateParameterTypes`** (`core/statement.ts`) looks up the bare key and *falls back* to `':' + key` — a third rule;
- **`change-scope.ts`'s `bindParameters`** strips `:`/`@`/`$` from the *plan-side id* and then tries both that and the raw id against the caller's object — a fourth rule, and one that strips the wrong side: plan-side ids are already bare, so the strip is inert and the caller's `':p'` key is never found;
- **`hasUntypedBinding`** already routes through `boundKeyToParamKey`, so it is the only reader that is right by construction.

The root cause is one site: **the key is never normalized where the binding is born.** Everything downstream compensates differently, and two of the compensations are wrong.

## What we want

Binding a parameter under `:name`, `$name`, or `name` — or, for a positional slot, `1`, `'1'`, `':1'`, `':01'` — names the same parameter at *every* reader: the plan's parameter type, the bind-time validation, the run-time value lookup, and the change-scope substitution. A caller should not have to know which spelling a given engine surface prefers, and the documented examples in `docs/usage.md` should work as written.

`core/param.ts` already exports `boundKeyToParamKey` for exactly this mapping and `normalizeParamKey` for the positional half of it. Normalizing **at ingress** makes the divergence unrepresentable rather than adding a fifth compensation, and lets the existing ones be deleted.

## The decisions, and the defaults to implement

Normalizing at ingress collapses `{ needle: null, ':needle': [1, 2] }` onto one key, so the fix has to settle what such an object means. Implement the recommended default in each case unless you find a reason not to — if you deviate, say which and why in the review handoff.

### 1. A single object carrying two spellings of one parameter → `MisuseError`

**Recommended: reject it at bind time.** It is the only option that cannot silently discard a value the caller passed, it matches the other bind-time misuse checks already in `bindAll` (`isSqlValue`, `bind`'s `index >= 1`), and the alternatives are both weak:

- *Bare wins* preserves today's behavior, but that behavior is an accident — nobody chose it, it just fell out of the emitter only ever looking for a bare key.
- *Last one wins* reads naturally for an object literal but is not actually last-written: `Object.entries` emits integer-like keys first in ascending order regardless of source order, so `{ ':1': a, '1': b }` iterates `'1'` before `':1'` and "last" means the opposite of what the source says.

The error should name the parameter and both spellings, e.g. `bindAll: parameter 'p' bound twice, as 'p' and ':p'`.

Scope: **one object**, not a sequence of calls. Repeated `stmt.bind()` calls to the same parameter stay last-wins (`bind('p', 1); bind(':p', 2)` → `2`) — each call is a separate statement of intent and overwriting is exactly what a second `bind('p', …)` already does today. The collision check belongs to the object-shaped ingresses: `bindAll`, the `Statement` constructor / `db.prepare(sql, params)`, `_executeSingleStatement`, and `bindParameters`.

### 2. `$name` normalizes too; `@name` does not

The parser accepts `$name` as a synonym for `:name` (`parser.ts` ~line 1942 matches `COLON, DOLLAR` and keeps only the bare lexeme), so a caller writing `$p` in SQL will reasonably bind `'$p'`. **Recommended: `boundKeyToParamKey` strips a leading `:` or `$`**, and rule 1's collision check covers `{':p': …, '$p': …}` as well.

`@` is *not* a Quereus parameter prefix — the lexer has no `@` token — so `bindParameters`' existing `@` strip is stripping something that can never appear. Do not carry it forward: normalizing `'@p'` would promise a binding for SQL that cannot parse. Drop it, and treat `'@p'` as an ordinary (unreferenceable) name.

### 3. `bind(':0', v)` raises the same `RangeError` as `bind(0, v)`

`bind` already rejects a numeric index below 1. Once `':0'`/`'0'` normalize to the number `0`, applying that same check *after* normalization is what makes the two spellings agree. It does make `select :0 as v` unbindable — correct, since `?` indices are 1-based and `:0` names no slot.

## Where to normalize

One helper in `core/param.ts` — something like `normalizeBoundParams(params, label)` — returning `Record<string | number, SqlValue>`:

- array input → 1-based numeric keys (as all four sites already do);
- object input → `boundKeyToParamKey(key)` per entry, rejecting a collision per decision 1;
- values canonicalized via `canonicalizeSqlValue` (`util/numeric-canonical.ts`), which all four ingresses already do and must keep doing;
- value validation (`isSqlValue`) stays where it is or moves in — but the rejection message must name the **caller's** spelling, not the normalized key, so validate while iterating the original entries. `bindAll`'s all-or-nothing contract (validate every entry before assigning any) must survive: a rejected object leaves `boundArgs` untouched.

Apply it at the four ingresses — `Statement` constructor value branch, `Statement.bind` (string keys), `Statement.bindAll`, `Database._executeSingleStatement` — and at `bindParameters` in `change-scope.ts`, which is a public entry point in its own right (`docs/change-scope.md` shows callers invoking it directly).

Normalizing inside `_executeSingleStatement` **before** it calls `_buildPlan` also fixes the planning side for `exec`: `_buildProbeContext` passes raw params to `getParameterTypes` and stores them as `PlanningContext.parameters`, which becomes `BlockNode.parameters` (used only for debug output, `planner/nodes/block.ts:47`). The `Statement` path already reaches `_buildPlan` with a type `Map`, so it is unaffected.

## What gets deleted

Each of these exists only to paper over the un-normalized key. Removing them is the point of the ticket, not a bonus:

- `core/param.ts` — the bare-key precedence line in `getParameterTypes` (`if (key.startsWith(':') && Object.hasOwn(params, key.substring(1))) return;`) and its comment. Keep the `boundKeyToParamKey` call itself: it is idempotent on an already-normalized key and cheap insurance.
- `core/statement.ts` — `validateParameterTypes`' `':' + key` fallback, back to a plain `this.boundArgs[key]` lookup. (Note the surrounding comment explains the *presence* check that replaced a `??`; a bound `null` must still win over "missing". With one key there is nothing to fall through to, so a direct lookup is correct — but keep `undefined` meaning "not bound".)
- `change-scope.ts` — `bindParameters`' `:`/`@`/`$` strip and its two-way `key in obj` / `id in obj` lookup, replaced by a single lookup against the normalized map.
- `runtime/emit/parameter.ts` — the `identifier.startsWith(':')` strip. `nameOrIndex` comes from `ParameterScope` (already bare and `normalizeParamKey`-ed), from `planner/analysis/key-filter.ts` (`pk0`/`gk0`-style internal names), or from `rule-predicate-inference-equivalence.ts` (copied from another node's `nameOrIndex`). No producer emits a colon.

## Tests

The point of the fix is that a *class* of key spellings collapses, so lead with the generalized test, not a pile of instances.

- **A table-driven spelling × ingress matrix** in a new spec (e.g. `packages/quereus/test/parameter-key-spellings.spec.ts`): for the named case, every spelling of one parameter (`p`, `:p`, `$p`) crossed with every ingress (`db.prepare(sql, params)`, `db.get`, `db.eval`, `db.exec`, `stmt.bind`, `stmt.bindAll`, `stmt.all(params)`, `stmt.run(params)`, `stmt.getChangeScope(params)`) produces the same result; likewise for the positional case (`1`, `'1'`, `':1'`, `':01'`) against `select :1 as v` and `select ? as v`. This is the test that keeps a sixth reader from drifting back out.
- **Collision rejection**, for each object-shaped ingress and for both the named (`{p, ':p'}`) and positional (`{'1', ':01'}`) forms.
- **`getChangeScope` substitutes** under the colon spelling and reports an empty `unboundParameters` — the arm that fails silently today, so it needs its own assertion rather than riding on the matrix.
- `packages/quereus/test/parameter-array-scalar.spec.ts` — the `honors a null bare binding rather than the :-prefixed alternate` case (~line 258) pins today's accidental bare-wins rule. Under decision 1 it becomes a collision: rewrite it to assert the `MisuseError`, and keep a separate case asserting that a lone `{ needle: null }` still executes without tripping the array-valued-scalar guard (the real regression it was protecting).
- `packages/quereus/test/parameter-types.spec.ts` (~line 230) — `announces INTEGER for a ':'-prefixed named key` only checks the announced type, never executing. Extend it (or let the matrix cover execution) so the announce-vs-execute gap that hid this bug cannot reopen.

## Docs

- `docs/usage.md` — the `stmt.bind` / `stmt.bindAll` / `db.eval` / `stmt.get` examples stay as written; the fix is what makes them true. Add one short paragraph to the prepared-statement parameter section stating the contract: a named parameter may be bound as `:name`, `$name` or `name` and they are the same parameter; a positional slot as `1`, `'1'` or `':1'`; binding two spellings of one parameter in a single object is a `MisuseError`.
- `docs/types-parameters.md` uses the bare spelling in its named-parameter examples while `usage.md` uses the colon spelling. Leave both — but the new contract paragraph should be cross-referenced from here, since this file owns "how a parameter gets its value and type".
- `docs/change-scope.md` — note that `bindParameters` accepts the same spellings and enforces the same collision rule.

## Adjacent, not in scope

`tickets/backlog/debt-runtime-context-built-by-hand-at-every-run-site.md` covers the seven hand-assembled `RuntimeContext` literals, one of which is the `_executeSingleStatement` site touched here. Different root cause (context assembly, not key normalization) — don't fold them together, and don't wait on it.

## TODO

- Add `normalizeBoundParams` (keys via `boundKeyToParamKey`, values via `canonicalizeSqlValue`, collision → `MisuseError`) to `core/param.ts`; extend `boundKeyToParamKey` to strip a leading `$` as well as `:`.
- Route `Statement`'s constructor value branch, `bind` and `bindAll` through it; apply `bind`'s `>= 1` index check after normalization.
- Route `Database._executeSingleStatement` through it, before `_buildPlan`.
- Route `change-scope.ts`'s `bindParameters` through it; delete its `:`/`@`/`$` strip and dual lookup.
- Delete the three remaining compensations: `getParameterTypes`' bare-key precedence line, `validateParameterTypes`' `':' + key` fallback, and the emitter's `startsWith(':')` strip.
- Add the spelling × ingress matrix spec, the collision-rejection cases, and the `getChangeScope` substitution case.
- Update `parameter-array-scalar.spec.ts`'s null-bare-binding case to expect the collision error, keeping a lone-`{needle: null}` case for the guard it was protecting; extend `parameter-types.spec.ts`'s `:`-prefixed case to execute.
- Update `docs/usage.md`, `docs/types-parameters.md`, `docs/change-scope.md` with the spelling contract and the collision rule.
- Run `yarn workspace @quereus/quereus test` and `yarn lint` from the repo root.
