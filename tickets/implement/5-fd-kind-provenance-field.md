description: Phase 1 of FD direction B — add a required, durable `kind: 'unique' | 'determination'` provenance field to FunctionalDependency, set correctly at every construction site, preserved verbatim through every FD transform, downgraded at fan-out sites. Pure metadata: NO reader changes, NO gate removal, zero behavior change.
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, docs/optimizer.md
----

## Context

Decision record in the parent plan ticket (`fd-determination-reader-side-preservation`,
2026-06-10): direction B approved — preserve true determination FDs on non-keyed
producers and make the FD *readers* provenance-aware, replacing the producer-side
single↔single drop gates. This ticket is **phase 1 of 2**: introduce the durable
provenance field and make it trustworthy everywhere. Phase 2
(`fd-determination-reader-side-rule`) flips the readers and removes the gates.

Phase 1 is deliberately **behavior-neutral**: no reader consults `kind` yet, all
existing gates (`foldSingleSingleGated`, the `activateGuardedFds` single↔single
gate, the join equi-pair endpoint gate, the project-node injective endpoint gate,
`dropSideKeyFds`) stay exactly as they are. `yarn test` must pass unchanged.
Splitting this way keeps each ticket one coherent agent run and guarantees no
unsound intermediate state: kind metadata is invisible until phase 2 reads it.

## The field and its invariant

```ts
export interface FunctionalDependency {
  readonly determinants: readonly number[];
  readonly dependents: readonly number[];
  readonly guard?: GuardPredicate;
  readonly source?: ConstraintProvenance;
  readonly valueEquality?: boolean;
  /**
   * Uniqueness provenance. REQUIRED — there is no implicit third state.
   * 'unique': the relation has at most one row per distinct determinant-tuple
   *           (for a guarded FD: restricted to rows satisfying the guard).
   *           This is a semantic claim about THIS relation, not a historical
   *           note about where the FD came from — any transform that can break
   *           row-uniqueness of the determinant set (fan-out) MUST downgrade.
   * 'determination': only the value claim — rows agreeing on the determinants
   *           agree on the dependents. Never implies row-uniqueness.
   */
  readonly kind: 'unique' | 'determination';
}
```

Making `kind` required (not optional) is load-bearing: the parent ticket's trap
was the `valueEquality` marker silently vanishing through `shiftFds`/`projectFds`.
A required field turns every construction site into a compile error until the
author decides which claim is being made, and a transform that rebuilds FD objects
without the field fails to typecheck.

## Kind at each construction site

'unique' (the determinant set is genuinely row-unique where the FD is minted):
- `superkeyToFd` (fd-utils.ts:548) — set `kind` inside the helper; every caller
  passes a genuine key (declared/projected keys, join `preservedKeys` from the
  fan-out-aware `analyzeJoinKeyCoverage`, aggregate group key, set-op data-cols
  key, lens-prover, table-function-call). Audit each caller while migrating and
  note any that is NOT a genuine uniqueness claim (none expected).
- `singletonFd` (fd-utils.ts:709) — ∅ row-unique ⟺ ≤1 row; every `addSingletonFd`
  caller (filter covered-key, values single-row, limit 1, pragma, analyze,
  declarative-schema, aggregate empty-group, table-access) asserts exactly that.
- `reference.ts:124` — declared PK/UNIQUE key FDs.
- `partial-unique-extraction.ts:132` — guarded `K → others [guard=P]` from a
  partial UNIQUE index: row-unique *within the guard's scope*, which is precisely
  the guarded-'unique' semantics above. Activation (`stripGuard`) at a Filter
  whose rows all satisfy P preserves 'unique' soundly **at that filter** — the
  fan-out hazard is handled by the join-side downgrade below, not here.

'determination' (value claim only):
- `extractEqualityFds` (fd-utils.ts:994/995 `{a}↔{b}`, and :1004/:1013 `∅→col`).
  The `∅→col` constant FDs being 'determination' is deliberate and important:
  a pinned column does NOT imply ≤1 row. (Phase 2 fixes a confirmed live
  wrong-results bug rooted in exactly this — see that ticket.)
- `check-extraction.ts` — ALL of :174/:175 (`{a}↔{b}` from `check (a = b)`),
  :183/:200 (`∅→col`), :191/:208 (one-way `{c}→{col}`), and the guarded
  variants :409/:410/:417/:424/:433/:440. A CHECK constrains values, never rows.
- `expandEcsToFds` (fd-utils.ts:75) — EC-derived bi-FDs (ephemeral closure
  reasoning, but must typecheck and must never claim uniqueness).
- `project-node.ts:309/310` and `returning-node.ts:260/261` — injective-pair
  bi-FDs (`select id, id+1`). Injectivity is a value bijection, not uniqueness;
  the existing endpoint gates stay in place this phase (project-node) /
  absent (returning-node — note: returning-node never had the gate; kind
  'determination' is what makes that omission harmless in phase 2).
- `join-utils.ts:306/307` — equi-pair bi-FDs (existing endpoint gate stays).

## Transforms preserve kind verbatim

- `shiftFds` / `projectFds` / `stripGuard` (fd-utils.ts:362/429/465): rebuild via
  spread (`{ ...fd, determinants, dependents, ... }`) so `kind` — and, as a free
  fix for the documented marker-loss problem, `source` and `valueEquality` too —
  survive verbatim. Soundness: shift is a column relabel; projection maps rows
  1:1 (no merge, no duplication) so determinant row-uniqueness survives whenever
  the determinants survive (which `projectFds` already requires); filtering rows
  (stripGuard activation context) only shrinks the row set.
