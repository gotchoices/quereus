description: Record, in the code and the type-system docs, the decision to keep JavaScript's spelling when a number is shown as text instead of copying SQLite's, with the reasons, so nobody re-files it as a bug.
architecture: docs/types.md
files:
  - packages/quereus/src/util/value-text.ts   # JSDoc paragraph "Number spelling stays String(v)" + the `case 'number'` arm
  - packages/quereus/test/util/value-text.spec.ts   # lines ~26-35, comment says "tracked separately"
  - docs/types.md   # paragraph "Number spelling stays JavaScript's" (~line 957) and the table row above it (~line 926)
difficulty: easy
repro: verified
---

# Keep JavaScript's number-to-text spelling; record it as an accepted divergence

## What was reproduced

Against the built engine (`packages/quereus/dist`), all four rows of the original report hold:

| query | Quereus | SQLite |
|---|---|---|
| `select cast(1.0 as text)` | `1` | `1.0` |
| `select cast(1.0 as text) = cast(1 as text)` | true | false |
| `select cast(1e21 as text)` | `1e+21` | `1.0e+21` |
| `select cast(1e400 as text)`, `cast(pow(10, 400) as text)`, `cast(cast('1e400' as real) as text)`, or a bound `Infinity` | `Infinity` | `Inf` |
| `cast(? as text)` with a bound `NaN` | `NaN` | SQLite has no NaN value; it stores NULL |

Arithmetic overflow does not reach this conversion at all: `1e308*10`, `1/0` and `inf - inf` already evaluate to NULL in Quereus. Non-finite numbers come only from out-of-range literals, `pow`, parsing text such as `'1e400'`, and bound parameters.

The current spellings are already pinned by `test/util/value-text.spec.ts` (the "spells a number with String(v)" case asserts `'1'`, `'Infinity'`, `'NaN'`), so no new test is needed.

## Decision: keep `String(v)`, do not adopt SQLite's spelling

The fix stage settled the question the original ticket left open. Reasons, per row:

- **`1.0` versus `1` cannot be told apart at this layer, by design.** In Quereus a REAL `1.0` and an INTEGER `1` are the same JavaScript value, the `number` `1` (docs/types.md, value-space rules R1/R2), and the engine treats them as one value everywhere else: the grouping-key serializer writes `5`, `5.0` and `5n` all as `n:5`, and INTEGER, REAL and NUMERIC share one seek key space. `valueToText` dispatches on the runtime value only (docs/types.md already says so for JSON string scalars). Producing `1.0` would mean threading the planned logical type into every caller (CAST, `||`, LIKE, `group_concat`, TEXT affinity on insert), so two values that compare equal would render differently depending on plan-time type inference — and NUMERIC and ANY-typed columns hold either form, so the answer would still be ambiguous there. That breaks the one-spelling-per-value property the conversion exists to provide.
- **`1e+21` versus `1.0e+21`** is the same `.0` suffix applied to an exponent form. Adopting SQLite's exponent layout without its `.0` would be a partial imitation of SQLite's `printf`-based formatter, which AGENTS.md rules out ("no janky half-baked parsers"); adopting the `.0` runs into the previous point.
- **`Infinity` versus `Inf`**: JavaScript's spelling round-trips and SQLite's does not. `REAL_TYPE.parse` (`src/types/builtin-types.ts`) uses `parseFloat`, which reads `'Infinity'` back as Infinity; `cast('Inf' as real)` is `0` and inserting `'Inf'` into a REAL column throws. Switching to `Inf` would make `cast(cast(x as text) as real)` lose the value.
- **`NaN`**: the spelling is not the issue; whether a NaN should be admitted at all (SQLite turns it into NULL) is a value-domain question about binding and parsing, not about text conversion. Out of scope here; `bug-sliding-window-sum-poisoned-by-non-finite-real` in backlog is related territory.

Revisit condition: if Quereus ever carries the REAL/INTEGER distinction in the runtime value itself (separate physical forms for whole-valued reals), the `1.0` arm becomes implementable and should be reconsidered.

## TODO

- In `packages/quereus/src/util/value-text.ts`, replace the JSDoc paragraph that begins "**Number spelling stays `String(v)`**" (it currently says the divergence is "tracked separately (`bug-real-to-text-formatting-differs-from-sqlite`)") with a short statement of the decision: deliberate, because REAL `1.0` and INTEGER `1` are one runtime value and this conversion cannot see the declared type; `Infinity` kept because it round-trips through `REAL_TYPE.parse` and `Inf` does not. Remove the ticket slug reference.
- Add a one-line accepted-tradeoff `NOTE:` on the `case 'number'` arm, e.g. `// NOTE: accepted tradeoff — JS spelling, not SQLite's ('1' for 1.0, 'Infinity' not 'Inf'); REAL 1.0 and INTEGER 1 are one runtime value and 'Infinity' round-trips through REAL parse; revisit if REAL/INTEGER ever get distinct runtime forms.`
- In `packages/quereus/test/util/value-text.spec.ts` (~line 31), change the comment "Deliberate SQLite divergence, tracked separately" to say it is an accepted divergence (see the NOTE in value-text.ts). Do not change the assertions.
- In `docs/types.md`, rewrite the paragraph "Number spelling stays JavaScript's … That is a separate divergence, tracked on its own." (~line 957) as the decided behaviour with the two reasons above (one runtime value for `1`/`1.0`; `Infinity` round-trips). Keep it to a few sentences.
- Run `yarn workspace @quereus/quereus run lint` (comment-only change; a full test run is not needed beyond confirming `test/util/value-text.spec.ts` still passes).
