description: Support `update … returning` through a multi-source (inner-join) view when the update rewrites a column its own WHERE predicate filters on, via per-row identity capture (replacing the predicate re-query for updates). Remove the loud-rejection guard and its 93.2 regression case; add positive 93.4 coverage.
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/nodes/internal-recursive-cte-ref-node.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, docs/view-updateability.md

## Problem

RETURNING through a multi-source inner-join view (`update`/`delete`) currently
sources its rows from a **re-query of the view** restricted to the user predicate:
`select <returning> from <view> [where <user where>]`, captured `pre` (delete) or
`post` (update) — see `view-mutation-builder.ts` `buildMultiSourceReturning` and
`runtime/emit/view-mutation.ts`.

For an UPDATE, the post-mutation re-query matches by the *original* user predicate.
If the update **assigns a column the WHERE filters on**, the changed rows no longer
match the predicate, so the re-query silently returns the wrong/empty set. The 3.7
review turned that exact shape into a **loud rejection** (`buildMultiSourceReturning`
guard comparing assignment columns against `collectColumnRefNames(where)`), with a
regression in `93.2-view-mutation-pending.sqllogic`.

We want `update <join-view> set <pred-col> = … where <pred-col> = … returning …` to
return the post-mutation, view-projected rows for exactly the updated rows — matching
the single-source NEW/OLD path and Postgres.

## Design — per-row identity capture

The robust mechanism captures the affected view rows' **base-row identities before**
the base ops fire, then re-queries the join body **after** the mutation restricted to
those captured identities — instead of re-matching the (now-stale) user predicate.
This reuses the same context-backed-relation plumbing the multi-source INSERT
envelope and recursive-CTE working table already use.

This replaces the predicate re-query **for updates only**. The DELETE path is
unchanged: it captures `pre` (before the rows vanish) by the user predicate, which is
correct because the rows still match the predicate at capture time.

### Flow (multi-source UPDATE with RETURNING)

```
1. capture source (pre):
     select <s0.alias>.<pk0> as k0, <s1.alias>.<pk1> as k1
       from <view body FROM (cloned)>
      where <idPredicate>            -- user WHERE→base terms  ∧  body WHERE
   → one row per affected view row, identified by BOTH side PKs.

2. materialize the capture rows into rctx.tableContexts under a shared
   TableDescriptor, BEFORE the base ops run (envelope/working-table pattern).

3. drive the per-side base UPDATE ops (unchanged).

4. returning re-query (post):
     select <returning rewritten to base terms>
       from <view body FROM (cloned)>
      where exists (select 1 from <captured> k
                     where k.k0 = <s0.alias>.<pk0>
                       and k.k1 = <s1.alias>.<pk1>)
   → projects the view-spelled RETURNING columns against the POST-mutation base
     state, restricted to the captured identities. Reads <captured> from context.

5. finally: delete the context entry. Return the re-query rows.
```

Key points:

- **Identity = both sides' single-column PKs.** The capture and the post re-query
  match on `(k0, k1)`, so the result is exactly the updated logical rows regardless of
  which predicate/assignment columns changed. Requires a **single-column PK on both
  join sides** (today only the *written* side needs one — `requireSingleColumnPk`);
  extend the requirement to both sides for the RETURNING-capture path, rejecting a
  composite-PK non-written side with a clear `unsupported-join` diagnostic ("RETURNING
  through this join needs a single-column key on both sides").

- **The post re-query does NOT re-apply the body/user WHERE.** It matches purely on
  captured identity and projects the post-mutation image — so a row the update pushed
  *out* of the view's filter is still returned (matching the single-source NEW
  semantics, which read NEW rows directly). Only the structural join ON-condition (in
  the body FROM) is kept.

- **Projection is built against the join body, not the view name** (so the hidden base
  PKs are in scope for the EXISTS correlation). The RETURNING result columns must be
  transformed by the builder (the existing `select <returning> from <view>` resolution
  no longer applies):
  - `*` → expand to the view's output columns (display names from `view.columns ??`
    the projection's alias/name), each replaced by its base-term expression from
    `viewColToBaseRef`, **aliased to the view column name**.
  - bare view-column / expression with view-column refs → `substituteViewColumns(...)`
    to base terms, **aliased to the view spelling** so output names match the view (a
    renamed view col like `eid`→base `id` must surface as `eid`, not `id`).
  - computed view columns (e.g. `rate*2 as doubled`) re-evaluate naturally against the
    post-mutation base values, because their `viewColToBaseRef` entry is the base-term
    expression.

### Exposing the captured keys to the re-query

