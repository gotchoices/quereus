description: SQL single-quoted string literal lexer was stripping backslashes (treating `\n`, `\t`, `\\`, etc. as C-style escapes). Fixed to preserve backslashes verbatim per the SQL standard; only `''` remains as the embedded-quote escape.
files:
  packages/quereus/src/parser/lexer.ts (string() method, lines 493–522)
  packages/quereus/test/logic/18-json-string-escapes.sqllogic
----

## What was built

`Lexer.string()` was rewritten from a C-style escape switch
(`\n`/`\r`/`\t`/`\\`/`\'`/`\"`/`\0` plus a silent fallthrough that
dropped the leading `\` for any other character) into a tight
read-until-quote loop with a single doubled-quote (`''`) re-entry.
Characters between the delimiting quotes are now preserved verbatim,
matching the SQL standard and SQLite behavior. Identifier scanners
(`doubleQuotedIdentifier`, `backtickIdentifier`, `bracketIdentifier`)
and `blobLiteral` were untouched — they already preserved characters
verbatim.

## Key files

- `packages/quereus/src/parser/lexer.ts:493` — `string(quote)` is the
  only site that changed; ~20 lines.
- `packages/quereus/test/logic/18-json-string-escapes.sqllogic` —
  eight previously-blocked cross-check rows (originally tagged
  `-- TODO bug:`) are now active and passing.

## Testing notes

- `yarn workspace @quereus/quereus test --grep "18-json-string-escapes"`
  → 1 passing.
- `yarn workspace @quereus/quereus test --grep "Parser"` → 59 passing.
- Full `yarn workspace @quereus/quereus test` → 993 passing. The one
  failing test (`Predicate normalizer / double negation`) is a
  pre-existing failure that reproduces on `main` without any of these
  changes — unrelated.

Notable round-trip cases now exercised:

- `json_quote('String "\ Test')` — backslash before a non-escape
  character is preserved.
- `json_array('a\\b')` — two literal backslashes in source round-trip
  through JSON encoding as `["a\\\\b"]`.
- `json_extract('{"a":"he said \"hi\""}', '$.a')` — embedded JSON
  `\"` reaches the JSON parser intact.
- `json_extract` with `\\`, `\n`, `\t` payloads — all four standard
  JSON escape sequences round-trip end-to-end.
- `json_valid('{"a":"\xZZ"}')` and `json_valid('{"a":"\u00"}')` —
  malformed JSON escapes are rejected (`json_valid` returns `false`),
  which would have been impossible to express in SQL source under the
  old lexer.

## Usage / behavior change

Any external SQL relying on `\n`, `\t`, etc. inside single-quoted
strings will now see literal backslash sequences instead of the
control characters. This matches SQLite, the SQL standard, and the
engine's stated cross-check behavior; it is a deliberate correctness
fix, not a regression.

## Review verification

- `string()` no longer references `escaping`, `\\`, `\n`, etc. —
  confirmed at `lexer.ts:493–522`.
- No callers post-process `STRING` token literals to interpret escapes.
  All `TokenType.STRING` consumers in `parser.ts` (`:722`, `:1532`,
  `:1596`, `:2209`, `:2695`, `:2708`, `:2711`, `:2715`, `:2788`,
  `:2998`, `:3019`, `:3023`, `:3039`, `:3049`, `:3074`, `:3419`) read
  `token.literal` / `token.lexeme` directly.
- A grep for `'[^']*\\[^']*'` across `packages/quereus/test/logic/`
  surfaced only `18-json-string-escapes.sqllogic` and an expected
  output line at `97-json-function-edge-cases.sqllogic:200` (the JSON
  output, not a SQL source string) — no other fixture depends on the
  old behavior.
- Identifier scanners and `blobLiteral` were not touched.
