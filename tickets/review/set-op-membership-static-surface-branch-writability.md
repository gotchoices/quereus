description: Review the branch-writability gate on the set-op membership static surfaces (`column_info` / `view_info`). A new AST-only probe (`isSetOpBranchWritable`) now gates the membership-writable claim on the SAME branch shape the dynamic write enforces, so a non-writable membership body (computed leg, `select *` leg, non-SELECT operand, mismatched leg arity) reports the conservative non-writable shape instead of over-claiming writable from the flag's presence alone — mirroring the existing non-decomposable join shape gate.
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## What landed

A catalog-honesty fix: the static surfaces no longer over-claim writable for a set-op
membership body whose operands the dynamic write would reject.

**New probe (`planner/mutation/set-op.ts`).**
- `isSetOpBranchWritable(selectAst): boolean` (exported) — AST-only, non-throwing. Returns
  `false` for: a non-`select` body, a non-SELECT right operand, a `select *` leg (either
  side), a computed (non-plain-`column`) leg (either side), or legs whose plain-column
  counts disagree. The static shadow of the four dynamic branch rejections in
  `analyzeSetOpView`. **Non-recursive** (one level) by design.
- `tryBranchColumnNames(branchSelect): string[] | null` — the non-throwing core. `null` on a
  `*`/computed leg, else the positional `rc.alias ?? rc.expr.name` list.
- `branchColumnNames` (the dynamic path's throwing helper) was **refactored** to call
  `tryBranchColumnNames` and, on `null`, re-walk to re-derive the specific `select *` vs
  computed diagnostic message. The two paths now share one predicate (DRY, cannot drift).

**Wiring (`func/builtins/schema.ts`).** Import extended to pull in `isSetOpBranchWritable`.
- `deriveViewInfo`: inside the `isSetOpMembershipBody` block, `if (!isSetOpBranchWritable(...))
  return CONSERVATIVE_VIEW_INFO` — the same all-`NO` row the join shape gate returns.
- `deriveColumnInfo`: the all-`YES` short-circuit is now gated
  `isSetOpMembershipBody(...) && isSetOpBranchWritable(...)`. A non-writable body **falls
  through** to the per-column walk, which reports every column `is_updatable='NO'` / null
  base. **Verified against the planned tree** (`SetOperationNode.computePhysical` →
  `membershipLineage()`): the root threads `updateLineage` ONLY for membership-flag attrs
  (a read-only `set-op-branch` `existence` site, which `baseSiteOf` resolves to `undefined`)
  and NONE for data columns — so the fall-through yields the conservative shape without an
  explicit early return. (See "Scrutinize" below — this correctness rests on that lineage
  fact.)

**Docs.** `docs/view-updateability.md` § Set-operation membership writes gained a "Static
surfaces gate on branch writability" paragraph next to the v1-limitations prose.

## Direction of the change (safety)

Conservative-direction-*wrong* before this: it claimed writable when not. The fix only ever
tightens a `YES`→`NO` for genuinely non-writable shapes; it cannot regress a write that
currently succeeds (those are all all-plain-column bodies the probe passes). No correctness
bug existed — the dynamic write already rejected these shapes cleanly; this is purely the
static catalog catching up to the dynamic truth.

## Tests added (property.spec.ts, `Set-operation membership columns` describe)

All green; full package suite **4887 passing / 9 pending**, lint clean, build clean.

- `column_info` computed-(right)-leg `Uc` → every row `is_updatable='NO'`, null base; **plus**
  the dynamic `update Uc set x=5` still throws (static agrees with dynamic).
- `view_info` computed-leg `Uc` → triple `'NO'`.
- both-legs-probed: computed-**left**-leg `Ucl` → `view_info` + `column_info` all-`NO`
  (guards that the probe checks BOTH operands, not only the right).
- `select *`-leg `Us` (non-parenthesized form) → `view_info` triple-`NO`, `column_info`
  all-`NO`/null base; **plus** dynamic `update Us set x=5` throws (exercises the refactored
  `branchColumnNames` `*` re-derivation path).
- non-SELECT (VALUES) right operand `Uv` → all-`NO` (confirmed it parses as a membership body
  with `rightType:'values'` and the read-half plans it cleanly).
- regression: renamed-plain-column legs `Ur` (`select id as k, x`) → still writable
  (`view_info` triple-`YES`, `column_info` all-`YES`) — pins the alias path.
- Existing regression guards stay green: `column_info`/`view_info` over the all-plain `U`
  (2376/2388) and `static surface agrees with the dynamic write` (2569).

## Use cases / how to validate

```sql
create table A (id integer primary key, x integer) using memory;
create table B (id integer primary key, x integer) using memory;

-- writable (all-plain): view_info YES/YES/YES, column_info all YES
create view U  as select id, x     from A union exists left as inA, exists right as inB select id, x     from B;
-- non-writable (computed right leg): view_info NO/NO/NO, column_info all NO/null base
create view Uc as select id, x     from A union exists left as inA, exists right as inB select id, x + 1 from B;
-- non-writable (computed left leg): symmetric
create view Ucl as select id, x+1  from A union exists left as inA, exists right as inB select id, x     from B;
-- non-writable (select * leg)
create view Us as select id, x     from A union exists left as inA, exists right as inB select *         from B;

select * from view_info('Uc');                  -- expect NO/NO/NO
select column_name, is_updatable from column_info('Uc');  -- expect every row NO
update Uc set x = 5 where id = 1;               -- expect: throws (dynamic reject) — static is honest
```

## Scrutinize (honest gaps for the reviewer)

- **Fall-through vs. explicit return (the central judgment call).** `deriveColumnInfo` relies
  on `SetOperationNode` threading NO `updateLineage` for data columns. I verified this against
  the current planned tree (`membershipLineage()` only sets flag attrs). The ticket flagged
  the alternative — an explicit early `return` of all-`NO` rows — as more defensive if that
  lineage ever changes. I chose the fall-through (the ticket's primary Decision) for minimal
  diff; **please confirm you agree** the implicit reliance is acceptable, or push for the
  explicit return. There is no test that would catch a future regression where the walk *did*
  resolve a base site for a set-op data column (the fall-through would then over-claim again).
  A targeted assertion or the explicit return would close that.
- **Nested-compound one-level over-claim (known non-goal, do NOT file as a regression).** A
  right operand that is itself a compound whose first leg is plain still passes the probe and
  the dynamic shape check; the nested reject is deferred to write-time `propagate`
  (`set-op-membership-nested`). This residual is explicitly out of scope and called out in
  code comments + docs. No test covers it (by design).
- **Probe is shape-only, not deep.** It does not verify a branch leg's base is itself
  writable (e.g. a leg sourcing another non-writable view) — but neither does the dynamic
  per-side path at this level; that defers to the branch's own `propagate`. Parity is
  intentional.
- **`branchColumnNames` per-side message coverage.** The computed-leg and `*`-leg dynamic
  rejects are both now exercised (the two `update … throws` assertions), but only as a
  boolean throw — the specific message text (`select *` vs computed wording) is not asserted.
  Low risk (the re-walk is a verbatim copy of the original branch checks), but unasserted.

## Notes

- Surfaced during review of `set-op-membership-write`; deferred as a backlog honesty gap (no
  correctness impact). The `packages/quereus/docs/...` path in the source ticket header was
  stale — the doc actually lives at repo-root `docs/view-updateability.md`.
