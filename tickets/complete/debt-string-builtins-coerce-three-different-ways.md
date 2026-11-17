description: Every text function (upper, substr, trim, replace, …) now turns a non-text argument into text the same way `cast(x as text)` does: a function declares which arguments are text and the query planner inserts the conversion, instead of each function guessing on its own.
prereq: builtin-results-announce-honest-nullability
files:
  - packages/quereus/src/schema/function.ts                # `textArgs` on ScalarFunctionSchema
  - packages/quereus/src/func/registration.ts              # ScalarFuncOptions.textArgs + pass-through
  - packages/quereus/src/planner/building/coercion.ts      # coerceTextArgs; wrapInCast gains `synthetic` param
  - packages/quereus/src/planner/building/function-call.ts # calls coerceTextArgs before inference
  - packages/quereus/src/types/comparison-coercion.ts      # doc note: comparisonGroupIndices also resolves textArgs
  - packages/quereus/src/func/builtins/string.ts           # declarations + valueToText in implementations
  - packages/quereus/src/util/value-text.ts                # doc comment
  - packages/quereus/test/string-text-args.spec.ts         # NEW property test
  - packages/quereus/test/logic/03.6.2-value-to-text.sqllogic
  - packages/quereus/test/logic/101-builtin-mutation-kills.sqllogic
  - packages/quereus/test/announced-result-types.spec.ts
  - packages/quereus/test/runtime/scalar-fusion.spec.ts
  - packages/quereus/test/documentation.spec.ts
  - docs/functions.md, docs/sql-functions.md, docs/types.md, docs/plugins.md
----

# String builtins read text arguments through `cast(x as text)`

## What was built

- **`textArgs?: 'all' | readonly number[]`** on `ScalarFunctionSchema` (moved there from `BaseFunctionSchema` in review), and on `ScalarFuncOptions`, passed through by `createScalarFunction`. A hand-built schema given to `Database.registerFunction` carries it directly.
- **`coerceTextArgs(scope, textArgs, args)`** in `planner/building/coercion.ts`: resolves positions with `comparisonGroupIndices` (out-of-range positions dropped) and wraps each argument whose static physical type is not TEXT in a **non-synthetic** `CastNode` to TEXT. Non-synthetic means it behaves exactly like a user-written `cast(x as text)`: runtime uses `lenientCast` (not `comparandConverter`), analyses do not look through it, and it fingerprints as `CA:` (same as the user spelling).
- `wrapInCast` gained a `synthetic = true` parameter; existing callers are unchanged.
- `buildFunctionCall` (scalar branch) calls `coerceTextArgs` right after `coerceComparisonGroup` and **before** `validateArgTypes` / `inferScalarCallType`, so inference sees TEXT arguments.
- `string.ts` declarations: `substr`/`substring` `[0]`; `trim`/`ltrim`/`rtrim` `[0, 1]`; `replace` `[0, 1, 2]`; `instr` `[0, 1]`; `lower`/`upper`/`reverse` `[0]`; `lpad`/`rpad` `[0, 2]`; `like`/`glob` `[0, 1]`. Implementations replaced `String(x)` and `typeof x !== 'string' → null` with a NULL check plus `valueToText` (identity on strings). `lpad`/`rpad` keep their number/bigint length check.
- Return types: `stringifyingTextReturn` and `textOnlyReturn` merged into one `textArgsReturn` (no `accepts`), since every argument now arrives as TEXT. `lpad`/`rpad` `accepts` reduced to `[undefined, isNumberValued]`.
- `split_string` (table-valued) and `string_concat` (aggregate) fixed inline with `valueToText`; the seam is scalar-only. `split_string` yields no rows only when either argument is NULL; `string_concat` skips NULLs and renders everything else.
- `length`, `hex`, `unhex` deliberately unchanged (documented why in `docs/functions.md`).

## Behaviour changes a user can see

