description: IMPLEMENT — membership-gated delete / data-update fan-out through an `except` / `intersect` subtree operand of a nested flagged set-op. The `nestable-flagged-set-ops` work made union / union all subtree operands recursively fannable; the same recursion is UNSOUND for `except` / `intersect` (review found it silently corrupted base rows and CONTAINED it by rejecting). This implements the correct support: gate each leaf touch on the captured subtree-membership flag so the fan only reaches genuine subtree members.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
effort: high
----

## Background (already researched — design is locked)

The fan-out recursion (`fanBranchDelete` / `fanBranchDataUpdate` in `set-op.ts`) identifies a
leaf's affected rows by "the leaf row whose data tuple ∈ `__vmupd_keys` (the one up-front
capture of the visible view rows matching the user WHERE)". Its soundness rests on **a leaf's
rows ⊆ the subtree's rows** — true for `union` / `union all`, FALSE for `except` / `intersect`
(a leaf can hold a row the subtree's own set op excludes). When an OUTER operand makes such an
excluded row visible, it enters the capture and the naive recursion deletes / mutates it in the
inner leaves even though its `inSub` membership probe reads `false` — silently corrupting base
rows the view never exposed as subtree members.

Review CONTAINED this by rejecting `except` / `intersect` subtree fan-out
(`rejectNonUnionSubtreeFanout`) and making the static surfaces report all-`NO` for such shapes
(`isUnionLikeSubtree` gate in `isOperandWritable`). The containment test
(`property.spec.ts` § "except / intersect subtree fan-out is deferred …") passes today.

### Repro (currently rejected; must become CORRECT after this ticket)

```sql
create table A (id integer primary key, x integer) using memory;
create table B (id integer primary key, x integer) using memory;
create table C (id integer primary key, x integer) using memory;
insert into A values (7, 70);   -- id=7 in A,
insert into B values (7, 70);   --        B,
insert into C values (7, 70);   --        and C
create view Vn as
  select id, x from A
  union exists left as inA, exists right as inSub
    (select id, x from B except exists left as inB, exists right as inC select id, x from C);
```

`(B except C)` EXCLUDES id=7 (it's in C). `Vn` shows id=7 only via A; the captured row has
`inA=true, inB=true, inC=true, inSub=false`. Correct post-fix behavior:

- `delete from Vn where id = 7` → deletes id=7 from **A only** (B and C untouched — non-members).
- `update Vn set x = 99 where id = 7` → updates **A.x only** (B, C untouched).
- `update Vn set inSub = false where id = 7` → no-op (inSub already false; the gated subtree
  delete fan touches nothing).

## The fix — membership-gated fan-out

Restrict the subtree fan to rows that are MEMBERS of the subtree, by AND-ing the captured
**subtree-membership boundary flag** into the leaf member-exists correlation.

### Where the gate comes from

The boundary flag is `branch.flag` of the nested branch — the flag the OUTER compound declared
for the subtree's side (`inSub` in the repro). It is a view output column, so it is in the
capture (`__vmupd_keys`); `k.inSub` directly probes "is this captured row a member of the
subtree". Gate on the **boundary** flag, NOT the leaf flags (`inB`/`inC`): id=7 has
`inB=true, inC=true` but `inSub=false`, so only the boundary flag distinguishes the non-member.

### Accumulate the gate at every non-union boundary descended

Thread `gateFlags: readonly string[]` down `fanBranchDelete` / `fanBranchDataUpdate` (default
`[]` at the top-level `buildDelete` / `buildUpdate` calls). When descending into a nested
branch:
- **union / union all** subtree → pass `gateFlags` unchanged (a union leaf ⊆ subtree, so the
  leaf-presence correlation already implies membership; nothing to add).
- **except / intersect** subtree → require `branch.flag`; recurse with
  `[...gateFlags, branch.flag.name]`. If `branch.flag` is absent (flag-less boundary), REJECT
  (deferred — see policy below).

At each LEAF, build the member-exists with the accumulated `gateFlags` AND-ed in.

**The conjunction-at-every-boundary is required, not optional.** Verified against
`A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))`: a member of
`B except (C∩D)` that is in C-only (not D) has `inS1=true` but `inS2=false`. Gating ONLY on
`inS1` would touch C (leaf-present + inS1) — wrong (delete of a view row must only remove from
B). Gating on `inS1 AND inS2` (=false) correctly skips C/D. Hence every non-union boundary's
flag must be declared and contribute to the gate.

### Why gating restores the binary invariant

For a binary `B except C` view (no outer operand), the capture comes from the real view, so it
holds ONLY members (B\C); fanning to both B and C is sound because C gets harmless no-ops (a
member isn't in C). Gating the nested fan on `k.inSub` restricts the capture to members at that
level — making the nested fan behave EXACTLY like the proven binary fan. So the per-operand fan
target is unchanged and matches existing binary `except`/`intersect` delete semantics
(`except`: effectively removes from the left leaf; `intersect`: removes from all member
branches). Halloween-safety is unchanged — still the ONE shared up-front capture, only the
member-exists predicate gains conjuncts.

### Flag-less non-union boundary — DEFERRED (chosen policy)

`A union[inA] (B except C)` (no `inSub`, possibly no inner flags) surfaces no boundary probe
column to gate on. **Keep this case deferred** (reject + static all-`NO`). Synthesizing the
membership probe from leaf flags (`inB AND NOT inC`) or into the capture is a possible future
enhancement, but is out of scope here — the uniform "gate = boundary flag" rule is simpler and
sound. Note this in the docs as the remaining deferral.

## Code changes (concrete)

### `set-op.ts`

- **`buildMemberExists(analysis, branch, gateFlags: readonly string[] = [])`** — after building
  the NULL-safe data-tuple `pred`, AND in a fresh `{ type: 'column', name: flag, table: 'k' }`
  for each `flag` in `gateFlags` (build fresh nodes per call — the gate is reused across
  leaves). `dataColCount > 0` guarantees `pred` exists, so the AND chain is straightforward.
  Update the JSDoc (it currently asserts the union "leaf ⊆ subtree" justification — extend it to
  the gated except/intersect case).

- **`fanBranchDataUpdate` / `fanBranchDelete`** — add `gateFlags: readonly string[] = []`
  parameter. In the `branch.isNested` arm, replace the `rejectNonUnionSubtreeFanout(view, branch)`
  call with: compute the subtree op (`(branch.view.selectAst as AST.SelectStmt).compound!.op`);
  if union-like, recurse with `gateFlags`; else require `branch.flag` (reject deferred if
  absent — see new `gateFlagForNonUnionSubtree` helper) and recurse with
  `[...gateFlags, branch.flag.name]`. In the LEAF arm, pass `gateFlags` to `buildMemberExists`.

- **Remove `rejectNonUnionSubtreeFanout`**; add a small helper, e.g.
  `gateFlagForNonUnionSubtree(view, branch): string` that returns `branch.flag.name` or raises a
  clean `unsupported-set-op` diagnostic naming `set-op-membership-nested-except` for the
  flag-less boundary (keep the slug referenced so the deferral is greppable).

- **`isOperandWritable(operand, hasGatingFlag: boolean)`** — an `except` / `intersect` subtree
  operand is now writable IFF a boundary flag is declared on the parent for its side. Thread
  `hasGatingFlag` from `isSetOpBodyWritable`:
  ```ts
  function isSetOpBodyWritable(sel: AST.SelectStmt): boolean {
    if (!sel.compound) return false;
    if (sel.limit || sel.offset) return false;
    const ex = sel.compound.existence ?? [];
    const leftFlag = ex.some(e => e.branch === 'left');
    const rightFlag = ex.some(e => e.branch === 'right');
    return isOperandWritable(leftBranchSelect(sel), leftFlag)
        && isOperandWritable(sel.compound.select, rightFlag);
  }
  ```
  In `isOperandWritable`, for a non-union subtree operand: `if (!hasGatingFlag) return false;`
  then fall through to `isSetOpBodyWritable(operand)`. Union operands ignore `hasGatingFlag`
  (no flag needed). Leaf operands unchanged. Update the JSDoc (currently states except/intersect
  subtree operands are categorically non-writable).

- **`isUnionLikeSubtree`** — keep the helper (still used to branch the gate logic), but update its
  JSDoc: except/intersect now SUPPORTED via the boundary-flag gate, not deferred.

- **Module doc comment (top of file)** + the `SetOpBranch.isNested` JSDoc — update the "except /
  intersect subtree is rejected" prose to the gated-fan semantics.

### `func/builtins/schema.ts`

`isSetOpBranchWritable` is the static gate for both `deriveViewInfo` and the `column_info`
walk; making it recurse-with-flag (above) is sufficient — both surfaces will now report a
flagged except/intersect nested view `is_updatable` / `is_deletable` = `YES`. `is_insertable_into`
stays `NO` (`setOpHasSubtreeOperand` unchanged — insert into a subtree is still
`set-op-membership-nested`). Verify the comments in `deriveViewInfo` / the `column_info` branch
(lines ~760, ~1090) that say "except / intersect subtree ⇒ all-NO" and update them to the gated
semantics. No structural change expected beyond `isSetOpBranchWritable` recursing correctly.

### `docs/view-updateability.md`

Replace the "deferred to `set-op-membership-nested-except`" notes (§ Nested / subtree operands,
~lines 371-379, 414-419, 459-482, and the § "Set-operation membership writes" intro ~388-394)
with the supported membership-gated semantics: a flagged `except` / `intersect` subtree operand
is now recursively writable for data UPDATE / DELETE / `set <subtreeFlag> = false` fan-out, the
fan being gated on the captured subtree-membership boundary flag (conjunction at every non-union
boundary). Keep the **flag-less non-union boundary** as the remaining deferral, named
`set-op-membership-nested-except`. Update the static-surface summary accordingly.

## Tests (`property.spec.ts` § Nested / subtree set-operation membership writes)

- **Rewrite** the existing "except / intersect subtree fan-out is deferred …" test into a
  CORRECTNESS test on the repro (id=7 in A, B, C): assert `delete from Vn where id=7` removes
  id=7 from A only (B, C keep id=7 / x=70); `update Vn set x=99 where id=7` sets A.x=99 only
  (B.x, C.x stay 70); `update Vn set inSub=false where id=7` is a no-op. Assert the captured
  probe `(inA, inSub) = (true, false)` still holds. Static surfaces now `is_updatable=YES`,
  `is_deletable=YES`, `is_insertable_into=NO`.
- **The dual** — a row that IS a genuine subtree member (e.g. id in B only, not in C): the fan
  reaches B (and the C leaf no-ops), the base rows update/delete correctly, and PutGet through
  the view re-reads.
- **`intersect` variant** — `A union[inA,inSub] (B intersect[inB,inC] C)`: a row in A and B but
  not C (non-member of `B∩C`, `inSub=false`) must NOT be touched in B/C by a delete/data-update;
  a row in A, B, AND C (member, `inSub=true`) deletes from both B and C (binary intersect
  semantics).
- **Flag-less non-union boundary** — `A union[inA] (B except C)` (no `inSub`): assert it still
  rejects (named `set-op-membership-nested-except`) and static surfaces report all-`NO`. (Policy:
  deferred.)
- **3-level mix** — `A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))` (or a
  simpler `A union (B except (C union D))`): seed so a member-in-C-only case exists and confirm
  the conjunction-gate skips C/D where the row is a non-member at the intersect level, and
  touches the correct leaves where it is a member.
- Keep the existing union-subtree tests green (no behavior change for union / union all).

## Validation

- `yarn workspace @quereus/quereus run lint` (single-quote the globs on Windows).
- Run the nested-subtree property tests:
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/property.spec.ts" --grep "Nested / subtree set-operation membership writes"` — stream with `2>&1 | tee /tmp/t.log; tail -n 40 /tmp/t.log`.
- Then `yarn test` (full quereus suite) to confirm no regression in the set-op / view-update
  surfaces.

## TODO

- [ ] `buildMemberExists`: add `gateFlags` param; AND `k.<flag>` conjuncts into the exists pred; update JSDoc.
- [ ] `fanBranchDelete` / `fanBranchDataUpdate`: thread `gateFlags`; gate at each non-union boundary; pass to leaf member-exists.
- [ ] Replace `rejectNonUnionSubtreeFanout` with `gateFlagForNonUnionSubtree` (rejects only the flag-less boundary, still naming `set-op-membership-nested-except`).
- [ ] `isSetOpBodyWritable` / `isOperandWritable`: thread `hasGatingFlag`; flagged non-union subtree operand becomes writable; update JSDoc + `isUnionLikeSubtree` JSDoc.
- [ ] Update module doc comment + `SetOpBranch.isNested` JSDoc in `set-op.ts`.
- [ ] `schema.ts`: confirm `deriveViewInfo` / `column_info` report YES/YES/NO for a flagged except/intersect nested view; update the stale "all-NO" comments.
- [ ] Rewrite the containment test into the repro correctness test; add the dual, intersect, flag-less-deferred, and 3-level-mix tests.
- [ ] Update `docs/view-updateability.md` (gated semantics; keep flag-less boundary deferred).
- [ ] Lint + run nested-subtree property tests + `yarn test`.