Reuse `InternalRecursiveCTERefNode` (in `nodes/internal-recursive-cte-ref-node.ts`):
it is a `CTEScopeNode` whose emitter (`emit/internal-recursive-cte-ref.ts`) reads a
context-backed table by `workingTableDescriptor`, and `building/select.ts` `buildFrom`
already recognizes it (`CapabilityDetectors.isRecursiveCTERef`) and uses it directly
as a FROM relation. Steps:
  - Build a `TableDescriptor` (identity object) for the captured keys.
  - Build the capture **source** relation (step 1) — a normal planned SELECT.
  - Build an `InternalRecursiveCTERefNode` named e.g. `__vmret_keys`, attrs `[k0, k1]`
    (types = the two PK scalar types), `workingTableDescriptor = descriptor`.
  - Build the post re-query AST (step 4) and pass `buildSelectStmt(ctx, ast, new
    Map([['__vmret_keys', refNode]]))` so the `exists (select 1 from __vmret_keys k …)`
    resolves to the context-backed scan.

The same `descriptor` object identity is shared between the ref node placed in the
re-query plan and the emitter that materializes the capture rows.

(Alternative if reusing `InternalRecursiveCTERefNode` reads as a semantic stretch:
make `EnvelopeScanNode` implement `CTEScopeNode` and teach `buildFrom` to recognize it
— more invasive. Reuse is the lower-risk path and needs no `buildFrom` change.)

### Node + emitter changes

`ViewMutationNode` already carries `returning?` + `returningTiming?`. Add a dedicated
field for the capture (clearer than overloading `envelope`, which is the insert
surrogate and lives on a void/return-null branch):

```ts
returningCapture?: { readonly source: RelationalPlanNode; readonly descriptor: TableDescriptor };
```

Thread it through `getChildren` / `getRelations` / `withChildren` (after `returning`,
before `envelope`), keeping the param order the emitter slices back.

`emitViewMutation` (`runtime/emit/view-mutation.ts`) — extend the `returningIdx >= 0`
post branch:
```
post update:
  if returningCapture:
     captureRows = collect(captureSourceCb(rctx))           # before base ops
     rctx.tableContexts.set(captureDescriptor, () => arrayIterable(captureRows))
     try { await drainBaseOps(rctx, baseCbs);
           return arrayIterable(await collectRows(returningCb(rctx))) }   # reads context
     finally { rctx.tableContexts.delete(captureDescriptor) }
  else:  # (delete 'pre' path and the now-dead legacy update path stay as-is)
     ...
```
`'pre'` (delete) is unchanged. All multi-source UPDATE RETURNING now sets
`returningCapture` ⇒ the legacy post-predicate update re-query becomes unreachable;
keep the emitter minimal.

### Where the analysis lives

`buildMultiSourceReturning` (in `view-mutation-builder.ts`) only sees `view`/`req`, not
the join analysis (`sides`, per-side PKs, `viewColToBaseRef`, `idPredicate`) — those are
private to `multi-source.ts` (`analyzeJoinView`, `buildIdentifyingPredicate`,
`buildIdentifyingSubquery`, `requireSingleColumnPk`, `cloneFromClause`). Add an exported
function to `multi-source.ts`, e.g.:

```ts
export function buildMultiSourceUpdateReturning(
  ctx, view, stmt: AST.UpdateStmt
): { source: RelationalPlanNode; descriptor: TableDescriptor; returning: RelationalPlanNode }
```

that performs steps 1, 3-build, and 4-build (reusing the existing private helpers), and
have `buildViewMutation` wire the result into the `ViewMutationNode` (`returning`,
`returningTiming: 'post'`, `returningCapture`). Keep DELETE on the existing
`buildMultiSourceReturning` re-query path.

## Residual edges (document, out of scope)

- An update that changes a **base PK** column, or the **join-key / FK** column that
  determines which rows join — the captured `(k0,k1)` identity no longer matches /
  rejoins post-mutation, so such a row drops from RETURNING. These columns are
  generally not writable through the supported view shapes (the FK/join key is hidden
  or rejected as cross-source); note the limitation in `docs/view-updateability.md`.
- Composite-PK side + RETURNING → rejected (see above).

## Tests

### Remove (93.2-view-mutation-pending.sqllogic)
Delete the update-predicate-clash rejection block (the `update rjv set a = 99 where a =
50 returning …  -- error: which its own WHERE predicate filters on` case, together with
its `insert into jt1/jt2 values (5,…)` setup lines that exist only for it). **Keep** the
multi-source **insert** RETURNING rejection (`insert into rjv … returning id`) — still
unsupported.

### Add (93.4-view-mutation.sqllogic § RETURNING)
A fresh self-contained block (new tables, two children per parent so a parent-side
update returns multiple rows; ascending memory-vtab scan order is deterministic):

