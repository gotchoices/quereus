description: Review Wave 1 of the inclusion-dependency (IND) property rollout — a first-class, propagated `InclusionDependency` member added to the `PhysicalProperties` dependency family (beside `fds`/`equivClasses`/`constantBindings`/`domainConstraints`), seeded from declared FKs at `TableReferenceNode`, propagated through joins/projections/pass-throughs with conservative drops, and backed by a property/law soundness harness. NO consumer reads `inds` this wave (Wave 2 prover + Wave 3 lens are the first readers) — nothing user-visible changes, plans are byte-identical (golden plans confirmed unchanged).
prereq:
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/returning-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/alias-node.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/retrieve-node.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/src/planner/nodes/ordinal-slice-node.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/test/optimizer/inclusion-dependencies.spec.ts, docs/optimizer.md
----

## What landed

A new `InclusionDependency` (IND) dependency-family member on `PhysicalProperties.inds`.
An IND asserts **existence**: for every row of this node, the tuple at `cols` is
guaranteed to appear in another relation's `target.targetCols` (subject to
`nullRejecting`). It is the *propagated* companion to the FK-declaration-bound
helpers in `util/ind-utils.ts` (which the three IND rules still use directly and
which were **not** migrated).

### Types (`plan-node.ts`)
```ts
interface InclusionDependency { cols: readonly number[]; target: IndTarget; nullRejecting: boolean }
type IndTarget =
  | { kind: 'table'; schema: string; table: string; targetCols: readonly number[] }   // FK-seeded form (only one produced this wave)
  | { kind: 'relation'; relationId: string; targetCols: readonly number[] }            // reserved for Wave-3 lens anchors; NO producer yet
```
`cols[i]` pairs **positionally** with `targetCols[i]`. `targetCols` index the
*target* relation, so project/shift never remap them.

### Helpers (`fd-utils.ts`)
`projectInds` (all-or-nothing: drop if ANY `col` is projected away — no
partial-dependent survival; remap survivors; never remap `targetCols`),
`shiftInds` (shift `cols`, not `targetCols`), `mergeInds` / `addInd` (structural
dedup + `MAX_INDS_PER_NODE = 64` cap, truncations logged under
`quereus:planner:fd`).

### Seeding (`ind-utils.ts` + `reference.ts`)
`fkChildNullable` extracted as the single nullability bit (now also used by
`lookupCoveringFK` — no behavior change there). `seedTableForeignKeyInds` emits
one IND per declared FK whose referenced columns are exactly the parent PK;
`TableReferenceNode.computePhysical` calls it (needs `schemaManager` to resolve
the parent — always present in the real query path).

### Propagation
- Joins (`propagateJoinInds` in `join-utils.ts`, wired into Join/Bloom/Merge):
  inner/cross = union(left, shift(right)); left = keep left / drop right;
  right = keep shift(right) / drop left; semi/anti = left only; full = drop both.
- Project/Returning: `projectInds` through the column map.
- Pass-throughs (inherit verbatim): Filter, Alias, Sort, Distinct, scan family
  (SeqScan/IndexScan/IndexSeek), **Retrieve, LimitOffset, OrdinalSlice,
  EagerPrefetch** (see "Decisions beyond the ticket" below).
- Drop (emit none): Aggregate, SetOperation, Window. AsyncGather crossProduct
  IND-merge deferred with a comment (no consumer).

## How to validate

- **Build:** `yarn workspace @quereus/quereus run build` — clean.
- **Targeted spec:** `node --import ./packages/quereus/register.mjs ./node_modules/mocha/bin/mocha.js packages/quereus/test/optimizer/inclusion-dependencies.spec.ts --reporter spec` — 29 passing.
- **Optimizer + plan suites:** golden-plan tests unchanged (3 golden cases pass; `inds` adds no churn because golden tables carry no FKs / golden compare ignores it).
- **Full suite:** `yarn workspace @quereus/quereus run test` — 3994 passing, 9 pending.
- **Lint:** clean on all touched files.

