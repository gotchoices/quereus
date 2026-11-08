description: A `maintained as …` clause written after `with tags (…)` on a declared table parses with no error and is silently swallowed as an unmodeled item, leaving the table permanently empty; writing the clauses in the other order works.
files: packages/quereus/src/parser/parser.ts (`declareTableItem` ~L3770-3839; `createTableStatement`'s equivalent at ~L2650-2726; both call `parseMaintainedClause()` exactly once, before the `WITH` loop)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: accepting both clause orders costs a possible second `parseMaintainedClause()` call (cheap: single-token lookahead when absent) and a duplicate-clause check; no correctness tradeoff.
----

# A maintained table loses its derivation when its tag clause is written first

## Problem

A declared table can carry a `maintained as <query>` clause and, separately, an arbitrary `with tags (…)` clause. Both follow the column list, and one order works while the other silently does not:

```sql
declare schema s {
  table T using memory { a integer, primary key (a) } maintained as
    select id as a from Other
    with tags (k = 'v')
}
```

derives rows as expected. But:

```sql
declare schema s {
  table T using memory { a integer, primary key (a) } with tags (k = 'v') maintained as
    select id as a from Other
}
```

parses with **no error at all** and derives nothing, ever. `apply schema` succeeds, the table exists, every query against it returns empty.

## Root cause (verified in source, 5.1.0)

`declareTableItem` (`parser.ts:3770`) parses the column list, then calls `this.parseMaintainedClause()` **exactly once** (`:3806`) before entering the `while (this.matchKeyword('WITH')) { … }` loop that handles `WITH CONTEXT` / `WITH TAGS` in either order (`:3808-3822`). `parseMaintainedClause` (`:2766`) returns `undefined` immediately if the next token is not `MAINTAINED`. So with the tag-first order, the single call sees `WITH` and returns `undefined`; the `WITH TAGS` loop then consumes the tag clause and `declareTableItem` returns with `maintained` still `undefined` — it never looks for a trailing `maintained as …` after the `WITH` loop. Control returns to `declareBlockItem`'s dispatch, which recognizes no item keyword named `maintained` and falls through to `declareIgnoredItem` (`:3672`), the fallback that silently skips and discards the text of any item kind the parser doesn't model (its own doc comment: "a typo'd item keyword is therefore accepted and silently ignored rather than diagnosed"). The leftover `maintained as select …` is swallowed exactly as that fallback describes.

`createTableStatement`'s plain `CREATE TABLE … MAINTAINED AS … WITH TAGS (…)` form has the identical structure (`:2690-2714`, one `parseMaintainedClause()` call before the same `WITH` loop) and its own comment asserts the position is "unambiguous, so no look-ahead guard is needed" — not true for the reversed order. There the failure mode likely differs (a syntax error at the statement boundary rather than a silent swallow, since the top-level statement parser has no ignored-item fallback), but not verified directly; worth confirming alongside the fix.

## The fix

Either accept `with tags (…)` on both sides of `maintained as …` — after the `WITH` loop, if `maintained` is still unset, try `parseMaintainedClause()` again (erroring on a second match, the same way the loop already errors on a duplicate `WITH TAGS`) — or raise a parse error when a `maintained as` clause follows a completed table item instead of letting it fall to `declareIgnoredItem`. Accepting both orders is the smaller surprise given tags conventionally sit right after a column list in this codebase's own style; erroring is an acceptable floor. Apply the same shape to both `declareTableItem` and `createTableStatement`.

### Alternatives considered and rejected

- **Leave it to documentation/comments.** Protects nobody who hasn't read the comment; the next maintained table declared in the near-side order fails the same way with no diagnostic.
- **A downstream consumer's own build check that refuses the near-side order.** Treats one consumer's symptom; every host of this grammar has the hazard, and the engine can name the exact offset.

## If left unfixed

A future maintained-table declaration written in the natural tags-then-maintained order ships silently empty, with no error anywhere between `apply schema` and the first query against it reading empty. Fully reversible either way: a fix is additive in the parser.

## Found via

SiteCAD (github.com/Digithought/SiteCAD), a consumer of this package. SiteCAD's own affected declaration is already written in the working order with a comment naming this ticket, so nothing there is currently broken.
