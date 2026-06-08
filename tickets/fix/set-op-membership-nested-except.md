description: FIX — membership-gated fan-out for `except` / `intersect` subtree operands of a nested flagged set-op. The `nestable-flagged-set-ops` work made union / union all subtree operands recursively writable for delete / data-update fan-out, but the same recursion is UNSOUND for `except` / `intersect` subtrees and was found (in review) to silently corrupt base rows. Review contained the corruption by REJECTING `except` / `intersect` subtree fan-out (`set-op-membership-nested-except`); this ticket implements correct support.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## The defect (found and contained in review of `nestable-flagged-set-ops`)

The fan-out recursion identifies a leaf's affected rows by "the leaf row whose data tuple ∈
`__vmupd_keys` (the up-front capture of the visible view rows matching the user WHERE)". Its
soundness rests on the invariant **a leaf's rows ⊆ the subtree's rows** — true for `union` /
`union all` (the result is a superset of each operand), but **false for `except` / `intersect`**:
a leaf can hold a row the subtree's own set operation EXCLUDES.

When an OUTER operand makes such an excluded row visible, the row enters the capture, and the
naive recursion deletes / mutates it in the inner leaves **even though its `inSub` membership
probe reads `false`** — i.e. the view never exposed that row as a member of the subtree. This
silently corrupts base rows the user's predicate did not select.

### Concrete repro (verified failing before containment)

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

-- (B except C) EXCLUDES id=7 (it's in C). Vn shows id=7 ONLY via A; inSub probes FALSE.
delete from Vn where id = 7;    -- BUG: also deleted id=7 from B and C (both non-members)
update Vn set x = 99 where id=7; -- BUG: also mutated B and C
```

`intersect` has the identical failure (a leaf row absent from `B intersect C`).

### Containment applied in review (current behavior)

`packages/quereus/src/planner/mutation/set-op.ts`:
- `rejectNonUnionSubtreeFanout(view, branch)` — called at the top of `fanBranchDataUpdate` and
  `fanBranchDelete` before recursing into a nested branch; raises `unsupported-set-op` naming
  `set-op-membership-nested-except` when the subtree operand's `compound.op` is `except` /
  `intersect`. Union / union all subtree fan-out is unaffected.
- `isOperandWritable` (the static probe) now treats an `except` / `intersect` compound operand
  as non-writable (`isUnionLikeSubtree` gate), so `view_info` / `column_info` report the
  conservative all-`NO` shape for such a view, agreeing with the dynamic reject.

Test: `property.spec.ts` § "except / intersect subtree fan-out is deferred (a leaf is not a
subset of the subtree)" asserts the reject + base-row integrity + static-surface agreement.

## The fix this ticket should deliver

Make delete / data-update fan-out through an `except` / `intersect` subtree **correct**, then
lift the `rejectNonUnionSubtreeFanout` guard and re-enable the static surfaces for these shapes.

**Approach (membership-gated fan-out).** The recursion must restrict the leaf touch to rows
that are MEMBERS of the subtree at that level, not merely present in the leaf. Concretely, the
member-exists correlation for a leaf inside an `except` / `intersect` subtree must additionally
require that the captured row is a member of the subtree — i.e. AND-in the subtree's membership
probe for the descended side.

Key design questions to resolve:

- **Where does the subtree-membership predicate come from?** The OUTER flag for the descended
  operand (`inSub`) is one probe captured in `__vmupd_keys`, but the recursion currently threads
  only the OUTER `analysis` + the current `branch` and LOSES the chain of which flag gates each
  subtree level. The fix likely threads an accumulated gating predicate (the conjunction of
  `k.<flag>` for each subtree boundary descended) down the recursion.
- **Flag-less subtree operands.** `A union[inA,inSub] (B except C)` declares `inSub` (so the
  probe exists), but a deeper flag-less `except` / `intersect` operand surfaces no probe column
  to gate on. Either require a flag on every non-union subtree boundary, synthesize the
  membership probe into the capture, or keep the flag-less non-union case deferred.
- **`except` right operand semantics.** For `B except C`, "member of the subtree" = in B and
  not in C. A delete of a subtree member should remove it from B (and is a no-op on C). Confirm
  the per-operand fan target matches the existing binary `except` / `intersect` delete fan-out
  semantics (which already fan to all member branches) and stays Halloween-safe under the one
  shared capture.

**Tests to add:** the repro above (delete + data-update must NOT touch the excluded leaf rows),
the dual where the row IS a genuine subtree member (must fan correctly), `intersect` variants,
flag-less non-union subtree (whatever the chosen policy), and a 3-level mix
(`A union (B except (C union D))`).

**Docs:** `docs/view-updateability.md` § Set-operation membership writes → Nested / subtree
operands — replace the "deferred to `set-op-membership-nested-except`" notes with the supported
semantics once landed.
