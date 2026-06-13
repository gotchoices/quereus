description: Review the inheritree COW-delete fix landed as a committed Yarn patch, plus the regressions. Verify the patch survives a clean install, the two-function change is correct, and the new tests genuinely guard the dependency.
files:
  - .yarn/patches/inheritree-npm-0.3.4-ab742b70cb.patch   # the committed fix (two functions in dist/b-tree.js)
  - .gitignore                                            # un-ignores .yarn/patches (line 6: `.yarn/*` + `!.yarn/patches`)
  - packages/quereus/package.json                         # inheritree now a patch: resolution
  - yarn.lock                                             # patch locator
  - packages/quereus/test/vtab/inheritree-cow-delete.spec.ts   # NEW — BTree-level COW-delete regression
  - packages/quereus/test/logic/01.8.1-delete-range-cow.sqllogic  # NEW — SQL-level range-delete regression
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts  # caveat dropped; bulk delete switched to `id > 100`
----

# Review: COW range-delete under-delete fixed via committed Yarn patch to `inheritree`

## What this ticket did (summary for the reviewer)

The implement stage landed the fix-stage's validated two-function repair of `inheritree`'s
copy-on-write delete bug and added regressions. The bug: a `DELETE` with a non-front-anchored
range predicate (`id > 100`, `between`, `id % 2 = 0`) silently under-deletes, leaving phantom
repeated keys (`161,161,161…`). Root cause is **not** in Quereus — the scan reads an immutable
snapshot and every delete is correctly issued — but in the inheritree B-tree's COW delete
rebalance path, where a sibling borrow/merge orphans the freshly-cloned node.

Changes:

1. **Committed Yarn patch** `.yarn/patches/inheritree-npm-0.3.4-ab742b70cb.patch` fixing two
   functions in `inheritree`'s `dist/b-tree.js`:
   - `leafSibPath(path, sib, delta)` — the cloned sibling Path now shifts its deepest branch
     index by `delta` so it points at the sibling's parent slot, not the deleted leaf's slot.
   - `replaceRootward(prior, segments, map)` — when it reaches an already-owned ancestor it now
     links `prior` into `seg.node.nodes[seg.index]` before returning (the `if (prior)` guard
     keeps it a no-op for the `mutableBranch(undefined, …)` entry path).
2. **`.gitignore`** changed `.yarn` → `.yarn/*` + `!.yarn/patches` so the patch is committed
   (everything else under `.yarn`, incl. `.yarn/releases` and `install-state.gz`, stays ignored
   exactly as before). `packages/quereus/package.json` now carries the `patch:` resolution and
   `yarn.lock` the locator.
3. **New BTree-level unit regression** (`test/vtab/inheritree-cow-delete.spec.ts`): builds a COW
   child `new BTree(keyFn, cmp, base)` over a 1..n base and deletes non-front-anchored sets
   (tail, between, `%2`, `%3`, random, high-edge), asserting matched==deleted, strict
   sorted-unique iteration (catches phantom dups), `get()` parity, and base-tree immutability.
   Two front-anchored controls document the bug-dodging shape.
4. **New SQL-level regression** (`test/logic/01.8.1-delete-range-cow.sqllogic`): n=200 tables
   (well past the 64-entry node capacity, so deletes force structural rebalancing), covering
   tail / interleaved / between / scattered / no-match predicates. Each asserts count,
   count(distinct), min/max/sum, a payload-integrity probe (`v <> id*10` ⇒ phantom alias), and
   that the deleted band is fully gone.
5. **`maintained-parent-fk.spec.ts`**: dropped the front-anchored caveat (old lines ~435-438),
   switched the bulk delete to the tail predicate `id > 100`, and updated the dependent
   min/max assertion to `{ mn: 1, mx: 100 }`.

## Validation performed (and how to reproduce)

- **Full quereus suite**: `cd packages/quereus && node test-runner.mjs` → **6108 passing, 9
  pending, 0 failing**.