- `upper(x'6162')` → `'AB'` (was NULL); `lower(true)` → `'true'`; `reverse(12)` → `'21'`; `lpad(5, 3, 0)` → `'005'` (was NULL).
- `substr(x'6162', 1, 1)` → `'a'` (was `'9'`, from `'97,98'`).
- `replace(json('{"a":1}'), 'a', 'b')` → `'{"b":1}'`.
- `instr` over two blobs is a character position in the decoded text, not SQLite's byte position (documented).
- `upper(int_not_null_col)` now announces non-null.
- EXPLAIN / `query_plan` shows the inserted `cast(... as text)` for a non-text argument, including an untyped `?` parameter (`lower(?)` plans as `lower(cast(? as text))`).

## Tests

- **NEW `test/string-text-args.spec.ts`** — property `f(…x…) = f(…cast(x as text)…)`, generated from `BUILTIN_FUNCTIONS` (every scalar schema with `textArgs`), at every declared position for each arity (fixed `numArgs`, or 1–3 for variadic, skipping arities that do not prepare with filler arguments). Samples: blob, integer, real, bigint, boolean, JSON object, JSON array, text. The sample goes in through a bound parameter on one side (runtime path) and as a spelled-out cast on the other; results compared with strict equality in JavaScript because the parser has no general `x is y` operator (only `is null/true/false`). Also asserts the filtered set is non-empty. Mutation-checked: disabling the planner call and reverting `upper` to the old guard makes it fail with 7 violations.
- **`03.6.2-value-to-text.sqllogic`** — new section pinning the user-visible rows above, plus `split_string(x'612c62', ',')` and `string_concat(b) = group_concat(b)` over the blob table.
- **`announced-result-types.spec.ts`** — `select upper(id) from t` announces `nullable: false` (pins coercion-before-inference).
- **Updated, not new:** `101-builtin-mutation-kills.sqllogic` pinned `lower(42)`/`upper(42)` → NULL; now `'42'`. `runtime/scalar-fusion.spec.ts` depth-cap tests used `lower(?)`, which now has a cast frame between call and parameter, shifting the cap by one; switched to `abs(?)` (no text arguments) with a comment saying why. `documentation.spec.ts` mirrors the `docs/plugins.md` scalar example, which now uses `textArgs: [0]` instead of `String(text)`.

Validation run: `yarn workspace @quereus/quereus run lint` (eslint + test tsc) clean; `yarn workspace @quereus/quereus run typecheck` clean; `yarn test` all workspaces green (quereus 11186 passing); `yarn workspace @quereus/quereus run test:repr-strict` green (11196 passing). `yarn test:store` not run.

## Things for the reviewer to look at

- **Persisted data computed under the old rule**: a store index or materialized view over e.g. `lower(blob_col)` or `upper(int_col)` built before this change holds NULL where the new code computes text. Out of scope per AGENTS.md (no backwards compatibility yet); nothing built for it.
- **Fusion depth**: every non-text argument of a string builtin now adds one closure frame under scalar fusion. Only matters near `MAX_FUSION_DEPTH` (32); the fallback path is unchanged.
- **Fresh-value provenance** (`planner/analysis/value-provenance.ts`): `lower(randomblob(16))` stays `other` (blob→text cast is lossy, `conversionKeepsFresh` false). New: `lower(<fresh integer source>)` is now `other` too, since INTEGER→TEXT is not in `conversionKeepsFresh`; before, it was (wrongly) treated as fresh-preserving although `lower` returned NULL. Conservative; no edit made.
- **Parameter-typed plans**: an untyped `?` (ANY) always gets the cast; a `?` bound to a string at prepare time gets none. Both convert identically, so this only changes plan shape.
- **`like`/`glob` bodies still call `valueToText`** themselves (belt and braces, as the ticket asked), as do all the other implementations; the property test therefore cannot tell a broken seam from a broken implementation on its own — it fails only if the result disagrees with the spelled cast. The mutation check above shows it fails when both are removed.
- **`split_string` column names**: the built-in declares no columns, so `select value from split_string(...)` (as `docs/functions.md` shows) fails. Pre-existing and unrelated to the conversion; filed as `bug-split-string-builtin-declares-no-columns` in backlog. The new sqllogic row reads it through `*` and pins `col_0`/`col_1`, which that fix will need to update.

