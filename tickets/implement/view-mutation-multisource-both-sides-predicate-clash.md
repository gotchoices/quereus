description: Fix multi-source (inner-join) UPDATE that assigns BOTH base sides while the WHERE predicate filters on the FK-parent's reassigned column silently dropping the FK-child's update. Materialize each affected view row's base-PK identities ONCE up-front (before any base op mutates) and route both per-side base ops' identifying predicates through that captured set instead of a live re-query of the join body. Reuses the per-row identity-capture plumbing the multi-source UPDATE RETURNING path already ships.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Reproduced (confirmed)

```sql
create table rp2 (pid integer primary key, label text);
create table rc2 (cid integer primary key, pref integer, note text,
    foreign key (pref) references rp2(pid));
insert into rp2 values (10, 'P10'), (20, 'P20');
insert into rc2 values (1, 10, 'a'), (2, 10, 'a'), (3, 20, 'b');
create view rjoin2 as
    select c.cid as cid, c.note as note, p.label as label
    from rc2 c join rp2 p on p.pid = c.pref;

update rjoin2 set note = 'B', label = 'PY' where label = 'P10';
select cid, note, label from rjoin2 order by cid;
-- ACTUAL  : cid 1,2 → {note:'a', label:'PY'}  (child op no-op'd)
-- EXPECTED: cid 1,2 → {note:'B', label:'PY'}
```

Verified against HEAD: `note` stays `'a'` for cid 1,2; `label` correctly becomes `'PY'`.

## Root cause (researched)

`planner/mutation/multi-source.ts` `decomposeUpdate` routes each assignment to its
owning base side and emits one ordered base `UPDATE` per touched side, **FK-parent
before FK-child** (`orderSides`). Each base op identifies its target rows with a
**live subquery over the join body** restricted to the user predicate (rewritten to
base terms ∧ body WHERE):

```
<owning>.<pk> in (select <alias>.<pk> from <join body> where <idPredicate>)
```

The emitter (`runtime/emit/view-mutation.ts` `drainBaseOps`) runs the per-side ops
**sequentially**. When the predicate filters on a column the update **also
reassigns on the FK-parent side**, the parent op (which runs first) mutates that
column, so the **child** op's identifying subquery — re-evaluated against the
now-mutated state — matches nothing, and the child side silently no-ops.

The symmetric "predicate on the **child's** reassigned column" case happens to work
today only because the child op runs **last**: it re-queries before it mutates
`note`. That is why 93.4 § RETURNING (d) currently predicates the both-sides case on
the child column and documents the parent-predicate variant as deferred.

Correct (Postgres) semantics: the WHERE binds the **pre-update** snapshot for ALL
per-side ops — exactly like single-table `update t set a=1, b=2 where b=5` sets both
columns for the rows where `b=5` held *before* the statement.

## Fix design — up-front key capture (the documented "eager key materialization")

Capture each affected view row's **base-PK identities `(k0, k1)`** ONCE, *before*
any base op fires, into `rctx.tableContexts` under a shared descriptor; then route
each per-side base op's identifying predicate through that captured set:

- child (side 0) op: `... where <pk0> in (select k0 from __vmupd_keys)`
- parent (side 1) op: `... where <pk1> in (select k1 from __vmupd_keys)`

`in` collapses duplicate `kN` (e.g. two children sharing a parent), so a single
`(k0, k1)` materialization serves both sides. The set is mutation-order-independent,
so neither op can lose rows to the other's writes.

This is **the exact mechanism the multi-source UPDATE RETURNING path already ships**
(`buildMultiSourceUpdateReturning` → `ReturningCapture` →
`rctx.tableContexts` + `InternalRecursiveCTERefNode`); the capture SELECT it builds
(`select s0.pk0 as k0, s1.pk1 as k1 from <body> where <idPredicate>`) is *identical*
to what the base ops need. The plan is to **build that capture once and share it**
between the base ops and (when present) the RETURNING re-query — so a both-sides
update *with* RETURNING materializes the capture exactly once.

### Wiring (proven seams)

