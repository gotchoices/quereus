description: Fix silent under-delete on DELETE with a non-front-anchored range predicate. Root cause is a copy-on-write delete bug in the `inheritree` dependency (sibling borrow/merge during rebalance orphans the freshly-cloned node), NOT in the scan/DML loop. Validated 2-line library fix; land it as a committed Yarn patch and add regressions.
difficulty: medium
files:
  - node_modules/inheritree/dist/b-tree.js     # the bug + validated fix (apply via `yarn patch`)
  - packages/quereus/package.json              # inheritree dep (^0.3.4); patch reference lands here / root resolutions
  - .yarn/patches/                             # new — committed yarn patch for inheritree
  - packages/quereus/src/vtab/memory/layer/safe-iterate.ts   # scan cursor (verified CORRECT — no change needed)
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts  # drop the front-anchored caveat (lines ~435-438) once fixed
  - packages/quereus/test/logic/               # add .sqllogic range-delete regression
  - packages/quereus/test/vtab/               # add a BTree-level COW-delete unit regression
----

# DELETE with a leading-gap range predicate silently under-deletes — root-caused to an `inheritree` COW delete bug

## Status from the fix stage: reproduced, root-caused, and fix validated end-to-end

The bug reproduces exactly as described (autocommit, `pragma foreign_keys=false`,
plain table, no MV): `delete from src where id > 100` over 200 rows leaves 168 rows
(only 32 deleted), with surviving reads showing phantom-repeated keys (`161,161,161…`).

This stage **disproved the original hypothesis** (a delete-during-range-scan cursor
invalidation in the DML loop) and **isolated the true root cause** to the `inheritree`
B-tree dependency's copy-on-write delete path. A 2-line library fix was written and
validated: the full quereus suite passes (6104 passing, 0 failing) and a 200-seed
randomized mixed-op COW fuzz goes from *all-fail* to *all-pass*.

## What was ruled out (do NOT re-investigate these)

Instrumentation during the fix stage established:

- **The scan is correct.** `safeIterate` (`src/vtab/memory/layer/safe-iterate.ts`)
  reads a *stable, immutable* snapshot layer: across the whole failing delete, every
  yielded path reported `tree.isValid(path) === true` and there were **zero**
  invalidations. The scan correctly yields *all* matching keys (100..200).
- **The DML delete loop is correct.** `performDelete`
  (`src/vtab/memory/layer/manager.ts`) was called once per matching key (pk 101..200),
  each with `found === true`, all against the *same* pending transaction layer. Every
  delete is requested correctly.
- So neither "materialize keys first" nor "re-seek the cursor after a structural
  mutation" (the original ticket's suggested fixes) would help — the scan already reads
  an immutable snapshot and the deletes are all issued. **The deletes themselves are
  silently dropped by the BTree.**

The memory-vtab layer model already relies on the invariant *"SELECT iterates an
immutable layer while writes go to a fresh copy-on-write child BTree"* (see
`layer/connection.ts` savepoint comments and the collect-then-delete maintenance paths
at `manager.ts` ~1395 / ~1453). That invariant holds; the COW child BTree is what's
broken.

## Root cause (precise, validated)

Isolated against `inheritree@0.3.4` directly (no quereus involved):

- A **base-less** BTree deletes correctly for every key pattern.
- A **COW** BTree (one constructed with a `base`, i.e. exactly a `TransactionLayer`'s
  `primaryModifications`) **under-deletes** whenever a delete triggers a *sibling
  borrow or merge* during rebalance — i.e. whenever the deleted set is not
  front-anchored (deleting the leftmost leaf only ever borrows/merges with a *right*
  sibling, which dodges the bug; hence `id <= K` works and `id > K` / `between` / `%2`
  fail).

Two cooperating defects in `inheritree/dist/b-tree.js`:

1. **`leafSibPath(path, sib, delta)`** builds the sibling's Path by cloning the *main
   leaf's* branches verbatim — so the deepest branch index still points at the deleted
   leaf's slot (`pIndex`) instead of the sibling's slot (`pIndex + delta`). When COW
   re-rooting later consults that index, it targets the wrong parent slot.

2. **`replaceRootward(prior, segments, map)`** early-returns the moment it reaches an
   already-`this`-owned ancestor **without linking `prior` into it**. During a COW
   delete the parent was *already* cloned by `internalDelete`'s initial `mutableLeaf`,
   so when `rebalanceLeaf` then clones a *sibling* leaf, `replaceRootward` hits the
   owned parent and returns — leaving the freshly-cloned sibling **orphaned**. The
   parent keeps pointing at the original base sibling; the merge/borrow result is
   discarded and the base node is aliased into the live tree, producing both lost
   deletions and the phantom-repeated-key corruption (`dup` keys on iteration).

### Validated fix (apply both — neither alone is sufficient; fix-1 alone makes it worse)

In `inheritree`'s `b-tree.js` (and ideally upstream in its `src/b-tree.ts`):

