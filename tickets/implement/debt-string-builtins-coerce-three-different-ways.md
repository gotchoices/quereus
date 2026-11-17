description: Make every text function (upper, substr, trim, replace, …) turn a non-text argument into text the same way `cast(x as text)` does, by letting a function declare which of its arguments are text and having the query planner do the conversion, instead of each function guessing on its own.
prereq: builtin-results-announce-honest-nullability
files:
  - packages/quereus/src/schema/function.ts                # add `textArgs` beside `comparesArgs` on BaseFunctionSchema
  - packages/quereus/src/func/registration.ts              # ScalarFuncOptions.textArgs + pass-through in createScalarFunction
  - packages/quereus/src/planner/building/function-call.ts # apply the declaration (scalar branch, before inferReturnType)
  - packages/quereus/src/planner/building/coercion.ts      # new helper beside coerceComparisonGroup; wrapInCast needs a non-synthetic variant
  - packages/quereus/src/types/comparison-coercion.ts      # comparisonGroupIndices — reuse to resolve 'all' | number[]
  - packages/quereus/src/func/builtins/string.ts           # declare textArgs; String(x) → valueToText; split_string, string_concat inline
  - packages/quereus/src/util/value-text.ts                # doc comment: remove the "known exception" paragraph
  - packages/quereus/src/planner/analysis/value-provenance.ts # read-only check: FRESH_PRESERVING_WRAPPERS note still true
  - packages/quereus/test/logic/03.6.2-value-to-text.sqllogic # SQL-visible agreement rows
  - packages/quereus/test/announced-result-types.spec.ts   # one nullability assertion
  - packages/quereus/test/string-text-args.spec.ts         # NEW: registry-generated property test
  - docs/functions.md                                      # § String Functions
  - docs/sql-functions.md                                  # § String Functions (lower/upper wording)
  - docs/types.md                                          # § Value to text — exception paragraph
  - docs/plugins.md                                        # document `textArgs` for function authors
difficulty: medium
----

# One rule for "this argument is text": declared by the function, applied by the planner

## The problem (verified against the engine)

The engine has one value-to-text conversion, `valueToText` (`src/util/value-text.ts`), behind `cast(x as text)`, `text(x)`, TEXT-column writes, `||`, `group_concat`, the `LIKE` operator and the `like`/`glob` functions. The rest of `src/func/builtins/string.ts` handles a non-text argument in one of two other ways:

| today | functions | example |
|---|---|---|
| JavaScript `String(x)` | `substr`, `substring`, `trim`, `ltrim`, `rtrim`, `replace`, `instr` | `substr(x'6162',1,1)` is `'9'` — the blob became `'97,98'` |
| refuse (NULL / no rows) | `lower`, `upper`, `reverse`, `lpad`, `rpad`, `split_string` | `upper(x'6162')` is NULL |
| dropped silently | `string_concat` (aggregate) | non-string values vanish from the result |
| the one conversion | `like`, `glob`, `cast`, `\|\|`, `group_concat` | `cast(x'6162' as text)` is `'ab'` |

## Decisions (settled here)

- **Coerce, never refuse.** For every function in the family, `f(x) = f(cast(x as text))` at each text argument position. This is what the rest of the engine does and what SQLite does. It changes documented behaviour for `lower`/`upper` (`docs/functions.md` says "NULL if not a string"), deliberately.
- **`length()` stays out.** It reports bytes for a BLOB and characters for TEXT on purpose; converting its argument would erase that.
- **`hex()` / `unhex()` stay out.** They are on the one *blob* conversion (`docs/functions.md` already says so); `unhex` keeps returning NULL for a non-text argument.
- **Non-text positions keep their current handling**: `substr`'s start/length (`Number(x)`), `lpad`/`rpad`'s length (number/bigint only, else NULL).
- **`instr` over two blobs becomes a character position in the decoded text**, not SQLite's byte position. Accepted: it follows from the one rule; note it in the docs row.
- **`string_concat` renders every non-null value through `valueToText`** (same as `group_concat`), and still skips NULLs. **`split_string`** converts both arguments with `valueToText` and yields no rows only when either is NULL.

## The seam: `textArgs`, applied at plan-build time

Add to `BaseFunctionSchema` (`src/schema/function.ts`, next to `comparesArgs`):

```ts
/** Argument positions this function reads as text. The planner wraps each such
 *  argument whose static type is not physically TEXT in `cast(<arg> as text)`, so
 *  f(x) = f(cast(x as text)) holds by construction. `'all'` for a variadic function. */
readonly textArgs?: 'all' | readonly number[];
```

and `textArgs?: 'all' | readonly number[]` to `ScalarFuncOptions` in `src/func/registration.ts`, passed through by `createScalarFunction` (hand-built schemas via `Database.registerFunction` carry the field directly — no extra work, the planner reads the schema).

