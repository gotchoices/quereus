description: Fixed the silent under-delete on non-front-anchored range DELETE — root-caused to an inheritree COW delete-rebalance bug, fixed via a committed Yarn patch, with BTree-level + SQL-level regressions.
files:
  - .yarn/patches/inheritree-npm-0.3.4-ab742b70cb.patch
  - .gitignore
  - packages/quereus/package.json
  - yarn.lock
  - packages/quereus/test/vtab/inheritree-cow-delete.spec.ts
  - packages/quereus/test/logic/01.8.1-delete-range-cow.sqllogic
  - packages/quereus/test/runtime/maintained-parent-fk.spec.ts
----

# Completed: COW range-delete under-delete fixed via committed Yarn patch to `inheritree`

## What shipped

A `DELETE` with a non-front-anchored range predicate (`id > 100`, `between`, `id % 2 = 0`)
silently under-deleted, leaving phantom repeated keys. Root cause was **not** in Quereus — the
scan reads an immutable snapshot and every delete is correctly issued — but in `inheritree`'s
copy-on-write delete rebalance path, where a sibling borrow/merge orphaned the freshly-cloned
node so the parent kept pointing at the original base node.

Fix = a committed Yarn patch over `inheritree`'s compiled `dist/b-tree.js`, touching two
functions:

- `leafSibPath(path, sib, delta)` — the cloned sibling Path now shifts its deepest branch index
  by `delta` so it addresses the sibling's parent slot (`pIndex + delta`), not the deleted
  leaf's slot.
- `replaceRootward(prior, segments, map)` — on reaching an already-owned ancestor it now links
  `prior` into `seg.node.nodes[seg.index]` before returning; the `if (prior)` guard keeps the
  `mutableBranch(undefined, …)` entry path a no-op.

Supporting changes: `.gitignore` (`.yarn` → `.yarn/*` + `!.yarn/patches`), the `patch:`
resolution in `packages/quereus/package.json`, the `yarn.lock` locator, a BTree-level unit
regression, a SQL-level `.sqllogic` regression, and a tightened `maintained-parent-fk.spec.ts`
(bulk delete switched to the `id > 100` tail predicate that exercises the fixed path).

## Review findings

### Reviewed (with how)

- **Patch correctness (read in context, not just trusted).** Read both functions inside the live
  `rebalanceLeaf` / `mutableLeaf` / `replaceRootward` call graph in
  `node_modules/inheritree/dist/b-tree.js`. The two changes are mutually reinforcing: in the
  borrow path (`mutableLeaf(leafSibPath(path, rightSib, 1)…)` then `mutableLeaf(path)`), the
  `leafSibPath` index shift makes `replaceRootward` re-link the cloned sibling into the correct
  parent slot (`pIndex+delta`), and the `replaceRootward` owned-ancestor link re-attaches *both*
  the cloned sibling and the subsequently-cloned main leaf (`pIndex`) instead of orphaning them.
  The branches array is cloned (`path.branches.map(b => b.clone())`), so mutating the deepest
  index does not alias `path.branches`. The `if (prior)` guard correctly preserves the
  `mutableBranch(undefined, …)` entry path. **Correct.**
- **Adversarial revert test (ran it myself).** Reverted both functions to the buggy form in
  `node_modules` (gitignored), then ran the unit spec: it failed with the exact phantom-key
  symptom — `strictly ascending after <key>` at the iteration-monotonicity assertion
  (`inheritree-cow-delete.spec.ts:58`) on the very first non-front-anchored case. Restored the
  patched file (both fix markers re-verified present). The regression **genuinely guards** the
  dependency. (The runner bails on first failure, so it reports `1 failing` rather than the
  implementer's "6 of 8" full-run count — same conclusion.)
- **`.gitignore` semantics.** Confirmed `git check-ignore` still ignores `.yarn/releases` and
  `.yarn/install-state.gz`, while `git ls-files .yarn` tracks *only*
  `patches/inheritree-npm-0.3.4-ab742b70cb.patch`. Exactly the intended `.yarn/*` + `!.yarn/patches`
  behavior; no other `.yarn` content newly tracked.
- **Lint + full test suite (ran both).** `yarn lint` (eslint + `tsc -p tsconfig.test.json`)
  clean. `node test-runner.mjs` → **6108 passing, 9 pending, 0 failing**, matching the handoff.
- **sqllogic expected values (re-derived by hand).** All five cases arithmetically correct:
  tail (sum 5050), even (sum of first 100 odds = 10000), between 51–150 (survivor sum 10050),
  `%3` (66 removed → 134), no-match (200, sum 20100). count/distinct/min/max/payload-probe all
  consistent.
- **`maintained-parent-fk.spec.ts` change.** Bulk delete now `id > 100`; dependent assertion
  updated to `{ mn: 1, mx: 100 }` (survivors 1..100) — correct, and the test now doubles as a
  real engine-path regression for this bug.
- **Stray references.** Grepped for other comments/docs describing the bug as unfixed or the old
  front-anchored workaround; none remain outside the new tests. No engine-side scan/DML code
  changed (by design — deletes were always issued correctly).

### Minor (no fix needed — documented)

- **Sourcemap drift.** The patch adds lines to `dist/b-tree.js` without regenerating
  `dist/b-tree.js.map`; inheritree stack-trace line numbers may be off by a few. Cosmetic, no
  runtime effect.
- **Unit test uses primitive `number` entries, not `Row` arrays.** COW rebalance keys off key
  identity, not payload shape, so the mechanics are identical; the `.sqllogic` + memory-vtab
  path covers the real `Row` shape end-to-end. Belt-and-suspenders, not a hole.
- **Store-mode breadth.** Only the one new `.sqllogic` file was spot-checked under store mode
  (it passed on LevelDB); the full `yarn test:store` sweep is left to CI. The fix is
  memory-vtab-specific, so store mode is expected neutral.

### Major (filed as follow-up)

- **Upstream the fix and retire the local patch.** The fix lives over the *compiled* dist (no
  `src/` ships) as a committed Yarn patch. Filed `tickets/backlog/upstream-inheritree-cow-delete-fix.md`
  to land the same two-function fix upstream (Digithought/Inheritree), cut a release, bump the
  dep, and drop the patch + resolution + locator. Out-of-band external work; the current patched
  state is correct and fully tested in the meantime.

### Verdict

Implementation is correct, well-targeted, and well-guarded. No inline fixes required. One
backlog follow-up filed for upstreaming.