```js
// 1) leafSibPath — point the deepest branch index at the sibling's slot
function leafSibPath(path, sib, delta) {
    const branches = path.branches.map(b => b.clone());
    if (branches.length > 0) {
        branches[branches.length - 1].index += delta;
    }
    return new Path(branches, sib, path.leafIndex + delta, path.on, path.version);
}

// 2) replaceRootward — when the ancestor is already owned, still link the new child
replaceRootward(prior, segments, map) {
    for (let i = segments.length - 1; i >= 0; --i) {
        const seg = segments[i];
        if (seg.node.tree === this) {
            if (prior) {
                seg.node.nodes[seg.index] = prior;
            }
            return;
        }
        const newBranch = seg.node.clone(this);
        if (prior) {
            newBranch.nodes[seg.index] = prior;
        }
        map.set(seg.node, newBranch);
        prior = newBranch;
    }
    this._root = prior;
}
```

(`mutableBranch` calls `replaceRootward(undefined, …)`, so the `if (prior)` guard makes
the change a no-op for that entry path — confirmed safe by the fuzz.)

### Evidence the fix is correct and complete

- Standalone `inheritree` COW probe: tail / between / `%2` / large-`%3` / random key
  sets all go BUG → OK; iteration order stays sorted with no duplicates.
- 200-seed randomized mixed insert/update/upsert/delete fuzz over COW trees:
  unpatched = **200/200 fail**, patched = **200/200 pass**, base tree integrity
  preserved every seed.
- The SQL matrix from the original ticket (`id <= 100`, `id > 100`, `id >= 101`,
  `between 51 and 150`, `id % 2 = 0`) all pass.
- Full quereus suite: **6104 passing, 9 pending, 0 failing**.

## Where the fix should land

`inheritree` is a published npm dependency (`packages/quereus/package.json` → `^0.3.4`,
authored by the same project owner). The compiled `dist/*.js` is what's consumed, so:

- **Primary (in-repo, durable):** apply the fix as a **committed Yarn patch**. This repo
  is Yarn 4.12.0, `nodeLinker: node-modules`, root `package.json` already has a
  `resolutions` block (no `.yarn/patches/` yet). Workflow:
  `yarn patch inheritree` → edit the two functions in the temp dir's `dist/b-tree.js`
  → `yarn patch-commit -s <dir>` (writes `.yarn/patches/inheritree-*.patch` and a
  `resolutions` entry). Run `yarn install` and confirm `node_modules/inheritree/dist/
  b-tree.js` carries the fix after a clean install.
- **Follow-up (out of band, optional):** upstream the same two-function fix to the
  `inheritree` repo and cut a release; once quereus bumps to it, the Yarn patch can be
  dropped. Note this in the review/complete handoff; do not block on it.

A pure quereus-side workaround is **not** appropriate here: the deletes are issued
correctly and dropped inside the BTree, so there is no usage-level change that avoids it
short of abandoning COW. Fix the data structure.

## Acceptance

- `delete from src where id > 100` over 200 rows leaves exactly 100 rows, none `> 100`.
- The full predicate matrix (`<= 100`, `> 100`, `>= 101`, `between 51 and 150`,
  `% 2 = 0`, plus a 0-row predicate and a small-n case) reports matched == deleted.
- A `.sqllogic` regression under `test/logic/` covers a tail predicate (`id > k`), an
  interleaved predicate (`id % 2 = 0`), and a `between` over a table large enough
  (n ≥ ~130) to force a b-tree structural change mid-delete.
- A BTree-level unit regression (under `test/vtab/`) deletes a non-front-anchored key
  set from a COW BTree (`new BTree(keyFn, cmp, base)`) and asserts exact remaining
  count + sorted/unique iteration — this guards the dependency directly and survives a
  future `yarn install` that might drop an un-committed patch.
- `yarn test` green; `yarn lint` clean.

## Notes / cleanup

- Drop the front-anchored caveat in
  `packages/quereus/test/runtime/maintained-parent-fk.spec.ts` (~lines 435-438) and
  switch that bulk delete to a tail predicate (e.g. `id > 100`) so it exercises the
  fixed path, per the original ticket's note.
- The fix-stage temporary artifacts (`_repro_delete.spec.ts`, `_btree_probe.mjs`) and
  the debug instrumentation were already removed; `node_modules` was restored to
  pristine so the bug is "live" until the Yarn patch lands.

## TODO

- [ ] Create the committed Yarn patch for `inheritree` applying the two-function fix
      above; confirm it survives a clean `yarn install`.
- [ ] Add a BTree-level COW-delete unit regression under `packages/quereus/test/vtab/`
      (non-front-anchored delete on a base-inherited BTree; assert count + sorted-unique).
- [ ] Add a `.sqllogic` regression under `packages/quereus/test/logic/` covering tail /
      interleaved / `between` deletes at n ≥ ~130.
- [ ] Remove the caveat comment and use a tail predicate in
      `maintained-parent-fk.spec.ts`.
- [ ] Run `yarn test` and `yarn lint`; confirm green.
- [ ] In the review/complete handoff, recommend upstreaming the fix to `inheritree` and
      bumping the dep so the Yarn patch can later be retired.
