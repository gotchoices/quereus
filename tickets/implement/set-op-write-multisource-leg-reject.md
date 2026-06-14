description: A set-op view write whose branch/leg body is a multi-source (JOIN / comma) body fails at runtime with the internal `k.k0_0 isn't a column` error, and the static `view_info`/`column_info` surfaces over-claim `is_*=YES`. Both recognizers (`exists`-membership and flag-less predicate-honest) admit a join leg by a column-only projection check, never verifying the leg's FROM is single-source. Fix: tighten BOTH recognizers (static + dynamic) to reject a non-single-source leg/branch with a structured diagnostic, restoring static/dynamic agreement (conservative all-`NO`) and eliminating the un-diagnosed internal error.
prereq:
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic
difficulty: medium
----

## Root cause (confirmed by repro)

A set-op view body decomposes each operand/leg into a synthetic branch view-like and runs it
back through `propagate` (`set-op.ts`). When a leg's FROM is a **join** (multi-source), that
recursive `propagate` routes to `propagateMultiSource`, which builds its OWN identity capture
under the hard-coded relation name `MS_UPDATE_KEYS_CTE` (`__vmupd_keys`) with `k<side>_<j>`
columns. But the OUTER set-op capture (`buildSetOpCapture`) has already injected a `__vmupd_keys`
cteNode whose columns are the **view output columns** (`id`, `x`, `src`, …), not `k0_0`. The
inner join base op's `select … from __vmupd_keys k where k.k0_0 = …` binds to the OUTER
relation, which has no `k0_0` column → `QuereusError: k.k0_0 isn't a column` (internal,
un-diagnosed).

Meanwhile the **shape recognizers** admit the join leg because they only check that the
projections are plain columns / literals — never that the FROM is single-source:

- **Membership path** (`exists … as <flag>`): `isSetOpBranchWritable` → `isSetOpBodyWritable`
  → `isOperandWritable` → `tryBranchColumnNames` (column-only) for the static surface;
  `analyzeSetOpView` → `buildBranch` → `branchColumnNames` for the dynamic write.
- **Flag-less path**: `isSetOpFlaglessWritableBody` → `flaglessShape` → `isWritableLeafLeg`
  (admits plain/literal columns) — shared by BOTH the static surface AND the dynamic
  `analyzeFlaglessSetOpView`/`buildFlaglessLeg`.

So the static surface reports writable while the dynamic write throws the internal error.

### Reproduced (both paths, identical `k.k0_0 isn't a column`)

Flag-less — `view_info('JV')` wrongly reports YES/YES/YES; `delete from JV where src='a'`
throws `k.k0_0 isn't a column`:

```sql
create table j1 (id integer primary key, x integer, color text null);
create table j2 (id integer primary key, y integer);
insert into j1 values (1,10,'red'),(2,20,'blue');
insert into j2 values (1,100),(2,200);
create view JV as
  select j1.id as id, j1.x as x, 'a' as src from j1 join j2 on j1.id = j2.id where j1.color = 'red'
  union all
  select id, x, 'b' as src from j1 where color = 'blue';
delete from JV where src = 'a';   -- internal: k.k0_0 isn't a column
```

Membership — same failure (`union exists left as inL, exists right as inR` with a join left
branch; `delete from MV where inL = true`).

## Chosen resolution — Option 1 (clean reject)

This is the **fix** (restore soundness, no internal leak). The larger Option 2 (compose the
nested capture under a distinct relation name to actually *support* join legs) is filed
separately as the feature-unlock backlog ticket `set-op-write-multisource-leg-compose`.

A writable set-op leg/branch's body must be **single-source**. A multi-source leg is any leg
whose FROM is a join or comma-join — exactly what `isJoinBody(selectAst)` (already exported from
`multi-source.ts`, already imported by `schema.ts`) detects: `from.length > 1 ||
from.some(f => f.type === 'join')`. A single-table leg (`from t [where …]`) returns false and
flows through the single-source spine unchanged. (A leg whose single source is a subquery —
`from (select …)` — is NOT a join body and stays out of scope here; note it as a known
remaining non-single-source edge, it currently does not reach the `k0_0` collision.)

Gate this in BOTH recognizers so static and dynamic cannot drift:

