description: Pattern-matching operators like LIKE and GLOB no longer rebuild their matcher from scratch on every row; compiled matchers are now cached, and literal patterns compile once at query-build time.
files:
  - packages/quereus/src/util/patterns.ts
  - packages/quereus/src/runtime/emit/binary.ts
  - packages/quereus/src/func/builtins/string.ts (unchanged behavior — routes through memoized path)
  - packages/quereus/test/patterns.spec.ts
difficulty: medium
----

## What was done

Two complementary changes, both pure performance (results byte-for-byte identical):

### 1. Memoized compile in `util/patterns.ts`

Split compilation (pattern string → `RegExp`) from matching:

- `compileLikeMatcher(pattern)` / `compileGlobMatcher(pattern)` — each wraps a
  `compile*` fn with a bounded LRU cache (`memoizeCompile`). Returns a
  `PatternMatcher = (text: string) => boolean` closure holding the compiled
  `RegExp`. Repeated calls with the same pattern return the **same** matcher
  instance (compile-once).
- `simpleLike` / `simpleGlob` keep their old 2-arg signature but now route
  through the memoized compile, so every existing caller (including the
  `like()` / `glob()` builtins in `func/builtins/string.ts`) benefits with no
  call-site change.
- **LRU**: `Map`-insertion-order LRU, cap `PATTERN_CACHE_CAP = 256` per cache.
  Separate caches for LIKE vs GLOB → identical strings in the two different
  pattern languages never collide (e.g. `[a-c]` is a class in GLOB, literal in
  LIKE).
- **Error path preserved**: a pattern that fails to compile (e.g. GLOB
  `[z-a]`, bad range) yields a `NEVER_MATCH` matcher (returns `false`), exactly
  as before. The invalid-pattern error is now logged once per distinct pattern
  instead of once per row — a logging-frequency change only, not a result
  change.

### 2. Emit-time pre-compile for literal LIKE patterns (`emitLikeOp`)

`emitLikeOp` now detects a literal-constant pattern operand (`constLikePattern`:
a `LiteralNode` whose value is non-NULL and not a still-pending `Promise`) and
compiles the matcher **once at emit time**, capturing it in the run closure. The
literal operand is dropped from `params` (its value is baked into the matcher),
so a scan of N rows against `where name like 'a%'` does zero per-row compiles
and zero per-row cache lookups. Note tag: `LIKE(like-const)`. Non-literal /
correlated patterns (`name like pat_col`) fall through to the dynamic path,
which is still memoized (`LIKE(like)`).

## How to test / validate

- `packages/quereus/test/patterns.spec.ts` (new, 29 cases):
  - LIKE + GLOB **semantics parity** — case-sensitivity, Unicode `_`/`?` by
    code point (incl. non-BMP 😀), empty-pattern/empty-text, GLOB char classes,
    invalid-range → no match.
  - **Memoization**: reference-identity (`compileLikeMatcher(p) === compileLikeMatcher(p)`)
    proves compile-once; distinct patterns → distinct matchers; LIKE/GLOB
    non-collision; LRU eviction under a 300-distinct-pattern flood.
  - **End-to-end**: emit-time literal path, dynamic per-row column pattern, and
    NULL text / NULL pattern (`→ []`).
- Existing coverage already exercises both paths and stays green:
  - `test/logic/24-builtin-branches.sqllogic` — infix `LIKE` operator (literal
    → emit-time path), `NOT LIKE`, `NULL LIKE`, `x LIKE NULL`.
  - `test/logic/06.1.3-like-glob-edges.sqllogic` — case-sensitivity, char
    classes, Unicode.
- Commands run: `yarn lint` (exit 0), full `yarn test` → **6463 passing, 9
  pending, exit 0**. No plan-snapshot test asserts the note string.

## Known gaps / things for the reviewer to poke at

- **ESCAPE is a no-op in this ticket** because the parser/engine does **not**
  support the LIKE `ESCAPE` clause at all today (confirmed: parser builds only
  `left LIKE pattern`; `06.1.3-like-glob-edges.sqllogic` header says "ESCAPE
  clause for LIKE is not supported; cases dropped"). So there is no escape char
  to key on and no ESCAPE test. The ticket's "escape char in the memoization
  key" edge case is therefore vacuous now — but I left a `NOTE:` in
  `memoizeCompile` documenting that IF ESCAPE or case-insensitive LIKE is ever
  added, the escape char / case-fold flag MUST enter the cache key (or use a
  separate cache) or matchers will collide. Verify that reasoning is sound.
- **Case-folding**: Quereus LIKE is case-**sensitive** by design (no `i` flag,
  differs from SQLite's default). Kept identical. No case-fold variant exists,
  so no separate key is needed today — same NOTE covers the future case.
- **Compile-count proof is indirect.** The memoized path is proven by matcher
  reference identity. The emit-time literal path is proven by correctness +
  design (matcher captured in closure, pattern param dropped) — there is no
  hard "compiled exactly once" spy/counter. If you want a stronger guarantee,
  add a counter/spy around `new RegExp` and assert it's called once for an
  N-row literal-LIKE scan.
- **Literal fast path is `LiteralNode`-only.** Cast/collate-wrapped literals and
  bound parameters are intentionally NOT unwrapped (avoids collation-semantics
  drift, since `emitLikeOp` ignores collation) — they use the dynamic memoized
  path. Parameters are constant-per-execution, so a future enhancement could
  compile them once per execution at bind time; today they get one compile per
  distinct value, cached. Confirm the non-unwrap decision is safe.
- **No GLOB infix operator exists** — GLOB is only the `glob()` builtin, so
  there is no emit-time fast path for GLOB; it relies solely on memoization.
  LIKE has both the infix operator (emit-time path) and the `like()` builtin
  (memoized). Sanity-check that's acceptable.

## Tripwires (recorded, not tickets)

- `PATTERN_CACHE_CAP = 256` is an untuned guess — `NOTE:` at the const in
  `patterns.ts`: if a workload thrashes distinct patterns, raise/configure it.
- `memoizeCompile` `NOTE:` in `patterns.ts`: adding ESCAPE / case-insensitive
  LIKE requires folding the escape char / case-fold flag into the cache key.
