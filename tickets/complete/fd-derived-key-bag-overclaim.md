description: `keysOf` read a bag as a set because determination/equality FDs (injective projections, join equi-pairs, fanned LEFT/RIGHT side keys, filter `a=b`) became all-columns-covering and `deriveKeysFromFds` derived a spurious unique key, dropping a required DISTINCT. Fixed producer-side at four sites: a determination/equality FD contributes an all-covering key only when an endpoint is a genuine superkey at that node; a fanned LEFT/RIGHT side's KEY FDs are dropped. Reader `deriveKeysFromFds` left untouched (keeps the lens physical-only-set case green).
files: packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/fd-propagation.spec.ts, packages/quereus/test/plan/aggregates/group-by.plan.json, packages/quereus/test/plan/joins/simple-join.plan.json, docs/optimizer.md
----

## Outcome

Implementation accepted. Producer-side gating at the four enumerated sites is sound and
correct; the reader `deriveKeysFromFds` is intentionally untouched (the documented
load-bearing decision — gating it on `isSet` would drop a real physical-only-set key and
keep a DISTINCT that should be eliminated; verified `lens-fd-contribution` still green).

One **minor** gap fixed inline (a missing RIGHT-outer DISTINCT repro). One **major**
finding filed as a new fix ticket (`fd-check-assertion-key-bag-overclaim`): the same
over-claim class survives at a fifth/sixth producer the ticket never enumerated.

## Review findings

### Verified correct (read the implement diff first, then the handoff)

- **All four producer gates are sound.** Project injective FD, join equi-pair FD, and
  filter `a=b` FD each emit the bidirectional determination only when an endpoint is a
  genuine superkey of that node's real keys (the probe set built independent of the FDs
  being gated); the fanned LEFT/RIGHT side's KEY FDs are dropped via `dropSideKeyFds`.
  The over-conservative direction is under-claim (a DISTINCT kept that was eliminable) —
  sound. No over-claim path remains at these four sites.
- **Probe-set isolation holds.** Join `equiKeyFds` is built from `preservedKeys` before
  the equi-pair loop mutates `fds`; project gate probes `projectedKeyFds` (the projected
  real keys), not the FDs it gates; filter gate probes `sourcePhysical.fds` (input FDs,
  pre-equality). An FD can never justify itself.
- **EC merges stay unconditional** at all sites — sound (value-equality), carries
  constant propagation, and ECs are not read by `keysOf`. Confirmed.
- **Guarded FDs correctly retained by `dropSideKeyFds`** — harmless because
  `deriveKeysFromFds` skips guarded FDs outright, so a retained guarded key FD can never
  produce a derived key. The one FD class not dropped is the one the reader ignores.
- **Plan goldens drift is exactly the gated removals.** `simple-join.plan.json` and
  `group-by.plan.json` are pure deletions (0 insertions / 32 deletions each) of the
  `{3}↔{4}` equi-pair determination FDs. Verified the `simple-join` query
  (`users JOIN departments ON u.dept_id = d.id`, `d.id` = PK) genuinely fans the
  departments side, so neither equi endpoint is a product superkey ⇒ correct removal;
  the genuine `users.id` key FD survives.
- **`extractEqualityFds` consumers audited.** The FilterNode is the sole consumer of the
  determination FDs from `extractEqualityFds`; `rule-predicate-inference-equivalence`
  destructures only `constantBindings`. No ungated reintroduction at the filter family.
- **Pattern-B under-claim (composite equi-key) confirmed sound, not a regression.** A
  multi-equi-pair join whose composite of equi columns is the real key derives no
  synonym key after gating (single-endpoint superkey test misses the composite) — an
  under-claim, sound, no golden regressed. Documented in the handoff; left as a possible
  future widening, not a bug.
- **Lint, typecheck, full suite green** (see Validation).

### Minor — fixed inline

- **RIGHT-outer arm had no dedicated DISTINCT repro** (handoff flagged only LEFT pinned;
  RIGHT covered only by fd-propagation symmetry). RIGHT joins are genuinely reachable
  (distinct `'right'` arm in `propagateJoinFds` and `runtime/emit/join.ts`, not
  normalized to LEFT). Added `site 3b` repro + control to
  `test/fd-derived-key-bag-overclaim.spec.ts`:
  `select distinct l.id, l.k from r right join l on r.w = l.k` (right side `l` fans out
  ⇒ DISTINCT must survive, 1 row) and a key-covered control (`r2.id = l.k` ⇒ no fan-out
  ⇒ DISTINCT eliminated). Both pass — confirms the right-arm `dropSideKeyFds`-before-shift
  path is live and the gate fires both ways.

### Major — filed as new fix ticket `fd-check-assertion-key-bag-overclaim`

- **The same over-claim survives at a fifth (CHECK-derived) and sixth (assertion-hoist)
  producer the ticket never enumerated — and it produces WRONG RESULTS.** Confirmed:

  ```sql
  create table tc (a integer, b integer, c integer, check (a = b));
  insert into tc values (1,1,10),(1,1,20),(2,2,30);
  select distinct a, b from tc;   -- returns 3 rows; correct is 2
  ```

  `getCheckExtraction` emits unconditional `{a}↔{b}` FDs that `TableReferenceNode`
  (`reference.ts` ~143-167) folds onto physical FDs; projecting away `c` leaves `{a}↔{b}`
  to make `{a}` an all-covering derived key, dropping the DISTINCT. The assertion-hoist
  path (`assertion-hoist-cache.ts`) folds the same shape. This is the identical root
  cause + reader (`keysOf` → `deriveKeysFromFds`) as this ticket but at producers outside
  its scope. Filed with repro, exact pointers, and the mirror-of-filter-site-4 gating
  approach. **It is a pre-existing defect, not a regression from this implementation**
  (no test fails; the implement diff does not touch `reference.ts` /
  `check-extraction.ts`), so it is a new fix ticket rather than a `.pre-existing-error`
  triage item.

### Not changed / explicitly empty

- **Docs:** `docs/optimizer.md` accurately reflects the shipped four-site gating (read
  every touched row: FilterNode, ProjectNode, Join inner/cross, Join left/right outer,
  and the key-coverage bullets). The check-constraint table row (line 1488) still
  describes the *raw* `extractCheckConstraints` bi-FD output, which is correct for the
  current (un-gated-at-consumption) state — the filed fix ticket owns that doc update
  when it gates the consumption site. No doc edit made here.
- **`isUnique` closure branch** (`fd-utils.ts` ~840): not consulted by the DISTINCT path
  for these repros (all pass); the concrete instance of its over-claim concern is the
  CHECK bug above, now tracked. No standalone audit finding beyond that.
- **`yarn test:store` / root multi-workspace `yarn test`:** not run — all changes are
  within `packages/quereus` planner FD logic with no storage/runtime surface. Unchanged
  from the implement-stage deferral; no reason found to revisit.

## Validation (review run)

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (incl. the new tests).
- Targeted: `fd-derived-key-bag-overclaim` (now **10**, +2 RIGHT) + `fd-propagation`
  (16) — green; plus `fanning-join-fd-overclaim` + `lens-fd-contribution` +
  `fd-equivalence` + all `test/plan/**` goldens (**139 passing**).
- Full quereus suite (`node test-runner.mjs`) — **5513 passing, 9 pending, 0 failing**
  (was 5511; +2 from the new RIGHT-arm tests).