- **Flag-less (one shared helper covers both surfaces).** `isWritableLeafLeg(leaf)` is called
  by `flaglessShape`, which backs BOTH `isSetOpFlaglessWritableBody` (static) and
  `analyzeFlaglessSetOpView` (dynamic). Adding `if (isJoinBody(leaf)) return false;` there
  makes the static surface fall to the conservative all-`NO` row AND makes the dynamic write
  fall out of the flag-less route (`view-mutation-builder.ts:111`) into the single-source
  spine, which already rejects with a clean structured `unsupported-set-op` diagnostic
  (`propagate.ts` → `classifyViewBody`). No internal error.

- **Membership static.** In `isOperandWritable`, the leaf return is
  `return tryBranchColumnNames(effective) !== null;` — change to also require
  `&& !isJoinBody(effective)`. This recurses to leaves at every depth (a subtree operand
  descends via `isSetOpBodyWritable`), so a nested join leaf reports non-writable too →
  `deriveViewInfo`/`deriveColumnInfo` (`schema.ts:781`, `:1215`) report the conservative
  all-`NO` row.

- **Membership dynamic.** `isSetOpMembershipBody` is true whenever an `exists` flag is present,
  so the router (`view-mutation-builder.ts:98`) ALWAYS enters `buildSetOpWrite` regardless of
  branch-writability — the dynamic gate therefore must live inside `buildBranch`. For a
  **non-nested** branch (`!isNested`) whose `effectiveSelect` `isJoinBody(...)`, raise a clean
  `raiseMutationDiagnostic({ reason: 'unsupported-set-op', table: view.name, message: …multi-source
  (join) leg not yet writable; see set-op-write-multisource-leg-compose })`. Placing it on the
  non-nested leaf path means nested join leaves (reached via `analyzeSetOpBranches` →
  `buildBranch`) are caught at every depth too. Keep the message greppable with the
  `set-op-write-multisource-leg-compose` slug so the deferral is discoverable.

`isJoinBody` must be added to `set-op.ts`'s import from `./multi-source.js` (currently only
`MS_UPDATE_KEYS_CTE`, `MultiSourceKeyCapture`). The import is already one-directional
(`set-op.ts` imports `multi-source.ts`), so no cycle.

### Why not subtract from the leftmost-leaf path only

`branchColumnNames` reads names via `leftmostLeafSelect`, but the join FROM that triggers the
collision belongs to the operand SELECT itself (a leaf operand IS its own leaf). Gating in
`buildBranch` on `effectiveSelect` (post-unwrap, the actual branch body) is the precise spot —
it sees the real FROM before the recursive `propagate` is ever called.

## Acceptance

- `view_info('JV')` and `view_info('MV')` (join-leg bodies) report `NO/NO/NO`;
  `column_info` reports every column `is_updatable = NO`.
- `delete`/`update`/`insert` through a join-leg set-op view rejects with a structured
  `cannot write through view …` diagnostic (NOT the internal `k.k0_0 isn't a column`).
- No existing 93.x / view-mutation test regresses (no shipped test relies on a join leg
  working — the docs only ever promised single-source legs; "join in principle" was never
  wired).

## TODO

- Add `isJoinBody` to the `./multi-source.js` import in `set-op.ts`.
- Flag-less: in `isWritableLeafLeg`, return false when `isJoinBody(leaf)`.
- Membership static: in `isOperandWritable`, require `!isJoinBody(effective)` on the leaf return.
- Membership dynamic: in `buildBranch`, reject a non-nested branch whose `effectiveSelect` is a
  join body with a clean `unsupported-set-op` diagnostic naming `set-op-write-multisource-leg-compose`.
- Update the module doc-comments in `set-op.ts` (the "in principle, join" / "single-source (or,
  in principle, join) view body" phrasings) to state join legs are explicitly rejected pending
  `set-op-write-multisource-leg-compose`.
- Add coverage to `93.6-set-op-flagless-write.sqllogic`: the `JV` join-leg body → static
  `NO/NO/NO` (`view_info` + `column_info`) + dynamic clean reject on delete/update/insert.
- Add coverage to `93.4-view-mutation.sqllogic`: the `MV` membership join-branch body → static
  `NO/NO/NO` + dynamic clean reject (`delete from MV where inL = true`).
- Run `yarn workspace @quereus/quereus test` (at minimum the 93.4 / 93.6 logic files) and
  `yarn workspace @quereus/quereus lint`; stream output with `tee`.