```sql
-- --- (d) multi-source update RETURNING where the predicate filters on a column the
--         update rewrites — per-row identity capture (the changed rows no longer
--         match the predicate, but their captured identity does).
create table rp2 (pid integer primary key, label text);
create table rc2 (cid integer primary key, pref integer, note text,
    foreign key (pref) references rp2(pid));
insert into rp2 values (10, 'P10'), (20, 'P20');
insert into rc2 values (1, 10, 'a'), (2, 10, 'a'), (3, 20, 'b');
create view rjoin2 as
    select c.cid as cid, c.note as note, p.label as label
    from rc2 c join rp2 p on p.pid = c.pref;
-- run

-- predicate on the rewritten CHILD column: cid 1,2 (note='a') update to 'A'.
update rjoin2 set note = 'A' where note = 'a' returning cid, note, label;
→ [{"cid":1,"note":"A","label":"P10"},{"cid":2,"note":"A","label":"P10"}]

-- predicate on a PARENT-owned column the update rewrites (label='P10' → pid 10 →
-- children 1,2). Parent label becomes 'PX'; both children re-projected.
update rjoin2 set label = 'PX' where label = 'P10' returning cid, note, label;
→ [{"cid":1,"note":"A","label":"PX"},{"cid":2,"note":"A","label":"PX"}]

-- BOTH sides assigned, with the assigned parent column ALSO in the predicate.
update rjoin2 set note = 'B', label = 'PY' where label = 'PX' returning cid, note, label;
→ [{"cid":1,"note":"B","label":"PY"},{"cid":2,"note":"B","label":"PY"}]

-- `returning *` through the join update with a predicate-clash on the child column.
update rjoin2 set note = 'C' where note = 'B' returning *;
→ [{"cid":1,"note":"C","label":"PY"},{"cid":2,"note":"C","label":"PY"}]
```

The pre-existing § RETURNING (c) cases (`rjoin`, update on a non-assigned predicate
column, delete) must continue to pass once those updates route through the capture path
(they have single-row predicates and the same expected outputs).

### Docs
Rewrite `docs/view-updateability.md` § `returning` Clauses multi-source bullet: replace
the "*Limitation:* … rejected … per-row capture is a follow-up" text with the per-row
identity-capture description (capture base-PK identities pre-mutation, re-query the body
by captured identity post-mutation; DELETE still captures `pre` by predicate). Note the
residual base-PK / join-key edge. Update the Phase 3.7 / Phase 2b+ table rows if they
mention the limitation.

## TODO

- In `multi-source.ts`: add `buildMultiSourceUpdateReturning(ctx, view, stmt)` that
  builds (a) the capture source `select s0.pk0 as k0, s1.pk1 as k1 from <body> where
  <idPredicate>`, (b) the `InternalRecursiveCTERefNode` (`__vmret_keys`, attrs k0/k1,
  shared descriptor), and (c) the post re-query against the body FROM with the
  `exists (… __vmret_keys …)` filter and view-spelled, base-term RETURNING projection
  (incl. `*` expansion). Reuse `buildIdentifyingPredicate`, `cloneFromClause`,
  `viewColToBaseRef`, `substituteViewColumns`. Require single-column PK on **both**
  sides (extend/duplicate `requireSingleColumnPk`); reject composite-PK side.
- In `view-mutation-builder.ts` `buildViewMutation`: for a multi-source UPDATE with
  RETURNING, call the new function and construct `ViewMutationNode` with `returning`,
  `returningTiming: 'post'`, and `returningCapture`. Keep DELETE on the existing
  `buildMultiSourceReturning` pre re-query. Remove the loud-rejection guard (the
  `req.op === 'update' && req.stmt.where` clash block) and the now-unused
  `collectColumnRefNames` helper.
- In `view-mutation-node.ts`: add the `returningCapture` field; thread it through
  `getChildren` / `getRelations` / `withChildren` / `toString` / `getLogicalAttributes`.
- In `runtime/emit/view-mutation.ts`: emit the capture source as a param; in the post
  branch, materialize it into `rctx.tableContexts` under the descriptor before base
  ops, run the re-query after, clean up in `finally`. Update the param-index bookkeeping
  and the `note` string.
- Verify `building/select.ts` `buildFrom` resolves the `__vmret_keys` ref (no change
  expected — `isRecursiveCTERef` already handled).
- Tests: edit `93.2` (remove the update-clash rejection + its setup; keep insert
  rejection) and `93.4` (add the `rjoin2` block above). Confirm the existing `rjoin`
  RETURNING cases still pass.
- Docs: update `docs/view-updateability.md` as above.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vm.log; tail -n 60
  /tmp/vm.log` and `yarn workspace @quereus/quereus lint` (single-quote globs on
  Windows). Fix any fallout from the new node field / emitter param order.
