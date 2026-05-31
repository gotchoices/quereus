description: Add hardening test coverage for compilePredicate's truthiness change — bare (non-comparison) scalar values routed through NOT, AND/OR operands, and a bare BLOB value. The core top-level bare-value path is already pinned by § 8 of 10.5.1-partial-indexes.sqllogic; these add the operator-nested and blob branches.
files: packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/util/comparison.ts
----

# rowtime-mv-predicate-truthy-extra-tests

## Background

The `rowtime-mv-minor-cleanups` ticket changed `compilePredicate`'s truthiness to delegate
to the engine's canonical `isTruthy` (numeric-string coercion: `'abc'`→false, `'0'`→false,
blobs→false). Review confirmed the implementation correct. The implementer added `§ 8` to
`test/logic/10.5.1-partial-indexes.sqllogic`, which pins the **top-level bare-value** path
via an observable partial UNIQUE (`create unique index … where flag` on a bare text
column).

What `§ 8` does **not** cover are the bare-value paths that go through the `predicateTruthy`
call sites *inside operators* — the exact lines the diff edited:

- a bare scalar as the operand of **`NOT`** (`compileUnary`, `predicate.ts:161-165`),
- a bare scalar as an **`AND`/`OR`** operand (`compileBinary`, `predicate.ts:201-220`),
- a bare **BLOB** value (`isTruthy` returns false for blobs — `util/comparison.ts:414` —
  a distinct branch with no current test).

These behaviorally traverse the same verified `isTruthy` delegation, so this is regression
hardening, not a known defect.

## Requirements

Extend `10.5.1-partial-indexes.sqllogic` (a new section, same observable-partial-UNIQUE
style as `§ 8`) with cases that demonstrate, in both memory and store mode:

- **NOT of a bare text column**: `where not flag` — `flag='abc'` (isTruthy false → NOT
  true → in scope) vs `flag='1'` (isTruthy true → NOT false → out of scope). Two in-scope
  rows sharing a code must be rejected by the UNIQUE; two out-of-scope rows sharing a code
  must be allowed.
- **Bare column as an AND / OR operand**: e.g. `where flag and othercol > 0` and
  `where flag or othercol > 0`, choosing data so the bare-`flag` truthiness (via `isTruthy`)
  is what flips scope.
- **Bare BLOB value**: `where blobcol` with `blobcol` a non-null blob (`x'00'` etc.) —
  `isTruthy(blob)=false` → predicate false → rows out of scope → duplicate codes allowed.

Each case should be expressed as an observable include/exclude (partial UNIQUE accept vs
reject, or partial-index-backed query result), matching the established test pattern so it
fails loudly if the truthiness mapping regresses. Run the focused file in both backends:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "10.5.1-partial"
```
and the same prefixed with `QUEREUS_TEST_STORE=true`.