In `src/planner/building/function-call.ts`, scalar branch, right next to the existing `coerceComparisonGroup` call and **before** `inferScalarCallType` (the comment there already explains why coercion must precede inference), call a new helper in `src/planner/building/coercion.ts`:

```ts
export function coerceTextArgs(scope: Scope, textArgs: 'all' | readonly number[], args: ScalarPlanNode[]): void
```

It resolves positions with `comparisonGroupIndices(textArgs, args.length)` (`src/types/comparison-coercion.ts`; out-of-range positions are ignored, same as `comparesArgs`) and replaces each `args[i]` whose `getType().logicalType.physicalType !== PhysicalType.TEXT` with a **non-synthetic** `CastNode` to `TEXT`.

**Non-synthetic matters.** `wrapInCast` builds `synthetic: true` casts, which mean "comparison operand": the runtime then uses `comparandConverter`, and analyses look *through* them (`scalar-param-usage.ts`, `expression-fingerprint.ts` tags them `CAS`). The text-argument cast must behave exactly like a user-written `cast(x as text)` (`lenientCast` → `TEXT_TYPE.parse` → `valueToText`). Give `wrapInCast` a `synthetic` parameter (default `true`, so existing callers are unchanged) or add a sibling; keep the synthetic AST construction shared.

Why plan time rather than inside `buildScalarFunctionRun` (`runtime/emit/scalar-function.ts`): the argument types `inferReturnType` sees become TEXT, so the nullability helpers from the prereq ticket stay exact **without editing any accept predicate** — `textOnlyReturn` (`accepts: [isTextValued]`) on `upper(int_not_null_col)` now sees a non-null TEXT argument (the cast is non-null because `castCanYieldNull(TEXT_TYPE)` is false) and announces non-null. It also costs nothing at runtime for arguments already typed TEXT, and follows the `comparesArgs` precedent. Tradeoff: EXPLAIN shows the inserted cast for non-text arguments; that is accurate.

## Declarations and implementation edits in `string.ts`

| function | `textArgs` |
|---|---|
| `substr`, `substring` | `[0]` |
| `trim`, `ltrim`, `rtrim` | `[0, 1]` |
| `replace` | `[0, 1, 2]` |
| `instr` | `[0, 1]` |
| `lower`, `upper`, `reverse` | `[0]` |
| `lpad`, `rpad` | `[0, 2]` |
| `like`, `glob` | `[0, 1]` |

Implementations: replace every `String(x)` on a declared text position with `valueToText(x)`, and replace the `typeof x !== 'string' → null` guards in `lower`/`upper`/`reverse`/`lpad`/`rpad` with a NULL check followed by `valueToText`. The planner guarantees text in practice; `valueToText` is the identity on strings and keeps the implementation agreeing with the rule even if a value ever reaches it un-converted (e.g. a JSON-typed operand whose value is a string scalar). `like`/`glob` already do this — leave their bodies as they are.

`lpad`/`rpad`'s length check (`typeof len !== 'number' && typeof len !== 'bigint' → null`) stays.

`split_string` (table-valued — the seam is scalar-only) and `string_concat` (aggregate) are fixed inline with `valueToText`; the seam is not extended to those registration kinds.

Return types: leave the `nullPropagatingReturn` declarations as they are; they are already correct once arguments arrive as TEXT (see above). Do update the comments that say "stringifies its arguments with `String()`" (`stringifyingTextReturn`) and the trim/substr comments to say the planner converts.

## Docs and comments that come out / change

- `docs/functions.md` § String Functions: `lower`/`upper` rows lose "`NULL` if not a string"; replace the divergence paragraph (the one naming this ticket) with one sentence: the string functions read a non-text argument through the one value-to-text conversion, so `f(x)` = `f(cast(x as text))`; `length`, `hex`, `unhex` are the exceptions, with why. Note `instr`'s character-position-over-decoded-text behaviour for blobs. Add a `split_string` / `string_concat` mention if they appear in the doc.
- `docs/sql-functions.md` § String Functions: check wording of `lower`/`upper`/`unhex` lines; nothing else should need changing.
- `docs/types.md` § Value to text: replace the "one exception" paragraph with the `textArgs` mechanism in one or two sentences; add the string builtins to the list of sites using the conversion.
- `src/util/value-text.ts` doc comment: drop the "known exception … tracked as" paragraph; list the string builtins among the callers (via `textArgs`).
- `docs/plugins.md`, near the return-type section: a short paragraph telling function authors to declare `textArgs` instead of stringifying arguments themselves.
- `src/planner/analysis/value-provenance.ts` `FRESH_PRESERVING_WRAPPERS` note ("The others render a blob operand as text first") is now literally true via the inserted cast; `lower(randomblob(16))` still yields `other` because the blob→text cast is lossy. Confirm by reading; no edit expected.

## Edge cases & interactions

