description: Wave 1 of the inclusion-dependency (IND) property rollout — a first-class, propagated `InclusionDependency` member on `PhysicalProperties.inds`, seeded from declared FKs at `TableReferenceNode`, propagated through joins/projections/pass-throughs with conservative drops, and backed by a property/law soundness harness. NO consumer reads `inds` this wave (Wave 2 prover + Wave 3 lens are the first readers); plans are byte-identical.
prereq:
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/alias-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/retrieve-node.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/ordinal-slice-node.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/test/optimizer/inclusion-dependencies.spec.ts, docs/optimizer.md
----

## Summary

Implemented and reviewed. A new `InclusionDependency` (IND) dependency-family
member on `PhysicalProperties.inds` asserts **existence**: for every row of a
node, the tuple at `cols` is guaranteed to appear in another relation's
`target.targetCols` (subject to `nullRejecting`). It is the *propagated*
companion to the FK-declaration-bound helpers in `util/ind-utils.ts` (which the
three IND rules still consume directly — this is a parallel derivation surface,
not a migration).

- **Types** (`plan-node.ts`): `InclusionDependency { cols, target, nullRejecting }`
  and `IndTarget` (`kind:'table'` FK-seeded form produced this wave; `kind:'relation'`
  reserved/unexercised for Wave-3 lens anchors). `cols[i]` pairs positionally with
  `targetCols[i]`; `targetCols` index the *target* relation, never remapped.
- **Helpers** (`fd-utils.ts`): `projectInds` (all-or-nothing drop), `shiftInds`
  (shift `cols`, not `targetCols`), `mergeInds`/`addInd` (structural dedup,
  `MAX_INDS_PER_NODE = 64` cap, logged truncations).
- **Seeding** (`ind-utils.ts` + `reference.ts`): `fkChildNullable` extracted as the
  single nullability bit (shared with `lookupCoveringFK`); `seedTableForeignKeyInds`
  emits one IND per declared FK whose referenced columns are exactly the parent PK.
- **Propagation**: joins (`propagateJoinInds`, wired into Join/Bloom/Merge **and
  FanOutLookupJoin** — see findings); Project/Returning via `projectInds`;
  pass-through (Filter, Alias, Sort, Distinct, scan family, Retrieve, LimitOffset,
  OrdinalSlice, EagerPrefetch); drop (Aggregate, SetOperation, Window; AsyncGather
  deferred).

## Review findings

Reviewed the implement-stage diff (`96dd2c87`) with fresh eyes against the
handoff, then audited from correctness / soundness / completeness / DRY / test
angles. The implementation is high-quality and the handoff is unusually honest
about its own gaps. One real propagation hole was found and fixed inline.

### Major — none filed as new tickets

No findings rose to "new ticket." The one propagation hole below was a small,
in-pattern, under-claim-safe fix squarely in scope, so it was fixed in this pass.

### Minor — fixed in this pass

- **`FanOutLookupJoinNode` dropped `inds` (missed propagation site).** This
  join-family node — produced by `rule-fanout-lookup-join`, which collapses a
  chain of FK→PK lookup joins (each a `JoinNode` that *does* propagate `inds`)
  into a single node — folds `fds`/`equivClasses`/`constantBindings`/
  `domainConstraints` through `propagateJoinFds` in its branch loop but never
  threaded `inds`. The handoff never mentioned this node. Effect: every plan where
  the fan-out rule fires (exactly the federated/FK-heavy path INDs target for Wave 2)
  silently lost the outer relation's seeded INDs. Under-claim ⇒ safe, but a real
  hole against the implementer's own stated principle ("wherever a node propagates
  `fds`, propagate `inds` the same way"). **Fixed** by threading `inds` through the
  fold via `propagateJoinInds`, mirroring the FD fold exactly (outer columns stay at
  their original indices ⇒ outer INDs unshifted; each inner branch's INDs shifted by
  the accumulated left width; left-mode branches drop the branch side). Confirmed the
  output column layout (`getType`: outer columns first, then branches) matches the
  `propagateJoinInds` shift model. Added a regression test ("keeps the outer FK-seeded
  INDs on the folded fan-out node") that exercises the real rule (3 NOT-NULL FK left
  joins over a high-latency module, concurrency=2) and asserts all three
  orders→cust/prod/region INDs survive on the folded node; it fails without the fix.
  Updated the docs propagation table with a `FanOutLookupJoinNode` row.

