description: Review hardening test coverage added for compilePredicate's truthiness change — operator-nested bare-value paths (NOT, AND/OR) and the bare-BLOB branch. Test-only change to 10.5.1-partial-indexes.sqllogic.
files: packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/util/comparison.ts
----

# rowtime-mv-predicate-truthy-extra-tests (review)

## What was done

Added a new `§ 9` to `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`
extending the regression coverage for `compilePredicate`'s engine-aligned truthiness
(`predicateTruthy` → canonical `isTruthy`). `§ 8` already pinned the **top-level**
bare-value path; `§ 9` pins the same `isTruthy` delegation reached through the
operator-nested `predicateTruthy` call sites the original diff edited, plus the
blob branch. **Test-only change — no source edits.**

Each case follows the established observable partial-UNIQUE accept/reject pattern
(a partial UNIQUE on `code` whose WHERE references the value under test): two
in-scope rows sharing a code must be rejected; two out-of-scope rows sharing a
code must be allowed. A truthiness regression flips scope and fails loudly.

- **9a — NOT of a bare text column** (`compileUnary` NOT branch, `predicate.ts:161-165`):
  `where not flag`. `flag='abc'` → `isTruthy` false → NOT true → **in scope** (dup
  rejected); `flag='1'` → `isTruthy` true → NOT false → **out of scope** (dup allowed).
- **9b — bare column as an AND operand** (`compileBinary` AND, `predicate.ts:201-210`):
  `where flag and othercol > 0`, with `othercol > 0` held TRUE (othercol=5) so the
  bare-`flag` truthiness is what flips scope. `flag='1'` → in; `flag='abc'` → out.
- **9c — bare column as an OR operand** (`compileBinary` OR, `predicate.ts:211-220`):
  `where flag or othercol > 0`, with `othercol > 0` held FALSE (othercol=0) so the
  bare-`flag` truthiness is what flips scope. `flag='1'` → in; `flag='abc'` → out.
- **9d — bare BLOB value** (`isTruthy` blob branch, `comparison.ts:414`):
  `where blobcol` with non-null blobs (`x'00'`, `x'01ff'`). `isTruthy(blob)` is false →
  both rows out of scope → duplicate code allowed (final select shows both rows). A
  regression treating blobs as truthy would put them in scope and turn the second
  insert into an (unexpected) UNIQUE error, failing the test.

## Verification done

Ran the focused file in both backends — both pass:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "10.5.1-partial"      # memory: 1 passing
QUEREUS_TEST_STORE=true … --grep "10.5.1-partial"                     # store:  1 passing
```

Confirmed both the memory module (`manager.ts` → `rowMatchesPredicate` /
`checkUniqueByScanning`) and the store module (`store-table.ts`, `store-module.ts`)
route partial-UNIQUE enforcement through `compilePredicate`, so both backends
genuinely exercise the operator-nested branches.

## Known gaps / reviewer notes

- **These are regression-hardening tests, not a bug fix.** The implementation was
  already reviewed correct under `rowtime-mv-minor-cleanups`; these cases traverse
  the same verified `isTruthy` delegation, just reached through operators.
- Cases assert at the **partial-UNIQUE enforcement** layer (runtime
  `compilePredicate.evaluate`). They deliberately do *not* probe the planner-side
  partial-unique-extraction FD producer (that rewrite — e.g. `NOT col` → `col = 0`
  for numeric only, see `§ 7j` / `§ 7j-NOT-on-TEXT`) is a separate code path and out
  of scope here. Final selects in `§ 9` carry no flag-filtering WHERE, so no FD
  discharge is involved — the assertions isolate index membership only.
- The blob case (9d) demonstrates only the out-of-scope/allow direction — there is no
  in-scope contrast row, because every blob is falsy under `isTruthy` (no truthy blob
  value exists to construct one). The regression guard is the *unexpected* UNIQUE
  error that would surface if blobs became truthy; worth a reviewer eye on whether
  that's a strong enough signal or whether a `typeof`/explicit-membership probe would
  add value.
- Did not run the full suite or `yarn build` — change is a single `.sqllogic` fixture
  with no TypeScript touched.