## Review findings

Reviewed the `ticket(implement): debt-string-builtins-coerce-three-different-ways` diff first, then the handoff. Ran `yarn workspace @quereus/quereus run lint` (clean), `run typecheck` (clean), and `yarn workspace @quereus/quereus test` (11186 passing, 23 pending). `yarn test:store` not run (no store-specific path touched).

**Checked by running a throwaway probe (deleted afterwards):** `upper(null)` → NULL; `trim(12, 1)` → `'2'`; `substr(12345, 2)` → `'2345'`; `instr(12345, 34)` → 3; `replace(?, 1, 2)` with 111 → `'222'`; `like('1%', 12)` → true; `glob('1*', 12)` → true; a DATE argument (physical TEXT) gets no cast and passes through; `upper(json('"x"'))` → `'X'`; `ltrim(x'202061')` → `'a'`; a nullable integer column stays NULL. `query_plan` shows `upper(cast(b as text))` for a blob column and `upper(cast(? as text))` for an untyped parameter. A prepared statement cannot be re-executed with a parameter of a different physical type (the statement rejects it with "Parameter type mismatch"), so the handoff's "a `?` typed TEXT at prepare time gets no cast" never sees a non-text value at runtime; the implementations' own `valueToText` covers it anyway.

**Found and fixed (minor):**
- Type safety: `textArgs` sat on `BaseFunctionSchema`, shared by aggregate and table-valued schemas, while the planner reads it only on scalar calls, so a hand-built aggregate or table-valued schema could declare it and have it silently ignored. Moved it to `ScalarFunctionSchema` (`src/schema/function.ts`) and updated the two `{@link}` references (`func/registration.ts`, `planner/building/coercion.ts`). The type check and the test-file type check pass, so no other site relied on it.

**Checked, nothing to change:**
- Other ways a call node gets built: `ScalarFunctionCallNode` is built in `buildFunctionCall` (now coerces), in `withChildren` (keeps the cast children), and in `rule-materialized-view-rewrite.ts` (an aggregate combine function, which declares no text arguments). No path skips the rewrite.
- Optimizer rules that match on string-function names or argument shape: none outside `func/builtins` and value provenance.
- Value provenance (`planner/analysis/value-provenance.ts`): `lower`/`upper` over a fresh blob now reach the inserted cast, which `conversionKeepsFresh` rejects (blob→text), so the result is the same `other` as before by a different route. The `blobSafeFunctions` branch is no longer reached for these two but stays correct. A fresh integer under `lower` becoming `other` is conservative, as the handoff says.
- Fusion depth: one extra closure frame per converted argument. The fallback beyond `MAX_FUSION_DEPTH` is unchanged and correct, so this is not a tripwire.
- Docs: read `docs/functions.md`, `docs/sql-functions.md`, `docs/types.md`, `docs/plugins.md` and `util/value-text.ts`; they describe the new rule and the `length`/`hex`/`unhex` exceptions. A search for `lower(?)`, "NULL if not a string" and the old ticket slug turns up no stale text.
- Tests: the new property test (`test/string-text-args.spec.ts`) is generated from the registry and pins the contract, so it pays for itself. Its `preparesWithFillers` uses a failed prepare to skip arities a variadic function rejects. That is control flow by exception, but it is confined to a test probe, and other tests would catch a fixed-arity regression. Kept. The sqllogic rows, the `announced-result-types` row (conversion happens before inference) and the updated `101`/`scalar-fusion`/`documentation` tests are justified. Nothing cut.

**Major / tickets filed:** none. The `split_string` column-name defect was already filed during implement as `bug-split-string-builtin-declares-no-columns` (backlog). Persisted results computed under the old rule are out of scope under the AGENTS.md backwards-compatibility rule. Also, expression indexes are not supported yet ("Indices on expressions are not supported yet"), so no stored index can hold an old result.

**Tripwires:** none added. Each conditional concern above either has an unchanged fallback or is already conservative.
