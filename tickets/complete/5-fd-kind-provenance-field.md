description: COMPLETE — phase 1 of FD direction B: required `kind: 'unique' | 'determination'` provenance field on FunctionalDependency, set at every construction site, spread-preserved through every transform, downgraded at fan-out sites. Pure metadata; behavior-neutral (no reader consults kind, all existing gates retained). Reviewed and approved with three minor inline fixes.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/planner/nodes/table-function-call.ts, packages/quereus/test/optimizer/fd-kind.spec.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/optimizer.md
----

## What was implemented (summary)

Phase 1 of approved FD direction B (plan: `fd-determination-reader-side-preservation`;
phase 2: `fd-determination-reader-side-rule`). A **required** `kind` field on
`FunctionalDependency` with the invariant "`'unique'` ⟺ at most one row per distinct
determinant tuple on THIS relation (guard-scoped for guarded FDs)". Behavior-neutral:
no reader consults `kind`; all producer-side drop gates (`foldSingleSingleGated`,
guarded-activation single↔single gate, equi-pair endpoint gate, project-node injective
endpoint gate, `dropSideKeyFds`) retained for phase 2 to remove.

- `'unique'` minted by `superkeyToFd` / `singletonFd` (inside the helpers), declared
  PK/UNIQUE seeding, partial-UNIQUE guarded FDs.
- `'determination'` minted by all CHECK-derived FDs, `extractEqualityFds` (incl.
  `∅→col` constant pins), `expandEcsToFds`, injective-pair FDs, join equi-pair FDs.
- Transforms (`shiftFds`, `projectFds`, `stripGuard`) rebuild via spread, so `kind` —
  and, as a free fix, `source` / `valueEquality` — survive verbatim.
- `addFd` merges equal-determinant/equal-guard entries with "'unique' wins" (both
  directions, upgrade-in-place included); `enforceCap` prefers 'unique' FDs within
  each partition when truncating.
- Fan-out downgrades: `propagateJoinFds` non-preserved sides (inner/cross/left/right,
  guarded FDs included), AsyncGather crossProduct fold (a child keeps 'unique' only
  when every OTHER child is provably ≤1-row). `FanoutLookupJoinNode` inherits by
  delegating to `propagateJoinFds` with empty `preservedKeys`.

Golden plan diffs are purely additive `"kind"` fields — zero structural plan changes
(the behavior-neutrality witness).

## Review findings

Review performed against the implement diff (`8e49d34e`) with fresh eyes, before
reading the handoff summary. Full `yarn build`, `yarn workspace @quereus/quereus run
lint`, and `yarn test` run before and after review fixes — all green (5702 passing
in `@quereus/quereus` after the added test, zero failures across all workspaces).

### Checked — confirmed sound (no action)

- **Every `'unique'` mint audited** by enumerating all `determinants:` literal
  constructions in `src/` (all carry `kind`; the required field + green `yarn build`
  guarantees no site was missed) and all `superkeyToFd` / `singletonFd` /
  `addSingletonFd` callers:
  - set-op `membershipFds`: gated on `op !== 'unionAll'`; the remaining ops
    (union/intersect/except) are all DISTINCT semantics, so all-data-cols is a
    genuine key and the flag columns are functions of the data tuple. Sound.
  - `rule-groupby-fd-simplification`: lifts only `keysOf(source)` keys whose every
    column survives as a bare GROUP BY column — each group is then one source row,
    so the mapped columns are a genuine key of the aggregate output. Ephemeral
    (never lands on a node) besides.
  - lens-prover `encodeKeyFd`: the guarded row-time arm spreads `{ ...fd, guard }`
    AFTER `superkeyToFd`, so kind 'unique' survives — correct guarded-unique
    semantics for a NULL-skipping key. `AssertedKeysNode` merges these via `addFd`.
  - singleton sites (filter covered-key, values, LIMIT 1, pragma, analyze,
    declarative-schema, scalar aggregate, single-key table access): each proves
    ≤1 row at the site. Sound.
- **Downgrade completeness**: swept every node that carries child FDs forward.
  Pass-through sites (alias, distinct, sort, window, eager-prefetch, ordinal-slice,
  retrieve, lens-auxiliary-access, table-access, cache) are all 1:1 or
  row-shrinking — kind preservation sound. `AsofScanNode` emits exactly one row per
  left row (≤1 right match, NULL-pad in outer) and inherits left FDs only — no
  fan-out, no downgrade needed. UNION ALL paths (`SetOperationNode` without
  membership flags, AsyncGather unionAll/zipByKey) drop FDs entirely. Recursive CTE
  carries no FDs. No fan-out producer outside
  propagateJoinFds/async-gather/fanout-lookup was found.
