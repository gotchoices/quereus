description: Unicode-aware LIKE / GLOB / substr (and GLOB character classes)
files:
  packages/quereus/src/util/patterns.ts
  packages/quereus/src/func/builtins/string.ts
  packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic
  packages/quereus/test/logic/24.1-substr-extras.sqllogic
----

## What was built

Three string built-ins now index by Unicode code point instead of UTF-16 code unit, and GLOB grew SQLite-style character-class support. The fix is centralized in `simpleLike` / `simpleGlob` (used by both the function-call and the `LIKE` binary-op emitter — `binary.ts:emitLikeOp`) and in `substrImpl` (shared by `substr` and `substring`).

### `simpleLike` — `packages/quereus/src/util/patterns.ts:16`
Compile the translated pattern with the regex `'u'` flag. The translation is unchanged; the flag makes `.` (from `_`) match one Unicode code point so `LIKE '_'` correctly matches a single non-BMP character (e.g. `😀`) instead of one of its surrogate halves.

### `simpleGlob` — `packages/quereus/src/util/patterns.ts:42`
Replaced the previous "escape everything then re-replace `\*` and `\?`" scheme (which clobbered character-class brackets) with a small character-by-character translator that:
- iterates by code point (`[...pattern]`) so non-BMP pattern chars survive intact;
- translates `*` → `.*`, `?` → `.`;
- passes `[abc]`, `[^abc]`, and `[a-c]` through to the regex engine, escaping `\\` and embedded `]`;
- treats `]` immediately after `[` or `[^` as a literal class member (per SQLite glob);
- treats an unclosed `[` as a literal `[` (defensive — friendlier than throwing);
- escapes regex metacharacters elsewhere;
- compiles with the `'u'` flag so code-point ranges like `[😀-😎]` work.

### `substrImpl` — `packages/quereus/src/func/builtins/string.ts:35`
Replaced UTF-16 indexing (`s.length`, `s.substring`) with code-point indexing — `Array.from(s)` once, then `slice(begin, end).join('')`. All existing edge cases (1-based, Y=0 quirk, negative Y, negative Z, Y past end, Z past end clamped to tail) behave exactly as before; only the indexing alphabet changed.

`length()`, `instr()`, `lpad`/`rpad`, `trim`/`ltrim`/`rtrim`, `replace()`, etc. were intentionally left alone — out of scope for this ticket. (See "Possible follow-up" below.)

## Tests

Three previously-disabled blocks were re-enabled (no `-- TODO bug:` comments remain in these regions):

- `packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic`
  - `like('_', '😀')` → `true`
  - GLOB character classes: `[abc]`, `[a-c]`, `[^abc]` — positive and negative (6 cases)
- `packages/quereus/test/logic/24.1-substr-extras.sqllogic`
  - `substr('a😀b', 2, 1)` → `'😀'`

Adjacent BMP cases (`like('a_b', 'aäb')`, `substr('café', 1, 4)`) continue to pass.

## Verification performed at review

- `yarn build` — clean.
- All four targeted sqllogic files (`06.1.3-like-glob-edges`, `24.1-substr-extras`, `06-builtin_functions`, `24-builtin-branches`) pass.
- Full sqllogic suite (`test/logic.spec.ts`) — 184 passing, 0 failing.
- All 371 optimizer tests pass at the implement commit `efc0cfe9`.
- Manual edge-case probe of `simpleGlob` against the review checklist — all 9 cases (unclosed `[`, `]` immediately after `[` / `[^`, non-BMP code-point ranges) returned the expected results.

### Note on a separate, unrelated regression on main
A bisect across the optimizer-tests failures observed when running the full quereus suite on current main (`45c6b316`) shows the regression was introduced by commit `8c9e5686 ticket(review): allow-aggregates-in-order-by` (changes in `planner/rules/retrieve/rule-grow-retrieve.ts` and `vtab/memory/module.ts`), **not** by this unicode ticket. The implement commit `efc0cfe9` for this ticket and its parent both pass cleanly. Tracking that as a separate concern is out of scope here; consider opening a fix ticket against `allow-aggregates-in-order-by`.

## Possible follow-up (not in scope here)

`instr()`, `length()`, `lpad`/`rpad`, `trim` family, `replace`, etc. still index by UTF-16 code unit. That now creates a subtle inconsistency with `substr` for non-BMP strings — e.g. `length('a😀b')` returns 4 but `substr('a😀b', 2, 1)` returns `'😀'`. If full Unicode-aware string semantics are desired across all built-ins, a follow-up plan/fix ticket should sweep those functions. Not blocking this ticket.

## Usage

```sql
-- LIKE: `_` now matches any single Unicode code point (incl. non-BMP)
select like('_', '😀');         -- true
select like('a_b', 'aäb');       -- true (still)

-- GLOB character classes (SQLite-style)
select glob('[abc]', 'a');       -- true
select glob('[a-c]', 'b');       -- true
select glob('[^abc]', 'd');      -- true
select glob('[😀-😎]', '😄');    -- true (non-BMP range)

-- substr: indexes by code point, not UTF-16 unit
select substr('a😀b', 2, 1);     -- '😀'
```
