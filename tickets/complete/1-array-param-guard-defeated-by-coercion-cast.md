description: A safety check that rejects binding a JavaScript array to a query parameter compared against an ordinary single value had stopped firing on most code paths, so those queries returned no rows instead of a clear error. It now fires everywhere.
architecture: docs/types-parameters.md
files:
  - packages/quereus/src/planner/nodes/scalar.ts (`CastNode` — new `synthetic` flag)
  - packages/quereus/src/planner/building/coercion.ts (`wrapInCast` — passes `synthetic: true`)
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts (`unwrapSyntheticCasts`, `isScalarCounterpart`; review added a `NOTE:` tripwire)
  - packages/quereus/src/planner/nodes/set-operation-node.ts (review: `NOTE:` at the other planner-minted cast site)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts (NOTE only — no behavior change)
  - packages/quereus/test/parameter-array-scalar.spec.ts (spec runs on both entry points; review added 5 cases)
  - docs/types-parameters.md, docs/types.md (§ Special Types — JSON comparison)
----
# Array-valued scalar parameter guard now reads through plan-build coercion casts

## What changed

`CastNode` gained a fourth constructor parameter, `synthetic: boolean = false`, preserved by `withChildren`. It marks a cast the planner minted itself to reconcile a comparison's operand types, as opposed to a `cast(x as t)` the user wrote. `wrapInCast` (`planner/building/coercion.ts`) — the single mint site shared by `insertCrossTypeCoercion`, `coerceComparisonSet` and `coerceComparisonGroup` — passes `true`; every other construction site is unchanged and therefore still `false`.

`isScalarCounterpart` (`planner/analysis/scalar-param-usage.ts`) now unwraps synthetic casts (new `unwrapSyntheticCasts` helper) before reading the physical type, so it sees the counterpart's own type rather than the type the coercion imposed on it. That is the whole fix: with a JSON-typed parameter, `id = ?` is built as `cast(id as json) = ?`, and reading the cast made the guard conclude the counterpart was not scalar and stay silent.

`constraint-extractor.ts` got a `NOTE:` comment only — its `unwrapCast` / `unwrapCastForBindingKind` pair still re-derives types (value-preserving vs converting is the property it needs; a user-written cast can be just as no-op). No call site there changed.

## Observed behavior, before and after

Measured with `select * from t where id = ?` over `t(id integer primary key, name text)`, bound to `[[1, 2]]`:

| entry point | before | after |
| --- | --- | --- |
| `db.eval(sql, [[1, 2]])` | throws `MISMATCH` | throws `MISMATCH` |
| `db.prepare(sql, [[1, 2]]).all()` | `[]`, silently | throws `MISMATCH` |
| `db.get(sql, [[1, 2]])` | `undefined`, silently | throws `MISMATCH` |
| `db.eval(sql, [[1, 2]], { readConcurrency: 'committed' })` | `[]`, silently | throws `MISMATCH` |

The error text is unchanged: `parameter ?1 bound to an array/object value but used in a scalar comparison`, `StatusCode.MISMATCH`.

## Review findings

Reviewed the implement diff first, then the surrounding modules. Ran probes against a live database for every behavioral claim below; "measured" means a query was executed and its result recorded, including one run with the fix temporarily neutered to establish the before-state.

### Found and fixed in this pass

**The fix is one-way, and it changes one more behavior than the handoff recorded.** `crossTypeCoercion` only ever coerces the *non-object* side up to the object type, never the reverse, so unwrapping can only turn a counterpart from OBJECT into scalar — strictly more firing, never less. That means the whole over-fire surface is the counterparts that were previously hidden behind a coercion cast, and one of them is real: `textcol = :p` with an array-bound `:p`. On a type-inferring path the planner builds it as `cast(textcol as json) = :p`, which **would** have matched a row whose text is that array's JSON source — measured: `select id from jt where doc = :p` with `{p: [1,2,3]}` over a text column holding `'[1,2,3]'` returned row 1 before this change on `db.prepare`, and throws `MISMATCH` after. It is not a regression to undo: `db.eval` plans `:p` as ANY, mints no coercion, and threw on that same query before the change too, so the fix made the two entry points agree rather than diverge, and `cast(doc as json) = :p` is the spelling that opts in on both. But the guard's stated premise ("such a binding could never match") is now slightly pessimistic, `docs/types.md` § Special Types separately promises that the JSON coercion converts the non-object side of *any* comparison, and neither document said which wins. Fixed by stating it: a `NOTE:` tripwire at `unwrapSyntheticCasts` carrying the reasoning and the revisit condition ("only if the typed and untyped paths stop needing to agree"), a sentence in `docs/types-parameters.md`, and a reciprocal sentence in `docs/types.md` so the two no longer contradict. Pinned by a new spec case on both paths.

**The `db.eval(sql, params, options)` gap the handoff left open.** Measured: it throws `MISMATCH` — the fix does cover it. Added one targeted case rather than a fourth `paths` entry, because the property that distinguishes an entry point in this spec is only whether the plan knows the parameter's type, which options-carrying `eval` shares with `db.prepare`; replaying all 17 cases through it would have discriminated nothing. The reason is written into the spec so the asymmetry does not read as an oversight.