- `projectFds` empty-determinant exception: an `∅→cols` FD surviving projection
  keeps its kind — a 'unique' singleton stays ≤1-row under projection ✓; a
  'determination' constant-pin stays a mere pin ✓.
- Aggregate (`propagateAggregateFds`) needs no edit: it composes `projectFds` +
  `superkeyToFd`. Soundness of kind-through-aggregate (for the reviewer): output
  rows are quotients of disjoint groups; projected determinants are group-by
  columns, so two output rows agreeing on a 'unique' determinant K would imply
  two source rows agreeing on K — contradiction. Preserving kind is sound.
- Filter pass-through, Distinct pass-through, Sort/Limit/Cache pass-through:
  row-subset or row-identical — no edits needed beyond what flows naturally.

## Merge semantics: 'unique' wins

`fdsEqual` stays structural (kind NOT compared, like `source`/`valueEquality`).
In `addFd`, when an existing FD and `next` have equal determinants and guards:

- the surviving entry's `kind` is `'unique'` if EITHER side is `'unique'`
  (uniqueness is a property of the determinant set; with equal determinants the
  claims compose). This includes the case where the existing entry subsumes
  `next` (dependents superset) but `next` is 'unique' and existing is
  'determination' — the existing entry must be *upgraded* in place (replace the
  array element with `{ ...existing, kind: 'unique' }`), not left stale.
- keep object identity (`===`) when nothing changes (don't churn arrays).

`enforceCap` quality bias: when truncating over the cap, prefer keeping
`kind === 'unique'` FDs ahead of determinations (in addition to the existing
`keyHints` preference). Evicting a uniqueness witness can only cause phase-2
under-claims (sound), but cheap to avoid.

## Downgrade at fan-out sites

A fanning operator duplicates rows of a side, destroying determinant
row-uniqueness while every value claim survives. Phase 1 adds the downgrade so
the kind invariant holds *everywhere* before any reader trusts it:

- `join-utils.ts propagateJoinFds`: for inner/cross/left/right arms, when a side
  is NOT preserved (`!leftPreserved` / `!rightPreserved` — the same predicates
  that currently drive `dropSideKeyFds`), map that side's surviving FDs through
  `fd.kind === 'unique' ? { ...fd, kind: 'determination' } : fd` — **including
  guarded FDs** (a guarded partial-unique FD crossing a fanning join is no
  longer row-unique even within its guard's scope; this is the root of the
  second confirmed live bug, fixed when phase 2 reads kind). `dropSideKeyFds`
  itself STAYS in phase 1 (old readers still key off coverage); the downgrade
  applies to what it keeps. Semi/anti and preserved sides: no downgrade (left
  rows pass ≤1:1). `full` already drops everything.
- `async-gather-node.ts:551` (crossProduct fold): same hazard, currently has NO
  side-key handling at all (comment claims "identical to N applications of
  JoinNode(cross)" but it never calls `dropSideKeyFds` — flag this in the code
  comment). Phase-1 rule: a child's 'unique' FDs keep 'unique' only when every
  OTHER child is provably ≤1-row (`hasSingletonFd` on the other children's fds
  over their colCounts); otherwise downgrade to 'determination'. Do not add the
  missing drop — phase 2 makes the drop obsolete.

## Tests

- Build green, `yarn test` green unchanged (behavior-neutral phase).
- Existing test files constructing FD literals will fail to compile until they
  declare `kind` — migrate them with the correct kind per the rules above (this
  is the compiler walking you through the construction-site inventory; do not
  bulk-default to one kind without looking).
- New unit spec (e.g. `test/fd-kind.spec.ts`): kind (and `source`/`valueEquality`)
  survive `shiftFds`, `projectFds`, `stripGuard`; `addFd` 'unique'-wins merge in
  both directions (including the upgrade-in-place case); join propagation
  downgrades a non-preserved side's unique FDs (guarded included) and preserves
  a preserved side's; semi/anti preserve kinds.
- `yarn workspace @quereus/quereus run lint` clean.

## Edge cases & interactions

- Guarded 'unique' FD crossing a fanning join → guarded 'determination' (NOT
  dropped, NOT left 'unique'). Pin with a unit test on `propagateJoinFds`.
- `addFd` upgrade-in-place when the subsumed newcomer is 'unique'.
- Equal-determinant FDs with DIFFERENT guards never merge (existing rule) — each
  keeps its own kind.
- `withKeyFds` layering in `propagateJoinFds` mints 'unique' from `preservedKeys`
  AFTER side-FD merge — ordering must not let a downgraded side FD suppress the
  fresh 'unique' key FD in `addFd` (the 'unique'-wins rule handles the collision;
  verify with a test where a preserved key coincides with a downgraded side FD).
- Zero-column relations: `singletonFd(0)` is undefined (unchanged paths).
- `mergeEquivClasses`/EC surfaces carry no kind — unchanged.
- Update `docs/optimizer.md` "Functional Dependency Tracking": document the
  field, its invariant, the per-site kind table, and the fan-out downgrade rule.

## TODO

- Add required `kind` to `FunctionalDependency` in plan-node.ts with the
  invariant doc above
- Set kind at every construction site per the inventory (compiler-driven sweep)
- Spread-preserve kind/source/valueEquality in shiftFds, projectFds, stripGuard
- 'unique'-wins merge + upgrade-in-place in addFd; cap bias toward 'unique'
- Fan-out downgrade in propagateJoinFds (all four fanning arms, guarded FDs
  included) and async-gather crossProduct fold
- Migrate test FD literals; add fd-kind.spec.ts unit coverage
- Update docs/optimizer.md FD section
- yarn build, yarn test, lint — all green, zero behavioral diffs expected
