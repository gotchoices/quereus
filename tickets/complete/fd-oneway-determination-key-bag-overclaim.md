description: Gated the one-way single↔single producer FD `{a}→{b}` (from `check (b = a + 1)` / hoisted assertion) at `TableReferenceNode.computePhysical` on endpoint-superkey-ness, dropping the prior `equivPairs`-membership precondition. A narrow `select distinct a, b` over a non-keyed table no longer re-derives `{a}` as a phantom key and drops a REQUIRED DISTINCT (wrong results). Implemented via a shared `foldSingleSingleGated` helper reused by both the table-reference producer fold and the filter predicate-FD fold.
files: packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/check-derived-fds.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md
----

## What shipped

`check (b = a + 1)` (and its assertion-hoisted twin) emits the one-way FD
`{a}→{b}` with **no** equiv pair. The old `foldGatedProducerFds` gate skipped an
FD only when its unordered pair was in the producer's `equivPairs` — so the
one-way FD folded unconditionally, and on the 2-col output of `select distinct
a, b` over a non-keyed table `closure({a}) = {a,b} =` all cols, so `{a}` was read
as a phantom key and `rule-distinct-elimination` dropped a REQUIRED DISTINCT
(wrong results).

The fix extracts `foldSingleSingleGated(fds, producerFds, keyProbeFds, colCount,
{ skipGuarded })` into `fd-utils.ts`, gating **every** single↔single `{a}→{b}` FD
on endpoint-superkey-ness against `keyProbeFds` (keyed off the FD **shape**, never
the `valueEquality` marker). `reference.ts` (both CHECK + hoisted call sites,
`skipGuarded: true`) and `filter.ts` (predicate FDs, no `skipGuarded`) both use
it; the removed `foldGatedProducerFds` is gone. The EC merge stays unconditional
in each caller.

Tradeoff accepted (documented): drops the true one-way FD on non-keyed tables — a
sound under-claim, consistent with every sibling ticket. The reader-side
alternative (direction B) is filed as a backlog design ticket (see below).

## Review findings

**Diff reviewed first, with fresh eyes, before the handoff summary** (commit
`dc1a856c`). Then verified against the surrounding code and the producer
(`check-extraction.ts`).

### Correctness — checked, no defects

- **Faithful merge of the two prior gates.** Confirmed `foldSingleSingleGated`
  with `skipGuarded: false` reduces exactly to the old filter loop
  (`(!false || …)` ≡ `true`, so the condition collapses to `det===1 && dep===1`),
  and with `skipGuarded: true` reproduces the old reference gate's guarded-FD
  pass-through (`(!true || guard===undefined)` ≡ `guard===undefined`). Behavior
  is byte-for-byte equivalent except the intended new behavior: one-way FDs
  lacking an `equivPairs` entry are now gated (the bug fix). Bi-FD behavior
  (sites 5/6) unchanged because both directions are single↔single and were
  already gated.
- **OR-gate (a superkey OR b superkey) is sound in BOTH arms.** The non-obvious
  arm — folding `{a}→{b}` because the *dependent* `b` is a key — is sound:
  `a→b` (a determines b, functionally) combined with `b` unique forces `a`
  injective, so `{a}` is genuinely a key too. Verified the bijective reasoning
  against `isSuperkey`'s closure semantics (`fd-utils.ts:556`).
- **No multi-dependent bypass.** Audited `check-extraction.ts`
  (`handleEquality`): every recognized equality conjunct emits only
  single-*dependent* FDs (`{a}→{b}`, `∅→col`), and `walkConjunction` AND-splits,
  so `check (b = a+1 and c = a+2)` yields two separate single↔single FDs (both
  gated) — there is no path that produces a single-determinant multi-dependent
  FD `{a}→{b,c}` that could slip through the "multi-dependent passes through"
  branch. That branch is only ever exercised by partial-UNIQUE guarded FDs,
  which (a) are genuinely unique determinants and (b) flow through the separate
  `getPartialUniqueGuardedFds` loop, not this helper.
- **Guarded CHECK FDs (implication form, sites 7/8) still pass through the
  reference fold untouched** (`skipGuarded: true`) and are gated later at Filter
  activation (`activateGuardedFds`) — verified that path is unchanged and still
  uses `isSuperkey` (its only remaining use in `filter.ts`, so the import is
  live).
- **`equivPairs` is not dead** after `foldGatedProducerFds` lost its
  `equivPairs` arg — still consumed by the unconditional EC merge
  (`reference.ts:182-188`). No dangling references to the removed function
  anywhere in source/docs (only historical ticket text).
- **Type safety / cleanup.** `foldSingleSingleGated` is a pure, immutable
  (`addFd` returns fresh arrays) `ReadonlyArray`-typed function; no resources,
  no error paths to handle. `addFd` import dropped from `filter.ts`, `isSuperkey`
  import dropped from `reference.ts` — both confirmed unused there.

### Tests — adequate; one precision gap noted, no fix required

- Ran the **full** `@quereus/quereus` suite: **5527 passing, 9 pending**. Lint
  clean. (Targeted specs `fd-derived-key-bag-overclaim`,
  `optimizer/check-derived-fds`, `property` all included and green.)
- Coverage is good: wrong-results repros (site 9 CHECK + 9b assertion-hoist),
  the gated-away unit assertion on a non-keyed table, and the property-based
  differential (`tc` with `select distinct a, b`) that directly catches the
  dropped-DISTINCT class.
- **Minor precision gap (documented, not fixed):** the two "FD present / DISTINCT
  eliminated when `a` is the PK" *control* assertions (`check-derived-fds.spec`
  arm 2, and `fd-derived` site-9 control) do not strictly isolate the gate's
  *keep* branch — when `a` is the PK, the FD `{a}→{b}` / the key already exists
  from the declared key regardless of whether the gate's keep-branch ran, so the
  controls would pass even if the CHECK FD were dropped. The keep-branch's
  observable effect is exercised instead by the bi-FD sibling tests (where the
  kept reverse FD `{b}→{a}` is *not* implied by the key). Left as-is: the
  drop-branch + end-to-end DISTINCT behavior + bi-FD siblings fully pin the gate;
  strengthening the one-way keep-control would add no behavioral coverage.

### Docs — verified current

- `docs/optimizer.md` Check-derived contributions table: the `col = <expr>`
  row's old "**Known over-claim**" note is replaced with the gated/fixed
  behavior and the shared-gate reference. Confirmed no other doc/source site
  still describes the old ungated behavior or the removed function name.

### Major findings → filed

- **The accepted under-claim** (true determination FD lost on non-keyed tables)
  is a recurring design tradeoff deferred inline by *every* sibling ticket with
  no tracking item. Filed `tickets/backlog/fd-determination-underclaim-reader-side-preservation.md`
  consolidating the direction-B reader-side alternative for a one-time human
  decision (accept permanently vs. schedule B). No code action this pass.

### Not run

- `yarn test:store` / `test:full` — pure planner FD logic, no store-specific
  surface touched. Consistent with the implementer's deferral; a reviewer/CI may
  run out-of-band.

## Outcome

Implementation is correct, the shared-helper refactor is a faithful and DRY
merge of the two prior gates, tests and lint pass. No inline fixes were needed.
One backlog design ticket filed for the accepted under-claim.