- **`projectFds`/`shiftFds` guard handling**: the `{ ...fd }` spread cannot leak a
  stale guard — guarded FDs either get a fully remapped `newGuard` or are dropped
  before the push.
- **`stripGuard` preserving 'unique'**: sound at the activating Filter (rows all
  satisfy the guard; filtering shrinks the row set; fan-out hazards are handled at
  the join downgrade before the FD ever reaches the filter).
- **addFd merge edges**: the upgrade bookkeeping (`nextKind` for dropped-subset
  uniques, in-place upgrade for subsumed newcomers) is correct for every list
  `addFd`/`mergeFds` can actually produce (equal-determinant entries are always
  dependent-incomparable by construction; raw-push producer lists only contain
  single-dependent or disjoint-dependent shapes). The theoretical chain
  "dropped 'unique' subset upgrades `nextKind`, then `next` is subsumed by a third
  equal-det entry that only checks `next.kind`" requires a list containing two
  comparable equal-det entries — unreachable; and its failure mode is an
  under-claim (lost 'unique'), which is sound.
- **Equal-determinant incomparable-dependents both-survive rule**: agreed sound
  (under-claim at worst); second opinion requested by the handoff — upgrading the
  sibling would also be sound (uniqueness is a determinant-set property) but is not
  needed by any phase-2 reader, so leaving it is the right call.
- **`enforceCap` reorder**: a behavior change only under cap pressure (64 FDs/node,
  logged, exercised by zero tests); the bias only changes WHICH sound facts are
  kept. Accepted.
- **Test fixture kind migrations**: per-site choices verified reasonable
  (key-claim fixtures → 'unique', transform-mechanics fixtures → 'determination',
  conditional-fds guarded fixtures → 'unique' modeling index-derived guarded FDs).
  Read-side test FD literals parsing JSON plan output correctly left without `kind`
  (structural typing ignores extras on read).
- **Golden plan diffs**: inspected — purely additive `"kind": "unique"` lines.
- **Docs**: `docs/optimizer.md` § "`kind`: uniqueness provenance" verified accurate
  against the implementation (invariant, site table, transforms, downgrades,
  merge rule, phase split).
- **Workspace sweep**: no other package (plugins, quoomb, sync) constructs
  `FunctionalDependency` objects; no in-repo builtin TVF advertises raw `fds`
  (they advertise `keys`, which mint 'unique' via `superkeyToFd`).

### Found — minor, fixed in this pass

1. **AsyncGather `childIsSingleton` inherits `hasSingletonFd`'s pre-phase-2
   over-claim.** `hasSingletonFd` is pure closure coverage, so 'determination'
   constant pins covering all columns of a bag read as "≤1 row" (exactly phase 2's
   confirmed bug 1), which would let a sibling keep an unsound 'unique'. This is
   bounded and self-healing: phase 2 rewrites `hasSingletonFd` kind-aware (its
   signature change forces this call site to be revisited), and in phase 1 no
   reader consults kind. Fixed inline with a NOTE comment at the probe pointing at
   `fd-determination-reader-side-rule` bug 1 so the connection is explicit.
2. **TVF-advertised FDs could enter the system without a valid `kind`.**
   Plain-JS plugins bypass the type system; `validateFds` checked indices but not
   `kind`. A missing/garbage kind degrades safely today (treated as non-'unique'
   everywhere), but it silently violates the "required, no third state" invariant.
   Fixed inline: `validateFds` now rejects (logs and drops the advertisement)
   unless `kind` is `'unique'` or `'determination'` — consistent with the existing
   validation style.
3. **The 2-child async-gather tests could not distinguish the every-OTHER-child
   quantifier from a buggy some-other.** Added a 3-child crossProduct test (one
   singleton sibling + one fanning sibling ⇒ all 'unique' claims downgrade),
   closing the handoff's stated coverage gap.

### Found — not fixed, with reason

- The known missing-`dropSideKeyFds` gap in the AsyncGather crossProduct fold stays
  open deliberately (flagged in a code comment by the implementer): the kind
  downgrade records the uniqueness loss on the FD itself, and phase 2's reader rule
  makes the drop obsolete. Closing it now would be churn.
- `propagateJoinFds('full')` returns `{}` without even `withKeyFds` — pre-existing
  conservatism predating this ticket, untouched by the diff, sound (under-claim).
- Pre-existing type errors in test files outside the executed pipeline
  (function-type-guards, fuzz, emit-roundtrip-property, …) — untouched; they fail
  no command the project runs (tests are transpile-only).

### Empty categories

- No major findings — nothing warranted a new fix/plan ticket. The only soundness
  hazard found (finding 1) is already the centerpiece of the queued phase-2 ticket
  `fd-determination-reader-side-rule`, with the repro recorded there.
- No regressions: full suite green before and after review fixes; plan goldens
  unchanged by the review pass.
