description: REVIEW — membership-gated delete / data-update fan-out through an `except` / `intersect` subtree operand of a nested flagged set-op. Implements the correct support (the `nestable-flagged-set-ops` recursion was UNSOUND for non-union subtrees and was contained by rejecting); the fan now gates each leaf touch on the captured subtree-membership boundary flag so it reaches only genuine subtree members.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What landed

The fan-out recursion (`fanBranchDelete` / `fanBranchDataUpdate` in `set-op.ts`) previously
identified a leaf's affected rows purely by "data tuple ∈ `__vmupd_keys`", sound only when a
leaf's rows ⊆ the subtree's rows (union / union all). For `except` / `intersect` a leaf can hold
a row the subtree's set op EXCLUDES; when an outer operand makes such a row visible it entered
the capture and the naive recursion corrupted base rows. Review had CONTAINED this by rejecting
non-union subtree fan-out. This ticket implements the correct **membership-gated** fan.

### Mechanism

- **`gateFlags: readonly string[]`** is threaded down `fanBranchDataUpdate` / `fanBranchDelete`
  (default `[]` at the top-level `buildUpdate` / `buildDelete` calls). When descending a nested
  branch: a **union / union all** subtree passes `gateFlags` unchanged (leaf ⊆ subtree); an
  **`except` / `intersect`** subtree appends `branch.flag.name` (the OUTER compound's boundary
  flag for that side, e.g. `inSub`). At each LEAF the accumulated flags are AND-ed into the
  member-exists predicate as fresh `{ type:'column', name:flag, table:'k' }` conjuncts
  (`buildMemberExists(analysis, branch, gateFlags)`).
- **Conjunction at every non-union boundary** is required (not just the outermost). Verified for
  `A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))`: a member in C-only has
  `inS1=true` but `inS2=false`; gating on `inS1 AND inS2` skips C/D, gating on `inS1` alone would
  wrongly touch C.
- **`rejectNonUnionSubtreeFanout` → `gateFlagForNonUnionSubtree`**: returns `branch.flag.name`,
  or rejects (still naming `set-op-membership-nested-except`) only when the non-union boundary is
  **flag-less** — the lone remaining deferral (chosen policy).
- **Static surfaces** (`isSetOpBranchWritable` → `isSetOpBodyWritable` / `isOperandWritable`):
  `isSetOpBodyWritable` now computes per-side boundary-flag presence and threads it as
  `hasGatingFlag`. A non-union subtree operand is writable IFF its side carries a boundary flag.
  `schema.ts` (`deriveViewInfo` / `column_info`) needed no structural change — both surfaces are
  driven by `isSetOpBranchWritable` recursing correctly; a flagged except/intersect nested view
  now reports `is_updatable`/`is_deletable` = YES, `is_insertable_into` = NO. No stale
  except/intersect comments existed in `schema.ts`.

### Why it is sound

For a binary `B except C` the capture holds only members (B\C), so fanning to both leaves is
sound (C gets harmless no-ops). Gating the nested fan on the boundary flag restricts the capture
to members at that level, making the nested fan behave exactly like the proven binary fan. The
ONE shared up-front capture is unchanged (Halloween-safety preserved); only the member-exists
predicate gains conjuncts.

## Use cases / behavior to validate

Repro view: `A union[inA,inSub] (B except[inB,inC] C)`, with id=7 in A, B, AND C (captured
`inA=true, inSub=false` — visible only via A, NON-member of `B except C`):

- `delete from Vn where id=7` → removes id=7 from **A only** (B, C keep id=7/x=70).
- `update Vn set x=99 where id=7` → updates **A.x only** (B.x, C.x stay 70).
- `update Vn set inSub=false where id=7` → no-op (already a non-member).
- Dual (id in B only, `inSub=true`, genuine member) → fan reaches B, C no-ops; PutGet re-reads.
- `intersect` variant `A union[inA,inSub] (B intersect[inB,inC] C)`: non-member (`inSub=false`)
  untouched in B/C; member (`inSub=true`) deletes from both B and C.
- Flag-less `A union[inA] (B except C)`: still rejects (`set-op-membership-nested-except`);
  static all-`NO`.
- 3-level mix `A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))`: conjunction gate
  skips C/D where the row is a non-member at the intersect level.

## Tests

`property.spec.ts` § "Nested / subtree set-operation membership writes": the old containment
test was rewritten into the repro correctness test; added the dual, intersect variant,
flag-less-deferred, and 3-level-mix tests. All union-subtree tests stay green (no behavior
change for union / union all). 18/18 in the describe block pass.

## Validation performed

- `yarn workspace @quereus/quereus run lint` → exit 0, clean.
- Targeted: nested-subtree property tests → 18 passing.
- `yarn test` (full quereus suite) → **5333 passing, 9 pending, 0 failing**.

## Known gaps / reviewer focus

- **Flag-less non-union boundary is the chosen deferral.** Synthesizing the membership probe
  from leaf flags (`inB AND NOT inC`) is documented as a possible future enhancement, out of
  scope here. Confirm this policy is acceptable and that the rejection diagnostic is clear.
- **Data-fan value referencing a renamed leg column** — the pre-existing v1 caveat is unchanged
  (a leg rename of a referenced column is not remapped); the gate does not affect it, but worth
  confirming the gate composes with `set x = x + 1`-style values at depth (covered for the
  2-level case, not explicitly for except/intersect at depth — a reviewer could add one).
- **`set <subtreeFlag> = false` on an except/intersect subtree** routes through `fanBranchDelete`
  with the gate; covered for the repro (no-op on a non-member) but not for a genuine member of an
  except subtree dropping via the boundary flip — a reviewer may want an explicit positive case.
- **`column_info` per-column for the own subtree flag** (`inSub`) still reports `is_updatable =
  YES` (accurate for `= false`, optimistic for the still-deferred `= true` insert) — unchanged
  from the prior ticket; verify this is still the intended honesty posture for the gated shape.
- I did not run `yarn test:store` (LevelDB path) — the change is in the planner/mutation
  decomposition layer (storage-agnostic), so it is out of this ticket's scope, but a reviewer
  preparing a release may want to confirm.
