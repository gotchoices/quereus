description: Reworked `AsyncGatherNode`'s `zipByKey` combinator to Option A — per-branch key refs (`branchKeyAttrs`) plus gather-minted output key ids (`outputKeyAttrs`) — making a zipByKey node provenance-clean by construction so it passes `validatePhysicalTree`. The previously-skipped regression test is un-skipped and asserts no-throw.
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/runtime.md, tickets/backlog/parallel-async-gather-zip-by-key-rule.md
----

## Outcome

The `zipByKey` combinator's shared-key-id list (`keyAttrs: readonly number[]`) was
replaced with per-branch key refs (`branchKeyAttrs`) and gather-minted output key
ids (`outputKeyAttrs`). The gather *originates* the K merged key columns (their ids
appear in no child) and *forwards* each branch's non-key id (each in exactly one
child), so no id is output by two branches and `validatePhysicalTree` passes by
construction. `attribute-provenance.ts` was not modified. Implementation verified;
the design is sound and the diff is clean.

## Review findings

**Diff reviewed:** commit `8ee848e5` (implement stage) across all five touched
files, plus `attribute-provenance.ts` (confirmed untouched) to validate the
provenance claim.

### Correctness / provenance (the headline)
- **Verified.** Walked `computeAttributeProvenance`: minted `outputKeyAttrs` appear
  in no child → originated solely at the gather; branch non-key ids are forwarded
  (in `childIds`, skipped). The load-bearing disjointness check in
  `validateZipByKey` (`outputKeyAttrs` pairwise-distinct AND disjoint from every
  child id) is what guarantees the minted ids never collide with a forwarded id.
  Confirmed the validator also independently catches non-key-id collisions across
  branches (defense in depth). No correctness defects found.
- `getType`/`getAttributes` layout, key derivation, and nullability-OR are
  consistent between the two builder methods; output key is `[[0..K-1]]`,
  `isSet=false`. Position-independence (key at different index per branch) holds.
- `withChildren` passes the combinator verbatim, so minted `outputKeyAttrs` are
  stable across rebuild — verified by the un-changed-minting design (no minting in
  `buildAttributes`) and the rebuild test.

### Test coverage — gaps closed inline (minor)
The implementer flagged three untested validator paths. **Added all three** (now
passing, 70 AsyncGather tests, 0 fail):
- `zipByKey rejects duplicate ids within outputKeyAttrs` (exercises `seenOutput`).
- `zipByKey rejects branchKeyAttrs whose list count != branch count` (INTERNAL guard).
- `zipByKey rejects branchKeyAttrs with inconsistent per-branch K` (per-branch-K ERROR).

### Docs (minor — fixed inline)
- Stale doc comment in `ZipByKeyIndices.branchKeyIndices` still said "in `keyAttrs`
  order" → corrected to `branchKeyAttrs[b]`.
- `docs/runtime.md` § AsyncGatherNode zipByKey bullet was already rewritten by the
  implementer to the per-branch + minted-output model with the provenance
  statement — re-read and confirmed accurate.

### Deferred to the recognition-rule ticket (documented, not fixed here)
- **Collation agreement on merged key columns.** Construction validates *affinity*
  agreement across branches but not *collation*; the runtime comparator derives
  solely from branch 0 (`branchKeyIndices[0]`), so divergent per-branch collations
  on the same key position silently default to branch 0. Pre-existing, but more
  reachable now that key ids are distinct per branch. Not a defect for this ticket
  (no rule constructs zipByKey yet, and the fix requires a coalescing-collation
  design decision). Recorded as an open question in
  `tickets/backlog/parallel-async-gather-zip-by-key-rule.md` for the rule to
  resolve (and to optionally add a collation check to `validateZipByKey`).

### Observed, not actioned (no change warranted)
- `buildZipByKeyAttributes`/`getZipByKeyType` use `this.combinator as { ... }`
  rather than discriminated-union narrowing. Type-lazy but pre-existing style,
  and the methods are only reachable when `kind === 'zipByKey'`. Left as-is.
- **No end-to-end SQL test of an executed zipByKey plan** — there is still no rule
  that constructs one (backlog `parallel-async-gather-zip-by-key-rule`). Coverage
  is node-construction + validator + runtime-emitter units only; the provenance fix
  is verified structurally (validatePhysicalTree no-throw) but the integration of
  minted key ids with downstream resolution is unproven until the rule lands. This
  is in-scope-correct for this ticket; the rule ticket carries the e2e burden.

## Verification performed
- `yarn workspace @quereus/quereus build` — EXIT 0.
- `eslint` on the two touched src files + the spec — EXIT 0, clean.
- AsyncGather suite (`--grep AsyncGather`): 70 passing (67 prior + 3 added),
  1 pending (`QUEREUS_FORK_STRICT`-gated, skipped by default).
- Full quereus suite: **3522 passing, 9 pending, EXIT 0** (3519 + 3 new tests; no
  regressions).
