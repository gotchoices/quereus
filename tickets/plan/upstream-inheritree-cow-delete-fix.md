description: Upstream the inheritree COW-delete rebalance fix (currently a committed Yarn patch) to the inheritree repo, cut a release, bump the dep, and drop the patch.
prereq:
files:
  - .yarn/patches/inheritree-npm-0.3.4-ab742b70cb.patch   # the two-function fix to land upstream
  - packages/quereus/package.json                          # inheritree dep (currently a patch: resolution)
  - yarn.lock                                              # patch locator
difficulty: easy
----

# Upstream the `inheritree` COW range-delete fix and retire the local Yarn patch

The silent under-delete on non-front-anchored range `DELETE` (`id > 100`, `between`, `id % 2 = 0`)
was traced to a copy-on-write delete-rebalance bug in the `inheritree` B-tree and fixed via a
**committed Yarn patch** over the compiled `dist/b-tree.js` (see the completed ticket
`delete-range-predicate-under-deletes`). The patch is durable in-repo, but it lives over the
*compiled* dist (the npm package ships no `src/`), the sourcemap is not regenerated, and the
upstream source remains unchanged.

## The fix (two functions in `dist/b-tree.js`)

1. `leafSibPath(path, sib, delta)` — the cloned sibling Path must shift its deepest branch index
   by `delta` so it addresses the sibling's parent slot (`pIndex + delta`), not the deleted
   leaf's slot.
2. `replaceRootward(prior, segments, map)` — when the rootward walk reaches an *already-owned*
   ancestor (`seg.node.tree === this`), it must link `prior` into `seg.node.nodes[seg.index]`
   before returning, instead of returning unconditionally (which orphaned the freshly-cloned
   sibling/leaf). The `if (prior)` guard preserves the `mutableBranch(undefined, …)` entry path
   as a no-op.

Without these, a delete that triggers a sibling borrow/merge during rebalance orphaned the
freshly-cloned node, so the parent kept pointing at the original base node — dropping deletions
and producing phantom-repeated keys on iteration.

## Desired outcome

- Land the equivalent two-function fix in the upstream source at
  https://github.com/Digithought/Inheritree (the package author is the same project owner,
  Nathan Allan, so this should be low-friction), with a unit regression mirroring
  `packages/quereus/test/vtab/inheritree-cow-delete.spec.ts`.
- Cut a new `inheritree` release.
- Bump the quereus dependency to the released version and **remove** the `patch:` resolution in
  `packages/quereus/package.json`, the locator in `yarn.lock`, and the patch file under
  `.yarn/patches/`. (Leaving the `.gitignore` `.yarn/*` + `!.yarn/patches` rule in place is
  harmless.)
- Keep both regressions (`inheritree-cow-delete.spec.ts` and
  `test/logic/01.8.1-delete-range-cow.sqllogic`) green against the released version — they now
  guard the released package instead of the patch.

This is a future/external concern (depends on an upstream release), not active work — hence
backlog. The current patched state is correct and fully tested.