### Test coverage in `inclusion-dependencies.spec.ts`
- **Helpers:** projectInds all-or-nothing drop, survivor remap, no-targetCols-remap, nullRejecting preserved; shiftInds shifts cols only; mergeInds/addInd dedup, distinct-fact retention, ordered-pair retention, cap.
- **Seeding:** composite NOT-NULL FK → one total IND (`nullRejecting:false`); nullable FK → `nullRejecting:true`; FK→non-PK → none; parent-no-PK → none; unresolvable parent → none.
- **Join branch table:** inner/cross union, left/right preserved-side keep + null-padded drop, full drops both, semi/anti left-only, empty-inputs → undefined.
- **End-to-end (real plans via `db.getPlan`):** child scan carries seeded IND (nullRejecting); project keeping FK col preserves; project dropping FK col drops it on the output node; inner join preserves (shifted); IND survives sort+limit pass-throughs.
- **Property/law harness (load-bearing):** fast-check over FK-valid random data across 11 query shapes; walks every relational node in the optimized tree, materializes each in isolation (emit + Scheduler, best-effort skip on non-isolatable nodes), and asserts every propagated IND actually holds (each row's `cols` projection — excluding NULL-rejected rows — is present in the target table's `targetCols` projection). Includes a negative self-test proving the detector fires.

## Known gaps / things to scrutinize (treat tests as a floor)

1. **WindowNode drops INDs although it is row-preserving and appends columns at
   the end** (source `cols` indices are unchanged). The ticket mandated the
   conservative drop ("identity-reshaping"); it is an **under-claim (safe)** but a
   real completeness gap — a window output could legitimately keep the source
   INDs. Worth a follow-up if Wave 2 wants INDs to survive window functions.
2. **Seeding only covers FK → exactly-the-PK.** An FK referencing a non-PK UNIQUE
   key seeds nothing (mirrors `lookupCoveringFK`, which is also PK-only).
   Completeness gap, not unsound.
3. **`relation` IndTarget variant is enforcement-ready but unexercised** — no
   producer mints it this wave, and the property harness only checks
   `kind:'table'`. When Wave 3 starts minting `kind:'relation'`, the harness's
   target-materialization branch must be extended (it currently `continue`s on
   non-table targets).
4. **Dedup uses ordered comparison for `cols`/`targetCols`** (stricter than
   `fdsEqual`'s set comparison) because positional pairing is load-bearing. This
   keeps a reordered twin as a distinct entry (harmless redundancy, capped) rather
   than risk collapsing two genuinely different facts. Deliberate; called out in a
   code comment. Confirm you agree with the deviation from "match the fdsEqual
   convention."
5. **Property harness is best-effort + bounded:** 40 fast-check runs; nodes that
   can't emit standalone are silently skipped; target tuples are materialized via
   `select * from <table>` assuming output column order == table column order
   (true for a single-table star scan). Soundness-only (a missing IND never reds
   it). Reviewer may want to raise `numRuns` or add a grandchild-chain (A→B→C) IND
   shape — the current data has p←c and pk2←c2 but no multi-hop propagation.
6. **No behavioral/consumer test exists** because no consumer reads `inds` this
   wave (by design). Validation is structural (plan inspection) + soundness
   (materialization). The first true end-to-end behavioral coverage arrives with
   the Wave-2 prover.

## Decisions beyond the literal ticket (please confirm)

- The ticket's explicit pass-through list named Filter/Alias/Sort/Distinct/scans,
  but its governing instruction was "wherever a node deliberately passes `fds`
  straight through, pass `inds` the same way." Following that, I **also** added
  `inds` pass-through to **RetrieveNode, LimitOffsetNode, OrdinalSliceNode,
  EagerPrefetchNode** (all documented bit-for-bit / row-reducing pass-throughs
  that forward `fds`). This is **necessary**, not cosmetic: `RetrieveNode` marks
  the module/Quereus execution boundary, and without its pass-through the seeded
  INDs would be lost at that boundary in every federated/Retrieve-wrapped plan —
  defeating the point of the propagated surface for Wave 2. WindowNode forwards
  `fds` but is the ticket-mandated IND exception (kept dropping).

## Out of scope (carried to later waves, do not file here)
- Wave 2 `coverage-prover-ind-derived-no-row-loss` (first consumer).
- Wave 3 `lens-multi-source-decomposition` (mints `kind:'relation'` anchors).
- AsyncGather crossProduct IND shift+merge (deferred, commented).

## Docs
`docs/optimizer.md` § "Functional Dependency Tracking" gains a sibling
"Inclusion Dependency Tracking" subsection (property shape, seeding source,
per-operator propagation table, over-claim-unsound/under-claim-safe boundary,
enforcement-readiness rationale, and an explicit "parallel derivation surface,
not a migration" cross-link to the existing § Inclusion-dependency reasoning).
The pre-existing "IND promotion note" was updated to reflect Wave 1 landing.