1. **Name → context resolution.** `PlanningContext.cteNodes` is the seam: a subquery
   inside a built expression resolves FROM-table names against `ctx.cteNodes`
   (`building/expression.ts:38` passes `ctx.cteNodes` as `parentCTEs` to
   `buildSelectStmt`), and `buildFrom` (`building/select.ts:350-362`) resolves a
   name to an `InternalRecursiveCTERefNode` (detected via
   `CapabilityDetectors.isRecursiveCTERef`) and wires it directly. So injecting
   `__vmupd_keys → keyRef` into the `cteNodes` used to **build the base ops** makes
   their `select kN from __vmupd_keys` subquery read the materialized rows by
   descriptor. `buildUpdateStmt`/`buildDeleteStmt` preserve `ctx.cteNodes` through
   their `{...ctx}` spreads down into the WHERE `buildExpression`, so no new
   parameter is needed on those builders — just pass a `ctx` whose `cteNodes`
   carries the keyRef.

2. **Emit-time materialization.** `emitInternalRecursiveCTERef` already reads rows
   from `rctx.tableContexts.get(workingTableDescriptor)`. The capture source is
   emitted as a node param and materialized into context **before** `drainBaseOps`,
   removed in a `finally` (the RETURNING-update branch in
   `runtime/emit/view-mutation.ts` already does this; generalize it to fire on the
   **void** path too — a both-sides update without RETURNING must still materialize
   the capture before the base ops).

### Responsibilities by file

- **`planner/mutation/multi-source.ts`**
  - Export the shared contract: a const for the capture CTE name (e.g.
    `MS_UPDATE_KEYS_CTE = '__vmupd_keys'`) and the `k0`/`k1` column names.
  - `decomposeUpdate`: when **two** sides are assigned (both `perSide[0]` and
    `perSide[1]` non-empty), emit each side's identifying `in`-subquery as
    `select k<sideIndex> from __vmupd_keys` instead of the live join-body subquery.
    When only **one** side is assigned, keep the existing live subquery (no ordering
    hazard — the single op re-queries before it mutates; preserves all the
    nested-subquery-descent behavior the e1/e2/g/h/etc. 93.4 cases lock in).
  - Factor a `buildMultiSourceUpdateKeyCapture(ctx, view, stmt)` that returns
    `{ source, descriptor }` (the `(k0,k1)` capture SELECT + shared descriptor),
    lifted out of the current `buildMultiSourceUpdateReturning`. Refactor
    `buildMultiSourceUpdateReturning` to **accept** a pre-built `descriptor` (and
    build its own `InternalRecursiveCTERefNode` over it for the EXISTS re-query),
    so the capture is built once and shared. Keep requiring a single-column PK on
    both sides (`requireSingleColumnPk`) — same precondition the RETURNING path
    already enforces. NOTE: rename the shared CTE/descriptor from the
    returning-specific `__vmret_keys` spelling to the neutral `__vmupd_keys`, since
    it now serves base ops even with no RETURNING.

- **`planner/building/view-mutation-builder.ts`** (`buildViewMutation`)
  - After `propagate` returns `baseOps`, detect the capture-needing case:
    `req.op === 'update' && isJoinBody(view.selectAst) && !decompositionStorage(...)
    && (baseOps.length > 1 || <returning present>)`.
  - When needed, build the capture (`buildMultiSourceUpdateKeyCapture`) ONCE → its
    `source` + `descriptor`. Build the base ops with a `ctx` whose `cteNodes`
    carries `__vmupd_keys → new InternalRecursiveCTERefNode(...)` over that
    descriptor (a fresh keyRef per base op sharing the one descriptor is safest;
    one shared keyRef is also acceptable since base ops run sequentially). Pass the
    capture `{ source, descriptor }` to `ViewMutationNode` so the emitter
    materializes it before the base ops **regardless of RETURNING**.
  - When RETURNING is also present, feed the SAME descriptor into the refactored
    `buildMultiSourceUpdateReturning` so only one capture exists.

- **`planner/nodes/view-mutation-node.ts`**
  - Generalize `returningCapture` so it is materialized for base ops too (rename to
    e.g. `keyCapture`/`identityCapture`, or keep the field name and update the
    docstring + emitter to materialize it unconditionally). `getChildren` /
    `getRelations` / `withChildren` already thread `returningCapture.source` whether
    or not `returning` is set — keep that. Update `toString` / logical-attrs labels.

- **`runtime/emit/view-mutation.ts`**
  - Hoist the capture materialization (`captureIdx >= 0` →
    `rctx.tableContexts.set(captureDescriptor, …)` with a `finally` delete) to wrap
    **all** execution branches, so the **void** (no-RETURNING) both-sides update
    materializes it before `drainBaseOps`. Remove the now-duplicated set/delete from
    the RETURNING-update branch (it reads the same already-set context). Confirm the
    capture rows are collected eagerly before `run` returns (they are — `collectRows`
    on the capture callback).

## Edge cases / guards (verify, don't regress)

