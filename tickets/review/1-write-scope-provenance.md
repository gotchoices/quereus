description: Review the new classifier that labels every value a write statement produces by where it comes from (a literal, a statement input, a fresh unique-per-call function, a clock or random source, the row's own previous values, or other rows), and the new registration option that lets a module declare its own function a fresh source.
architecture: docs/change-scope.md#written-value-provenance
files: packages/quereus/src/planner/analysis/value-provenance.ts (new), packages/quereus/src/planner/analysis/non-det-functions.ts (new), packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/common/constants.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/core/database.ts, packages/quereus/src/func/builtins/scalar.ts, packages/quereus/test/optimizer/value-provenance.spec.ts (new), docs/change-scope.md, docs/plugins.md, docs/usage.md
----

First of three write-scope tickets. Ships an internal analysis module and one registration option; no public API surface beyond the `fresh` option. The next ticket (`write-scope-analyzer`) calls the three entry points from a memo on the DML executor node.

## What landed

- **`FunctionFlags.FRESH = 0x000400000`** (`common/constants.ts`): "every call returns a value unique with ≥128 bits of entropy, regardless of arguments" — a registrant's promise, not verified.
- **`fresh?: boolean`** on `ScalarFuncOptions` (`func/registration.ts`, resolved by the new `scalarFunctionFlags`) and on `db.createScalarFunction`'s options (`core/database.ts`, which now forwards `deterministic` and `fresh`). `fresh: true` sets FRESH and clears DETERMINISTIC; with `deterministic: true` it throws `MisuseError`. Not added to the table-valued or aggregate option shapes — the classifier only reads scalar calls, and "unique per call" has no meaning for them.
- **`planner/analysis/non-det-functions.ts`**: `classifyNonDetFunction(name)` — the time/random/volatile-UDF name mapping moved out of `change-scope.ts`, which now imports it (net −9 lines there).
- **`planner/analysis/value-provenance.ts`**: the `ValueProvenance` / `WrittenColumn` types, `classifyExpression(expr, env)`, the `FRESH_PRESERVING_WRAPPERS` constant (with its `NOTE:`), the `randomblob` rule, and the three entry points `classifyInsertColumns(InsertNode)`, `classifyUpdateColumns(UpdateNode)`, `classifyUpsertUpdateColumns(UpsertClausePlan, insertColumns)`.
- **Docs**: `docs/change-scope.md` § Written-value provenance (the kinds, the join rule, the wrapper allowlist, the `randomblob` rule, context variables as inputs, the fallback); `docs/plugins.md` § Fresh scalar functions; option bullets for `deterministic` / `replicable` / `fresh` under `docs/usage.md` § User-Defined Functions. `randomblob`'s definition in `builtins/scalar.ts` got a comment pointing at the rule.

## Where it departs from the ticket — check these

- **`WriteCoercionNode` and `CollateNode` are looked through, not treated as operators.** The insert builder wraps nearly every supplied cell (even the literal `1` into an `integer` column) in a write coercion. As an operator it would strip `value` from almost every inserted literal, making the field useless. So the classifier returns the operand's provenance unchanged, and `literal.value` is the literal *as written*, before conversion to the column's declared type (`'1'` into an integer column reports `'1'`). Both are therefore absent from `FRESH_PRESERVING_WRAPPERS.nodeTypes` (only `Cast` remains); the constant's comment says why.
- **Context-variable spec case reshaped.** The ticket's `insert … with context now = datetime('now') values (…, now)` does not plan: VALUES cells are built outside the mutation-context scope, and only defaults and CHECKs read context variables (see `test/logic/50-declarative-schema.sqllogic` step 52). The spec uses `created integer default now_ms` on a table declared `with context (now_ms integer)`, inserted with `with context now_ms = random()` — the result is `input` with `contexts: ['now_ms']`, not `volatile`, which is the behaviour the ticket wanted pinned.
- **Generated recomputes resolve through *any* earlier assignment**, user or generated (a generated column reading another generated column sees its recomputed provenance), not only "c's own non-generated assignment". This matches the runtime's topological evaluation order.
- **A volatile call combines with its arguments**: `{volatile}` joins its operands' provenances by rank, so `strftime('%s', n)` in an UPDATE is `self`, not `volatile`. The ticket only said "volatile with the function's source"; dropping the arguments would under-report.
- **Multi-row VALUES and `fresh`**: a column stays `fresh` only when every row calls the same fresh function; any mix (including a fresh row with a literal row) is `other`. The ticket did not spell this case out.
- **Upsert DO UPDATE does not bind mutation-context attributes** — the entry point's signature has no access to them, and the DO UPDATE SET scope cannot resolve a context variable anyway. A context read there would classify `other`.

## Known gaps (conservative, by design)

- The INSERT walk follows only `ProjectNode` → `ValuesNode`. A SELECT source whose top node is not a projection (`order by`, `limit`, `distinct`, an alias wrapper) classifies every column `other`. Also documented in the doc section.
- `lower` / `upper` are injective only over single-case text; they are in the allowlist for `lower(hex(randomblob(16)))`. A mixed-case fresh text source lowercased would wrongly stay `fresh`. Parked as a `NOTE:` on the constant. Similarly `cast` of a fresh blob to text is listed (per the ticket) although a lossy text decode is not strictly injective — reviewer's call whether to drop `Cast`.
- `randomblob` is matched by name, so a user who re-registers `randomblob/1` inherits the rule.
- Multi-source view-insert members (the envelope source) and FROM-position nested DML sources classify `other` — they bottom out in non-projection nodes.

## Tests

`test/optimizer/value-provenance.spec.ts` — builds plans with `buildBlock` (no optimizer) and calls the classifiers directly. Table-driven, one row per behaviour:

- literal and parameter cells → `literal {value: 1}`, `input ['p']` (also pins the write-coercion look-through)
- multi-row VALUES: two distinct literals → `literal` without value; literal + parameter → `input`
- omitted column with `default (randomblob(16))` → `fresh randomblob`
- generated `qty * price` with `qty` from `:q` → `input ['q']`
- default reading a context variable → `input contexts ['now_ms']`
- INSERT … SELECT: source column → `other`, projected `'k'` → `literal`, `:p` → `input`
- `hex(randomblob(16))` → `fresh`; `substr(randomblob(16), 1, 4)` → `other`; `randomblob(16) || :p` → `other`; `randomblob(8)` → `volatile [random]`
- module-registered `fresh: true` function → `fresh stamp_id`; `abs(stamp_id())` → `other`
- UPDATE `set n = n + 1` → `self ['n']`; `set v = :p` → `input`; `set n = (select max(n) from t)` → `other`
- UPDATE generated recompute: `set qty = :q` → `total` is `self ['price']` (qty resolved to the assignment's `input`, price to the previous value)
- upsert DO UPDATE: `n = n + 1` → `self ['n']`; `n = new.n` → the insert row's `input ['n']`
- registering `fresh: true, deterministic: true` throws `MisuseError`

## Validation

- `yarn lint` in `packages/quereus` (eslint + test type-check): clean.
- `yarn workspace @quereus/quereus test`: 10,791 passing, 25 pending, 0 failing. The existing change-scope specs pass unchanged after the name-mapping extraction.
