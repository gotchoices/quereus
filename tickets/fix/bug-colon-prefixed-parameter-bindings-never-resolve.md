description: Binding a named query parameter using the colon spelling the query itself uses — `bind(":name", value)` — makes the query fail at run time saying that parameter was never bound, even though the documentation shows exactly that call.
architecture: docs/usage.md
files:
  - packages/quereus/src/core/statement.ts (`bind`, `bindAll`, the constructor's value branch, `validateParameterTypes`)
  - packages/quereus/src/core/param.ts (`boundKeyToParamKey`, `getParameterTypes` bare-key precedence)
  - packages/quereus/src/runtime/emit/parameter.ts (the lookup that fails)
  - docs/usage.md (documents the broken spelling)
  - packages/quereus/test/parameter-types.spec.ts, packages/quereus/test/parameter-array-scalar.spec.ts
repro: verified
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

Reproduced on `main` at c31a295c6 against a memory-backed database, for all three ingress points — `stmt.bind(':p', 9)`, `stmt.bindAll({ ':p': 9 })`, and `db.get('select :p as v', { ':p': 9 })`. The bare spellings (`'p'`) all work. So the colon form — the form the SQL text itself uses, and the form the documentation shows — is the one that fails.

It is *partially* masked: if an object binds **both** spellings of one name (`{ needle: null, ':needle': [1, 2] }`) the bare key satisfies the lookup and the run succeeds, which is why the existing test that exercises a `:`-prefixed key passes. No test executes a statement whose parameter is bound **only** under the colon spelling.

This predates the parameter-typing work; nothing in `parameter-types-frozen-before-first-bind` caused or touched it.

## Why

`Statement.boundArgs` stores whatever key the caller used, verbatim: `bind`/`bindAll`/the constructor all write `boundArgs[key]` with no normalization. Three readers then disagree about what key names a parameter:

- the runtime parameter emitter (`runtime/emit/parameter.ts`) strips a leading `:` **from the plan's identifier** and looks that bare name up in `boundArgs` — so it can only ever find a bare key;
- `getParameterTypes` (`core/param.ts`) strips the `:` **from the bound key**, so it types the parameter correctly whichever spelling was used — which is why `getColumnDefs()` announces the right type for a statement that then fails to execute;
- `validateParameterTypes` looks up the bare key and *falls back* to `':' + key`, a third rule.

The root cause is one site: the key is never normalized where the binding is **born**. Everything downstream then compensates differently, and one of the compensations is missing.

## What we want

Binding a parameter under `:name`, `name`, or (for a positional slot) `1`/`'1'`/`':1'` should all name the same parameter, at every reader: the plan's type, the bind-time validation, and the run-time value lookup. A caller should not have to know which spelling a given engine surface prefers, and the documented examples in `docs/usage.md` should work as written.

Normalizing at ingress — `core/param.ts` already exports `boundKeyToParamKey` for exactly this mapping — makes the divergence unrepresentable rather than adding a fourth compensation, and lets the two existing compensations (`getParameterTypes`' bare-key precedence rule, `validateParameterTypes`' `':' + key` fallback) be deleted.

## The decision this needs

Normalizing at ingress collapses `{ needle: null, ':needle': [1, 2] }` onto a single key, so the fix has to settle what that object means. The engine currently has an accidental answer (bare wins, for types and validation; bare wins at run time because it is the only key the emitter looks for), and one existing test — `parameter-array-scalar.spec.ts`, "honors a null bare binding rather than the `:`-prefixed alternate" — pins it. The candidates:

- **Bare wins**, preserving today's behavior and that test.
- **Last one wins**, the plain JavaScript object-merge reading, which changes that test.
- **Reject the collision** at bind time as a misuse error, which is the only option that cannot silently discard a value the caller passed.

Pick one and say so in the docs; do not leave it implicit.

## Scope notes

- A separate, smaller looseness lives at the same site: `{ '1': x, ':01': y }` normalizes both to the positional slot `1`. Whatever rule the collision decision picks should cover it too.
- `docs/usage.md`'s `stmt.bind` / `stmt.bindAll` examples stay as they are — they describe the intended contract, and the fix is what makes them true. Update them only if the collision decision changes what they should say.