**No test asserted the `synthetic` flag itself.** This matters more than the handoff's "covered transitively" suggests: nothing re-derives the flag (types cannot distinguish a synthetic `cast(id as json)` from a user-written one — neither is a no-op), so a future `withChildren` edit that dropped the fourth argument would silently disable the guard on every typed path while every end-to-end case above still passed on the unrebuilt plan. Added two unit cases: `wrapInCast` sets it and a directly-constructed `CastNode` does not; `withChildren` preserves it in both states.

**`set-operation-node.ts` mints a `CastNode` too, without the flag.** Confirmed harmless — that cast wraps a column reference inside a branch's projection, so it reaches a comparison only as the set operation's output attribute, never as a `CastNode` counterpart. But the name `synthetic` reads broader than its meaning ("minted to reconcile a *comparison's* operands"), and the next person to add "planner minted this" there would silently widen what the guard unwraps. Added a `NOTE:` at that site saying it is deliberately not flagged, and why.

### Filed

**`tickets/backlog/debt-array-param-guard-misses-case-and-nullif.md`.** `collectScalarRequiredParams` decides what counts as a comparison from its own list — `BinaryOpNode`, `BetweenNode`, `InNode` — which is a second enumeration beside the one `planner/building/coercion.ts` documents as the single place every comparison-shaped construct meets. They have already drifted: coercion covers simple `CASE` and the builtins declaring `comparesArgs`, the guard covers neither. Measured, on both entry points with `[[1, 2]]`: `select case id when ? then 1 else 0 end` returns `0` for every row and `select nullif(id, ?)` returns the ids unchanged, both silently. Filed at the invariant rather than as two `instanceof` arms — the point is that the two lists must not drift, and the next comparison-shaped construct would be missed the same way. Pre-existing scope (the implement change touched which *types* the guard reads, not which constructs it walks), and the handoff flagged it as the natural next question without filing; `severity: edge-case` because the silent answers are defensible under storage-class semantics — it is the diagnosis that is missing, not the result.

### Checked, nothing found

- **Could a synthetic cast be lost or gained between plan-build and the guard?** No: `collectScalarRequiredParams` runs on `rawPlan` in `Statement.compile()` *before* `optimizer.optimize`, so CSE has not run. Worth noting because `expression-fingerprint.ts` keys a cast on target name and operand only — a synthetic and a user-written `cast(x as json)` fingerprint identically — which would matter if the guard ever moved after optimization. It does not, and the runtime value is the same either way, so there is nothing to fix today.
- **Other unwrap flavors.** `paramOperand` (all casts), `unwrapSyntheticCasts` (synthetic only), `constraint-extractor.ts`'s `unwrapCast` / `unwrapCastForBindingKind` (no-op casts only), `rule-sargable-range-rewrite.ts` (one level). Four different predicates for four different questions, and the implement pass documented the relationship between the closest pair. Not duplication.
- **Over-fire sweep on the shapes the new unwrap reaches.** Measured as correct: `jsoncol = ?` array-bound (no coercion, no fire), `jsoncol = ?` string-bound (param side wrapped, counterpart still JSON, no fire), `? = ?` with one array and one integer (fires on the array only, which is right), `? = ?` both arrays (no fire), numeric-vs-textual coercion (both sides scalar either way, so unwrapping changes nothing). Also measured still-firing: join `ON` conditions, `DELETE … WHERE`, and `IN (subquery)`.
- **Docs the change should have touched.** `docs/types-parameters.md` was updated by the implement pass and is accurate; `docs/types.md` needed the reciprocal sentence and now has it. `planner/analysis/README.md` lists neither `scalar-param-usage.ts` nor `binary-operator-class.ts`, but that whole file is already claimed by `debt-planner-analysis-readme-stale`, so it is not re-reported here.
- **Source hygiene.** `scalar-param-usage.ts` 122 → 134 lines, `coercion.ts` 110, `parameter-array-scalar.spec.ts` 210 → 257. No file near the size threshold, no narrating comments added — the new comments state constraints and revisit conditions, not what the statements do.
- **The `{ needle: null, ':needle': [1, 2] }` case the handoff asked a reviewer to rule on.** Not filed. The root cause is `getParameterTypes` treating `name` and `:name` as colliding keys, which is already named in the `files:` of the in-flight `2-parameter-types-frozen-before-first-bind` ticket — the site is claimed, and the spec already carries the explanation of why that case stays `db.eval`-only.
- **Nothing was found in error handling, resource cleanup or type safety.** The change adds no allocation, no async work and no new failure mode; `synthetic` is a plain `boolean` with one writer, and the added loop runs at plan-build time only.

## Validation run

- `yarn workspace @quereus/quereus run test` — 10461 passing, 25 pending, 0 failing (was 10456 passing; the 5 new cases are this pass').
- `yarn lint` — clean across all workspaces.
- Targeted: `parameter-array-scalar.spec.ts` — 40 passing.
