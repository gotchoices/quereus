description: Static surfaces (`view_info` / `column_info`) gate the set-op membership-writable claim on the same branch shape the dynamic write enforces, so a non-writable membership body reports the conservative non-writable shape instead of over-claiming from the membership flag's presence alone.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What landed

A catalog-honesty fix: the static surfaces no longer over-claim writable for a set-op
membership body whose operands (or outer modifiers) the dynamic write would reject.

**New probe (`planner/mutation/set-op.ts`).** `isSetOpBranchWritable(selectAst): boolean` —
AST-only, non-throwing. Returns `false` for: an outer `LIMIT`/`OFFSET` (added in review — see
below), a non-`select` body, a non-SELECT right operand, a `select *` leg (either side), a
computed (non-plain-`column`) leg (either side), or legs whose plain-column counts disagree.
The static shadow of `analyzeSetOpView`'s pre-write rejections. Branch-shape half is
non-recursive (one level). The non-throwing core `tryBranchColumnNames` is shared with the
dynamic path's throwing `branchColumnNames` (refactored to delegate + re-derive the per-side
diagnostic), so the two paths cannot drift on what a writable leg is.

**Wiring (`func/builtins/schema.ts`).** `deriveViewInfo` returns `CONSERVATIVE_VIEW_INFO` for
a membership body failing the probe; `deriveColumnInfo`'s all-`YES` short-circuit is gated
`isSetOpMembershipBody(...) && isSetOpBranchWritable(...)`, with a non-writable body falling
through to the per-column walk (which reports every column `is_updatable='NO'` / null base,
because `SetOperationNode.membershipLineage()` threads `updateLineage` only for the read-only
`set-op-branch` flag attrs and none for data columns).

**Docs.** `docs/view-updateability.md` § Set-operation membership writes documents the gate.

## Review findings

**Scope checked:** the implement-stage diff (set-op.ts probe + branchColumnNames refactor,
schema.ts wiring, property.spec.ts tests, view-updateability.md); the probe's correspondence
to *every* rejection in `analyzeSetOpView` (not just the four the ticket named); the
`deriveColumnInfo` fall-through correctness against `SetOperationNode.computePhysical` /
`membershipLineage()` and `baseSiteOf`; consumer fan-out of `isSetOpBranchWritable`; lint;
full test suite; source build.

**Major — found and FIXED inline (over-claim gap, the ticket's own bug class).**
The probe shadowed only the four *branch-shape* rejections and missed `analyzeSetOpView`'s
**outer `LIMIT`/`OFFSET` reject** (`unsupported-limit`, set-op.ts:204-210), which fires
*before* branch analysis. A membership view with plain legs but an outer `limit`/`offset`
therefore still over-claimed: `view_info` reported `YES/YES/YES` and `column_info` all-`YES`,
while the dynamic `update` threw `a LIMIT/OFFSET set-operation body is not decomposable` —
exactly the static-vs-dynamic disagreement this ticket set out to eliminate. Pre-existing
(the set-op gate always reported writable), not introduced here, but squarely in scope.
*Fix:* `isSetOpBranchWritable` now returns `false` on `selectAst.limit || selectAst.offset`;
its doc + both `schema.ts` call-site comments + `view-updateability.md` updated to list it;
added a regression test (`an outer LIMIT/OFFSET set-op view reports the non-writable shape`)
asserting `view_info` all-`NO`, `column_info` all-`NO`/null base, and that the dynamic write
still throws. Verified the over-claim before the fix and the agreement after (rebuilt dist).

**Probe-vs-dynamic parity audit (no gaps remaining).** Walked every `analyzeSetOpView`
rejection: `not-a-select` / `diff` / empty-existence are subsumed by the upstream
`isSetOpMembershipBody` guard; `dataColCount <= 0` cannot occur once both legs are plain
(≥1 column each); the arity reject is equivalent to the probe's `leftNames.length ===
rightNames.length` (set-op output arity = left arity = `dataColCount`); `LIMIT/OFFSET` was
the one miss, now closed. Statement-level rejections (conflicting flips, non-literal flags,
RETURNING) are per-write, not view-shape, and correctly out of scope for a static surface.

**Implementer's flagged "fall-through vs. explicit return" concern — resolved, no change
needed.** The worry was an untested future regression where the per-column walk resolves a
base site for a set-op *data* column (re-introducing over-claim). It is now test-pinned: the
computed-leg / `select *` / LIMIT regression tests all assert `base_table === null` and
`is_updatable === 'NO'` for **every** column of a non-writable set-op view, so any future
lineage change that resolved a data-column base would flip those to non-null/`YES` and fail.
The minimal-diff fall-through is acceptable.

**Minor / non-goals — confirmed correct, no action (explicitly, with reason):**
- *Nested-compound one-level over-claim* — a right operand that is itself a compound with a
  plain first leg passes both the probe and the dynamic shape check; the nested reject is
  deferred to write-time `propagate` (`set-op-membership-nested`). Static and dynamic agree
  (both pass shape, both reject later) — parity preserved, tracked under the existing nested
  ticket. Not a regression.
- *Probe is shape-only, not deep* (does not verify a leg's base is itself writable) — parity
  with the dynamic per-side path, which also defers to the branch's own `propagate`.
  Intentional.
- *Per-side diagnostic message text unasserted* — the two `update … throws` assertions cover
  the boolean reject for the computed-leg and `*`-leg paths; the specific wording is a
  verbatim copy of the original branch checks. Low value to assert; left as-is.

**Empty categories:** no new fix/plan/backlog tickets filed — the one real finding was small
and adjacent to the touched code, so it was fixed in this pass rather than deferred.

## Validation

- `yarn lint` (quereus): clean.
- `node test-runner.mjs` (full quereus suite): **4888 passing / 9 pending** (was 4887; +1 the
  new LIMIT regression). Set-op membership describe block: 19 passing.
- `yarn build`: clean.
- Pre-existing unrelated TS diagnostics in `test/property.spec.ts` (lines 210, 249, 1457) are
  outside the touched region (~2491+) and pre-date this change; not chased.

## Use cases

```sql
create table A (id integer primary key, x integer) using memory;
create table B (id integer primary key, x integer) using memory;

-- writable (all-plain): view_info YES/YES/YES, column_info all YES
create view U  as select id, x from A union exists left as inA, exists right as inB select id, x from B;
-- non-writable (computed/select*/non-SELECT operand): view_info NO/NO/NO, column_info all NO/null base
create view Uc as select id, x from A union exists left as inA, exists right as inB select id, x + 1 from B;
-- non-writable (outer LIMIT — fixed in review): view_info NO/NO/NO, column_info all NO
create view Ul as select id, x from A union exists left as inA, exists right as inB select id, x from B limit 5;

select * from view_info('Ul');                            -- NO/NO/NO
update Ul set x = 5 where id = 1;                         -- throws (unsupported-limit) — static is honest
```