- **NULL argument**: `upper(null)` → `upper(cast(null as text))` → NULL; the constant folder handles it. Verified by existing `06.1-string-functions.sqllogic` NULL rows.
- **Unknown/ANY-typed argument** (a parameter with no inferred type, an ANY column): physical type is NULL, not TEXT, so a cast is inserted and converts at runtime. Covered by the property test via bound parameters.
- **Temporal types** (DATE/TIME/DATETIME/TIMESPAN) are physically TEXT: no cast inserted; values pass unchanged. By inspection (the physical-type check).
- **JSON argument**: JSON's physical type is OBJECT, so a cast is inserted; a JSON string scalar renders bare, an object/array renders as its document text. Property test includes a JSON object and array.
- **Bigint**: exact digits through `valueToText`; property test includes `9007199254740993`.
- **Optional argument omitted** (`trim(x)`, `substr(x, 2)`): `comparisonGroupIndices` drops positions ≥ `args.length`. Property test covers each arity.
- **Optional text argument NULL** (`trim(x, null)` trims whitespace): unchanged — `cast(null as text)` is NULL. By inspection.
- **Expression indexes / materialized-view matching** over e.g. `lower(int_col)`: both the index expression and the query expression go through the same builder, so both carry the same cast and the same fingerprint (`CA:` — identical to a user writing the cast, which is correct since the values are equal). Existing index/MV suites cover matching; no new test.
- **Lens prover / injectivity**: no string builtin declares `injectiveOnArgs`/`monotoneOnArgs`; lens tests over `upper(code)` use TEXT columns, so no cast is inserted. Existing suites cover it.
- **Persisted data computed under old semantics** (a store index or materialized view over `lower(blob_col)` built before this change holds NULL where the new code computes text): backwards compatibility is out of scope per AGENTS.md; mention it in the review handoff, nothing to build.
- **Plugin-registered function with `textArgs` through `Database.registerFunction`**: the planner reads the schema field, so it works without `createScalarFunction`. By inspection.
- **Announced nullability under `QUEREUS_REPR_STRICT` / the announced-nullability egress check**: `upper(int_not_null)` now announces non-null and returns non-null. One assertion in `announced-result-types.spec.ts` pins the ordering (coercion before inference).

## Tests (keep to these)

- **NEW `packages/quereus/test/string-text-args.spec.ts`** — the property `f(…x…) is f(…cast(x as text)…)`, generated from the registry: iterate `BUILTIN_FUNCTIONS` (`src/func/builtins/index.ts`), keep scalar schemas with `textArgs`, and for each declared position at each arity the function accepts (fixed `numArgs`, or for `numArgs: -1` every arity from the highest declared position + 1 up to 3) bind one sample value at that position and fillers elsewhere (`'ab'` at other text positions, `2` at non-text positions). Sample values: `x'6162'`, `12`, `2.5`, `9007199254740993` (bigint), `true`, `json('{"a":1}')`, `json('[1,2]')`, `'ab'`. Compare with `is` so NULL = NULL passes. Pass the sample through a bound parameter on one side and the literal cast on the other, so the runtime (non-folded) path runs. A hand-list of function names must not appear in the test. Also assert the filtered set is non-empty so a broken filter cannot pass vacuously.
- **`03.6.2-value-to-text.sqllogic`** — a short "string builtins use the same rule" section: `substr(x'6162', 1, 1)` → `'a'`; `upper(x'6162')` → `'AB'`; `lower(true)` → `'true'`; `reverse(12)` → `'21'`; `lpad(5, 3, 0)` → `'005'`; `replace(json('{"a":1}'), 'a', 'b')` → `'{"b":1}'`; `split_string(x'612c62', ',')` → rows `a`, `b`; `string_concat` over the existing `vt_b` blob table agrees with `group_concat`.
- **`announced-result-types.spec.ts`** — one case: `select upper(i) …` over an `integer not null` column announces `nullable: false`.
- Update any existing assertion that pinned the old NULL / `97,98` behaviour (none found by grep in `test/`; run the suite to be sure).

## TODO

- Add `textArgs` to `BaseFunctionSchema` (`schema/function.ts`) with the doc comment above; add to `ScalarFuncOptions` and pass through in `createScalarFunction`.
- Add a `synthetic` parameter (default `true`) to `wrapInCast`; add `coerceTextArgs` in `planner/building/coercion.ts`.
- Call `coerceTextArgs` in `planner/building/function-call.ts` scalar branch before `inferScalarCallType`.
- Declare `textArgs` on the string builtins per the table; replace `String(x)` / `typeof` guards with `valueToText`; fix `split_string` and `string_concat` inline; refresh the return-type comments.
- Write the property spec, the sqllogic section and the one nullability assertion.
- Update `docs/functions.md`, `docs/sql-functions.md`, `docs/types.md`, `docs/plugins.md`, and the `value-text.ts` doc comment.
- `yarn workspace @quereus/quereus run lint` and `yarn test`; record any pre-existing failure per the ticket rules.
