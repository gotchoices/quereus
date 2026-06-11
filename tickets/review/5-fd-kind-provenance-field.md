description: Review phase 1 of FD direction B — required `kind: 'unique' | 'determination'` provenance field on FunctionalDependency, set at every construction site, spread-preserved through every transform, downgraded at fan-out sites. Pure metadata; behavior-neutral (no reader consults kind, all existing gates retained).
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/test/optimizer/fd-kind.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/optimizer.md
----

## What was implemented

Phase 1 of the approved direction B (parent plan `fd-determination-reader-side-preservation`,
phase 2 queued as `fd-determination-reader-side-rule`): a **required** `kind` field on
`FunctionalDependency` whose invariant is "`'unique'` ⟺ at most one row per distinct
determinant tuple on THIS relation (guard-scoped for guarded FDs)". Deliberately
behavior-neutral: no reader consults `kind`; `foldSingleSingleGated`, the
`activateGuardedFds` single↔single gate, the join equi-pair endpoint gate, the
project-node injective endpoint gate, and `dropSideKeyFds` are all unchanged.

### Construction sites (kind per site)

- `'unique'`: `superkeyToFd` and `singletonFd` (set inside the helpers — every caller
  audited: declared/projected keys, join `preservedKeys`, aggregate group key, set-op
  data-cols key, lens key obligations incl. the guarded row-time arm via
  `{ ...fd, guard }` spread, TVF-declared keys, all `addSingletonFd` callers);
  declared PK/UNIQUE seeding (`reference.ts`); partial-UNIQUE guarded FDs
  (`partial-unique-extraction.ts` — unique *within the guard's scope*).
- `'determination'`: all CHECK-derived FDs (12 sites in `check-extraction.ts`,
  guarded and unconditional; assertion hoist inherits via `{ ...fd, source }` spread);
  `extractEqualityFds` (incl. the deliberate `∅→col` constant-pin case);
  `expandEcsToFds`; injective-pair FDs (project-node, returning-node); join
  equi-pair FDs (join-utils).

### Transforms

`shiftFds`, `projectFds`, `stripGuard` now rebuild via spread, so `kind` — and, as the
free fix for the documented marker-loss problem, `source` and `valueEquality` too —
survive verbatim. `stripGuard` uses rest-destructuring to drop only `guard`.
Aggregate needed no edit (composes `projectFds` + `superkeyToFd`).

### Merge semantics ('unique' wins)

`fdsEqual` stays structural (kind not compared). `addFd`: on equal-determinant/
equal-guard merges the survivor is `'unique'` if either side is, including the
upgrade-in-place case (kept superset entry upgraded when the subsumed newcomer is
'unique') and the reverse (dropped 'unique' subset upgrades the surviving superset).
Object identity preserved when nothing changes. Equal-determinant entries with
incomparable dependent sets both survive with their own kinds (sound under-claim —
documented in the addFd doc comment). `enforceCap` now prefers `'unique'` FDs within
each partition (keyHints-preferred first, as before) when truncating.

### Fan-out downgrades

- `propagateJoinFds`: new `downgradeUniqueFds` helper applied to a non-preserved
  side on the inner/cross, left, and right arms — applied to what `dropSideKeyFds`
  KEEPS (guarded FDs included; a guarded partial-unique FD crossing a fanning join
  is no longer row-unique even within its guard's scope). Semi/anti and preserved
  sides untouched; `full` already drops everything. `dropSideKeyFds` itself stays.
- `async-gather-node.ts` crossProduct fold: a child's `'unique'` FDs stay unique
  only when every OTHER child is provably ≤1-row (`hasSingletonFd` per child);
  otherwise downgraded. The pre-existing missing-`dropSideKeyFds` gap at this site
  is now flagged in the code comment and deliberately NOT closed (phase 2 makes
  the drop obsolete).
- `fanout-lookup-join-node.ts` needed no edit: it delegates to `propagateJoinFds`
  with empty `preservedKeys`, so both sides downgrade automatically.

## Validation performed

- `yarn build` green; full `yarn test` green across all workspaces (5701 passing in
  `@quereus/quereus`, zero failures); `yarn workspace @quereus/quereus run lint` clean.
- New unit spec `test/optimizer/fd-kind.spec.ts` (13 tests): transforms preserve
  kind/source/valueEquality (incl. the projectFds empty-determinant exception for
  both kinds); addFd 'unique'-wins in both directions + upgrade-in-place + object
  identity + different-guards-never-merge; propagateJoinFds downgrade of a
  non-preserved side (guarded FD included — survives as guarded 'determination',
  not dropped, not unique), preserved-side preservation, left-outer downgrade,
  semi/anti verbatim, and the addFd-ordering test where a 'determination' equi-pair
  FD with determinants equal to the preserved key must not suppress the fresh
  'unique' key FD.
- `test/runtime/async-gather.spec.ts`: two new crossProduct tests — downgrade when
  another child fans out; keep-'unique' when every other child is ≤1-row (and the
  asymmetric case: the singleton child itself downgrades when fanned by a
  non-singleton sibling).
- Golden plan files regenerated (`UPDATE_PLANS=true yarn test:plans`): 3 files
  changed, diffs verified to be purely `"kind": "unique"` additions in serialized
  physical FDs — zero structural plan changes (the behavior-neutrality witness).
- Test FD literals migrated per-site with deliberate kinds (not bulk-defaulted):
  key-claim fixtures (`covering-structure`, `keysof-isunique`, `framework`,
  `property`, `parallel-eager-prefetch-probe`, zipByKey/unionAll fixtures in
  `async-gather.spec`) → 'unique'; generic transform-mechanics fixtures
  (`fd-propagation`) and the crossProduct fold fixtures → 'determination'; guarded
  fixtures in `conditional-fds` → 'unique' (modeling index-derived guarded FDs).
- `docs/optimizer.md` § Functional Dependency Tracking: new "`kind`: uniqueness
  provenance" subsection — invariant, per-site kind table, transform preservation,
  fan-out downgrade rule, 'unique'-wins merge, phase-1/phase-2 split.

## Review focus / use cases to probe

- **Soundness of every `'unique'` mint**: the inventory claims every `superkeyToFd`
  / `singletonFd` caller passes a genuine key. Spot-check the less obvious ones:
  set-op `membershipFds` (all-data-cols key on a DISTINCT set op),
  `rule-groupby-fd-simplification` (lifted source keys, ephemeral),
  lens-prover `encodeKeyFd` (guarded row-time arm spreads `{ ...fd, guard }` AFTER
  superkeyToFd — kind 'unique' survives, which is correct guarded-unique semantics).
- **Downgrade completeness**: are there fan-out producers OUTSIDE
  `propagateJoinFds`/async-gather/fanout-lookup that carry side FDs through?
  (I found none: bloom/merge/join nodes all delegate to `propagateJoinFds`.)
- **addFd merge edge**: equal determinants, equal guards, incomparable dependent
  sets — both entries kept with their own kinds. Sound (under-claim) but worth a
  second opinion on whether the 'unique' one should upgrade the other.
- **`enforceCap` reorder**: when the cap (64/node) is hit, the unique-first bias
  changes WHICH FDs are kept versus before. Cap-hit is rare/pathological and
  logged; suite shows no diffs — but it is technically a behavior change under cap
  pressure.

## Known gaps (honest notes)

- The ticket's edge case "preserved key coincides with a downgraded side FD" cannot
  literally arise inside one `propagateJoinFds` call: a downgraded side FD's
  determinants lie within a non-preserved side's columns, and any preserved key
  within that side would have made the side preserved; a spanning key's determinants
  can't equal a single-side FD's. The nearest reachable collision (downgraded-kind
  'determination' equi-pair FD vs the fresh 'unique' preserved-key FD, exercising
  the same addFd ordering hazard) is what fd-kind.spec.ts pins.
- Tests are run transpile-only (base tsconfig has `ts-node.transpileOnly: true` and
  excludes `test/` from tsc programs), so the "compiler walks you through the
  construction sites" sweep needed a temporary tsconfig (test include + exclude
  override) to surface the errors; that config was removed after the sweep reported
  zero remaining `FunctionalDependency` errors. Many PRE-EXISTING unrelated type
  errors exist in test files (function-type-guards, fuzz, emit-roundtrip-property,
  boundary-validation, …) that the normal pipeline never sees; untouched, and they
  fail no test command the project actually runs.
- Read-side local FD types in tests (keys-propagation, tvf-physical-properties,
  fd-equivalence, check-derived-fds, assertion-as-premise) parse JSON plan output
  and were left without `kind` on purpose — structural typing ignores the extra
  field on read.
- No direct unit test for the async-gather "every other child singleton" rule with
  ≥3 children (pairwise cases covered).