### Checked and accepted (no change)

- **Join `right`/`left`/`semi`/`anti`/`full` IND semantics match `propagateJoinFds`
  exactly** (verified the FD branch table, including the `right` = keep-shifted-right /
  drop-left case). Call sites (Join/Bloom/Merge) pass the same `leftColumnCount` to
  both FD and IND propagation.
- **Positional pairing in seeding is correct even when FK column order differs from
  PK order** — `cols = fk.columns`, `targetCols = resolveReferencedColumns(fk, parent)`
  (returned in FK order), so `cols[i]`↔`targetCols[i]` holds; the PK-membership check is
  order-independent (set), and a reordered `targetCols` still witnesses existence.
- **Ordered (not set) dedup for `cols`/`targetCols`** (handoff item 4): agreed with the
  deviation from `fdsEqual`'s set comparison — positional pairing is load-bearing, so a
  reordered twin is a genuinely distinct fact; over-keeping it is harmless (capped),
  collapsing it would lose an IND.
- **Golden plans cannot churn from `inds`**, independent of FK presence:
  `serializePlanTree` iterates a node's own enumerable properties and skips the
  `physical` getter, so the dependency families never reach golden output. Handoff's
  "golden compare ignores it" is correct (and stronger than stated).
- **Pass-through coverage is complete.** Audited all 22 `computePhysical` sites that set
  `fds:`. Every node that forwards `fds` now forwards `inds`, except the three deliberate
  drops (Aggregate/SetOperation/Window) and AsyncGather (deferred, commented). Leaf nodes
  with no FK-bearing source (Values, TableFunctionCall) correctly emit none.
- **WindowNode IND drop** (handoff item 1): accepted as the ticket-mandated conservative
  drop — under-claim, safe, documented; a legitimate future completeness improvement, not
  a bug.
- **`relation` IndTarget variant unexercised** (handoff item 3): accepted — enforcement-ready
  surface with no producer this wave; the property harness `continue`s on non-table targets,
  which Wave 3 must extend when it starts minting `kind:'relation'`.

### Tests / lint

- IND spec: **30 passing** (was 29; +1 fan-out regression test).
- Plan + optimizer + fanout-runtime suites: **1294 passing, 2 pending**, golden plans
  unchanged.
- Full `@quereus/quereus` suite: **3995 passing, 9 pending** (was 3994; +1 new test).
- Lint clean on all touched files. Build clean.

## Known gaps carried forward (unchanged from implement; not bugs)

- WindowNode drops INDs though row-preserving + append-only (under-claim; future
  completeness).
- Seeding covers FK → exactly-the-PK only (an FK to a non-PK UNIQUE key seeds nothing;
  mirrors `lookupCoveringFK`).
- Property harness is soundness-only, best-effort (40 fast-check runs, non-isolatable
  nodes skipped, `kind:'table'` targets only). A multi-hop A→B→C IND shape and the
  `kind:'relation'` branch remain unexercised until a producer/consumer lands.
- AsyncGather crossProduct IND shift+merge deferred (no consumer; commented).

## Out of scope (later waves — do not file here)

- Wave 2 `coverage-prover-ind-derived-no-row-loss` (first consumer; brings the first
  behavioral end-to-end coverage and must extend the harness `kind:'relation'` branch).
- Wave 3 `lens-multi-source-decomposition` (mints `kind:'relation'` anchors).
- AsyncGather crossProduct IND shift+merge.