- **Lint**: `yarn lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- **The unit test genuinely guards the dependency** — reverting the two functions in
  `node_modules/inheritree/dist/b-tree.js` to the buggy form makes **6 of 8** cases fail
  (the 2 front-anchored controls still pass), with the exact `strictly ascending after 161`
  phantom-key symptom and `key N present before delete` under-delete symptom. Re-`cp`ing the
  patched file restores green. This was done only in node_modules (gitignored); the working
  tree was never touched.
- **Store mode**: the new sqllogic file is not memory-only, so it also runs under
  `yarn test:store`. Verified directly: `QUEREUS_TEST_STORE=true … --grep 01.8.1-delete-range-cow`
  passes (LevelDB backend). The full `yarn test:store` was **not** run end-to-end (slow,
  store-specific; out of scope for an agent run).
- **Clean-install durability**: `yarn install` after `yarn patch-commit` re-applied the patch
  to `node_modules/inheritree/dist/b-tree.js` (both fix markers present). A fresh clone +
  `yarn install` should reproduce this because the patch and resolution are committed.

## Acceptance status

- [x] `delete from src where id > 100` over 200 rows leaves exactly 100 rows, none `> 100`
      (sqllogic case 1 + maintained-parent-fk).
- [x] Predicate matrix (`<= 100`, `> 100`, `>= 101` equiv, `between 51 and 150`, `% 2 = 0`,
      0-row, small/scattered) reports matched == deleted (unit + sqllogic).
- [x] `.sqllogic` regression covers tail / interleaved / between at n ≥ 130 (n = 200).
- [x] BTree-level unit regression on a COW base-inherited tree asserts count + sorted/unique.
- [x] `yarn test` green; `yarn lint` clean.

## What the reviewer should scrutinize (honest gaps / risks)

- **Patch is external and dist-only.** The fix lives in a Yarn patch over the *compiled*
  `dist/b-tree.js` (the npm package ships no `src/`). It is durable in-repo but the upstream
  `inheritree` source is unchanged. **Recommended follow-up (out of band, do not block):**
  upstream the same two-function fix to https://github.com/Digithought/Inheritree, cut a
  release, bump quereus's dep, then drop the Yarn patch. The package author is the same project
  owner (Nathan Allan), so this should be low-friction. Consider filing a `backlog/` ticket for it.
- **Sourcemap drift.** The patch adds lines to `dist/b-tree.js` but does not regenerate
  `dist/b-tree.js.map`. Stack-trace line numbers into inheritree may be off by a few lines.
  Cosmetic only — no runtime effect. Acceptable, but flagged.
- **`.gitignore` semantics.** Confirm `.yarn/*` + `!.yarn/patches` is the intended pattern:
  it keeps `.yarn/releases` and `.yarnrc.yml`-adjacent state ignored (as before) while tracking
  only `patches/`. The repo previously committed *no* `.yarn` content and relies on a global/
  corepack Yarn — this change does not alter that, it only adds the patches dir.
- **`get()`-based spot check freezes numbers.** The unit test stores plain `number` entries;
  `inheritree.insert` calls `Object.freeze`, a no-op for primitives. The real engine stores
  `Row` arrays — the COW mechanics are identical (key identity drives rebalance, not payload
  shape), but the unit test does not exercise array entries. The sqllogic + memory-vtab path
  covers the real `Row` shape end-to-end, so this is belt-and-suspenders, not a hole.
- **Store mode breadth.** Only the one new sqllogic file was spot-checked under store mode, not
  the whole `test:store` sweep. The fix is memory-vtab-specific (store uses a different backing),
  so this is expected to be neutral, but the full store sweep is left to CI.

## Notes

- Fix-stage temp artifacts and node_modules debug instrumentation were already removed by the
  prior stage; node_modules is now driven entirely by the committed patch via `yarn install`.
- No Quereus-side (scan/DML) code changed — by design. The deletes were always issued correctly;
  the data structure dropped them. See the implement ticket's rule-out notes for why a
  usage-level workaround was rejected.
