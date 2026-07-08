description: Pattern-matching operators like LIKE and GLOB no longer rebuild their matcher from scratch on every row; compiled matchers are cached, and literal patterns compile once at query-build time.
files:
  - packages/quereus/src/util/patterns.ts
  - packages/quereus/src/runtime/emit/binary.ts
  - packages/quereus/src/runtime/emit/literal.ts (verified — literal emit returns raw value)
  - packages/quereus/src/func/builtins/string.ts (unchanged — routes through memoized path)
  - packages/quereus/test/patterns.spec.ts
difficulty: medium
----

## What shipped

Two pure-performance changes, results byte-for-byte identical to prior behavior:

1. **Memoized compile** (`util/patterns.ts`): pattern string → `RegExp` split from
   matching. `compileLikeMatcher` / `compileGlobMatcher` wrap `compileLike` /
   `compileGlob` with a bounded (256-entry) insertion-order LRU. Separate caches per
   pattern language so `[a-c]` (GLOB class vs LIKE literal) never collides.
   `simpleLike` / `simpleGlob` keep their 2-arg signature, now route through the
   memoized path, so all existing callers (incl. `like()`/`glob()` builtins) benefit.
   Invalid pattern → `NEVER_MATCH` (returns false), as before; error now logged once
   per distinct pattern instead of once per row (logging-frequency change only).

2. **Emit-time pre-compile for literal LIKE** (`emitLikeOp`): when the pattern operand
   is a non-NULL literal constant, the matcher compiles once at emit time and is
   captured in the run closure; the literal param is dropped. Note tag
   `LIKE(like-const)`. Non-literal / correlated patterns fall through to the dynamic
   memoized path (`LIKE(like)`).

## Review findings

**Verdict: accept as-is. No major or minor findings; nothing fixed inline (nothing needed fixing).**

### Correctness (checked, clean)
- **Semantics unchanged** — diffed old vs new `patterns.ts`: `compileLike`/`compileGlob`
  bodies are the pre-change `simpleLike`/`simpleGlob` bodies verbatim (same regex
  escaping, `u` flag, char-class handling, invalid-pattern → false). Only wrapping changed.
- **Fast-path operand order** — parser emits `text LIKE pattern` as left/right; old
  `run(ctx, text, pattern)` with `params:[leftExpr, rightExpr]` confirms left=text,
  right=pattern. `constLikePattern(plan.right)` keys off the pattern operand. Correct.
- **Fast-path value fidelity (the real crux)** — verified `emitLiteral` (`literal.ts:9`)
  returns `plan.expression.value` **raw, no coercion**. So the dynamic path's
  `String(pattern)` equals the fast path's `String(expression.value)` byte-for-byte.
  No divergence between the two paths.
- **NULL handling** — fast path: pattern is const non-NULL, only `text === null → null`
  matters, preserved. NULL literal pattern (`x LIKE null`) → `constLikePattern` returns
  undefined (value===null) → dynamic path → null. Covered by test.
- **Promise values** — `constLikePattern` excludes `value instanceof Promise` (matching
  `emitLiteral`'s `MaybePromise` return), so deferred literals use the dynamic path
  where the param is awaited before `run`. Consistent.
- **LRU** — hit re-inserts (marks MRU), overflow evicts oldest, cap holds ≤256; the
  `keys().next().value` undefined guard is correct. Tested by 300-pattern eviction flood.

### Implementer's flagged gaps (all verified, all sound)
- **ESCAPE genuinely unsupported** — confirmed `BinaryOpNode` has only left/right, no
  third operand; `emitBinaryOp` routes bare `LIKE` only. The `NOTE:` in `memoizeCompile`
  (fold escape char / case-fold flag into the key IF ESCAPE or case-insensitive LIKE is
  ever added) is correct and necessary. Not a ticket — it's a valid tripwire.
- **Case-sensitive by design** — confirmed no `i` flag; unchanged; same NOTE covers it.
- **Literal-only fast path (no cast/collate/param unwrap)** — safe: `emitLikeOp` ignores
  collation entirely (old and new), so not unwrapping avoids collation drift. Params use
  the dynamic memoized path (one compile per distinct value). Decision sound.
- **No GLOB infix operator** — confirmed: GLOB is only the `glob()` builtin (memoized);
  no `emitGlobOp` exists. LIKE alone has both infix (emit-time path) and builtin. Acceptable.
- **Compile-count proven indirectly** — memoization proven by matcher reference identity;
  emit-time path proven by design (matcher captured, param dropped). No `new RegExp` spy.
  Judged **not worth adding** — reference identity + the byte-fidelity check above are a
  sufficient guarantee.

### Test coverage (adequate)
- `test/patterns.spec.ts` (29 cases): LIKE+GLOB semantics parity (case-sensitivity,
  Unicode `_`/`?` incl. non-BMP, empty patterns, GLOB classes, invalid range), memoization
  (reference identity, distinct→distinct, LIKE/GLOB non-collision, LRU eviction),
  end-to-end (emit-time literal, dynamic column pattern, NULL text/pattern).
- Existing `24-builtin-branches.sqllogic` and `06.1.3-like-glob-edges.sqllogic` still green.
- **Minor untested edge (not filed):** numeric-literal pattern on the fast path
  (`x LIKE 12` → `String(12)`="12"). Covered transitively by the emit-fidelity check
  (both paths `String()` the same raw value); not worth a dedicated case.

### Docs
- No doc file describes LIKE/GLOB pattern internals; `docs/sql.md` and `optimizer.md`
  make no claims contradicted by this change. Nothing to update. (Checked, not assumed.)

### Tripwires (recorded in-code by implementer, verified present & sound — not tickets)
- `PATTERN_CACHE_CAP = 256` `NOTE:` in `patterns.ts` — untuned; raise/configure if a
  workload thrashes distinct patterns.
- `memoizeCompile` `NOTE:` in `patterns.ts` — ESCAPE / case-insensitive LIKE must fold
  the escape char / case-fold flag into the cache key (or use a separate cache).

### Validation run this pass
- `yarn lint` → exit 0 (clean).
- `yarn test` → **6463 passing, 9 pending, exit 0**.
