description: Upstream the inheritree COW-delete rebalance fix to the inheritree repo, cut a release, bump the dep, and drop the local Yarn patch.
prereq:
files:
  - .yarn/patches/inheritree-npm-0.3.4-ab742b70cb.patch   # the two-function patch to land upstream
  - packages/quereus/package.json                          # inheritree dep (currently a patch: resolution)
  - yarn.lock                                              # patch locator
  - packages/quereus/test/vtab/inheritree-cow-delete.spec.ts   # regression to mirror upstream
  - packages/quereus/test/logic/01.8.1-delete-range-cow.sqllogic
difficulty: easy
----

# Upstream the `inheritree` COW range-delete fix and retire the local Yarn patch

## Context

The silent under-delete on non-front-anchored range `DELETE` (`id > 100`, `between`, `id % 2 = 0`)
was traced to a copy-on-write delete-rebalance bug in the `inheritree` B-tree and fixed via a
committed Yarn patch over the compiled `dist/b-tree.js` (see completed ticket
`delete-range-predicate-under-deletes`). The patch is durable in-repo but lives over the
*compiled* dist — the npm package ships no `src/`, the sourcemap is not regenerated, and the
upstream source remains unfixed.

## The two-function fix (from the patch)

**`replaceRootward(prior, segments, map)`** — when the rootward walk reaches an *already-owned*
ancestor (`seg.node.tree === this`), it must link `prior` into `seg.node.nodes[seg.index]` before
returning, instead of returning unconditionally. The `if (prior)` guard preserves the
`mutableBranch(undefined, …)` no-op entry path:

```diff
 if (seg.node.tree === this) {
+    if (prior) {
+        seg.node.nodes[seg.index] = prior;
+    }
     return;
 }
```

**`leafSibPath(path, sib, delta)`** — the cloned sibling's deepest branch index must be shifted by
`delta` so it addresses the sibling's parent slot (`pIndex + delta`), not the deleted leaf's slot:

```diff
 function leafSibPath(path, sib, delta) {
-    return new Path(path.branches.map(b => b.clone()), sib, path.leafIndex + delta, path.on, path.version);
+    const branches = path.branches.map(b => b.clone());
+    if (branches.length > 0) {
+        branches[branches.length - 1].index += delta;
+    }
+    return new Path(branches, sib, path.leafIndex + delta, path.on, path.version);
 }
```

Without both fixes, a delete that triggers a sibling borrow/merge during rebalance orphans the
freshly-cloned node, causing the parent to retain the original base node — dropping deletions and
producing phantom-repeated keys on iteration.

## Work to do

### 1. Fix the TypeScript source in https://github.com/Digithought/Inheritree

Apply the equivalent logic change to the **TypeScript source** (not the compiled dist). The
compiled dist is what the patch touches, but the source is what needs to be fixed and re-compiled.
Add a unit regression test mirroring `packages/quereus/test/vtab/inheritree-cow-delete.spec.ts`
that exercises non-front-anchored range deletes through the COW path.

### 2. Cut an `inheritree` npm release

Publish a new patch version (e.g. `0.3.5`) to npm from the fixed source.

### 3. Bump the quereus dep and retire the patch

In this repo, once the released version is on npm:

- Update `packages/quereus/package.json`: change `"inheritree"` from the `patch:` locator to the
  plain released semver (e.g. `"^0.3.5"`).
- Run `yarn` to regenerate `yarn.lock`.
- Delete `.yarn/patches/inheritree-npm-0.3.4-ab742b70cb.patch`.
- Verify `packages/quereus/test/vtab/inheritree-cow-delete.spec.ts` and
  `test/logic/01.8.1-delete-range-cow.sqllogic` pass against the released package (they now guard
  the upstream fix instead of the patch).

## Why backlog

This depends on an external npm release from the upstream repo. The current patched state is
correct and fully tested; there is no urgency. Pick this up when doing an `inheritree` maintenance
pass or before a quereus release that needs a clean dep graph.