- **Single-side multi-source update** stays on the live-subquery path → all the
  subquery-descent correctness cases (93.4 e1, e2, f, g, h, i, j, k, l, m, n, o)
  unchanged.
- **DELETE** routes to one side only — unaffected (no change to `decomposeDelete`).
- **Single-source spine / inserts / decomposition tables** — unaffected (gated by
  `isJoinBody` + `baseOps.length > 1`); the injected `__vmupd_keys` cteNode is only
  added on the multi-source-update path and is otherwise absent.
- The capture's `idPredicate` = user WHERE (base terms) ∧ body WHERE — identical to
  the live subquery's predicate, so the captured set equals the pre-mutation live
  set (body-WHERE filtering preserved; § ax_filt case at 93.4:231 must still pass).
- A both-sides update whose value references a correlated subquery over the owning
  side (e2 shape) is unaffected — only the WHERE identifier source changes, not the
  SET value lowering.

## Acceptance

- The repro yields `note='B', label='PY'` for cid 1,2 (with **and** without
  RETURNING).
- 93.4 § RETURNING (d): restore the **parent-predicate-clash** both-sides assertion
  (currently predicated on the child column with a deferral NOTE). Concretely — at
  the (d) `rjoin2` state after line 962 (`rp2`: 10→'PX', 20→'P20'; `rc2`:
  1→'A',2→'A',3→'b'), add/restore:

  ```sql
  -- BOTH sides assigned, predicate on the PARENT's reassigned column (the clash):
  update rjoin2 set note = 'B', label = 'PY' where label = 'PX' returning cid, note, label;
  → [{"cid":1,"note":"B","label":"PY"},{"cid":2,"note":"B","label":"PY"}]
  ```

  Keep a both-sides **child-predicate** RETURNING case too (the existing coverage),
  and drop the deferral NOTE that points at this ticket.
- Add a **non-RETURNING twin** (the repro shape, fresh tables) — e.g. in the Phase 2
  multi-source update section — asserting both `note` and `label` land for the
  parent-predicate clash.
- Existing 93.4 multi-source update/delete + RETURNING + insert cases continue to
  pass; full `yarn test` (memory) green.
- `docs/view-updateability.md`: update § `returning` Clauses (lines ~543-552, the
  "Residual edges" paragraph) to drop the both-sides parent-predicate-clash from the
  deferred list and fold the up-front-capture into § Inner Join / § Multi-Base-Table
  Mutations (the "eager key materialization" the § Inner Join delete note at
  ~324 already anticipates). Update the Phase-2a § Inner Join box that currently
  says updates "identify rows by a subquery over the join body" to note the
  both-sides case captures identities up-front.

## TODO

- [ ] `multi-source.ts`: export `MS_UPDATE_KEYS_CTE` + `k0`/`k1` column-name consts;
      lift `buildMultiSourceUpdateKeyCapture(ctx, view, stmt) → { source, descriptor }`.
- [ ] `multi-source.ts` `decomposeUpdate`: when both sides assigned, emit each base
      op's identifying `in`-subquery as `select kN from __vmupd_keys`; keep the live
      subquery for the single-side case.
- [ ] `multi-source.ts`: refactor `buildMultiSourceUpdateReturning` to accept the
      shared `descriptor` (build its own `InternalRecursiveCTERefNode` for the EXISTS
      re-query) instead of minting its own capture; rename `__vmret_keys` → the
      shared `__vmupd_keys`.
- [ ] `view-mutation-builder.ts` `buildViewMutation`: build the capture once for the
      both-sides / RETURNING multi-source update; inject `__vmupd_keys → keyRef` into
      the base-op build `ctx.cteNodes`; pass `{ source, descriptor }` to
      `ViewMutationNode`; share the descriptor with the RETURNING re-query.
- [ ] `view-mutation-node.ts`: generalize the capture field so it is materialized
      for base ops even without RETURNING; update docstrings / `toString` / logical
      attrs.
- [ ] `view-mutation.ts` emitter: hoist capture materialization to wrap all branches
      (void path included); de-dup the RETURNING-update branch's set/delete.
- [ ] 93.4: restore the parent-predicate-clash RETURNING assertion + add the
      non-RETURNING twin; remove the deferral NOTE.
- [ ] `docs/view-updateability.md`: update § Inner Join, § Multi-Base-Table
      Mutations, § `returning` Clauses per Acceptance.
- [ ] `yarn build` + `yarn test` (memory) green; `yarn lint` clean for
      `packages/quereus`.
