description: Review the fix for multi-source (inner-join) UPDATE that assigns BOTH base sides while the WHERE predicate filters on the FK-parent's reassigned column. Previously the FK-parent base op ran first and rewrote the predicate column, so the FK-child op's live identifying subquery matched nothing and the child update silently no-op'd. Fix: capture each affected view row's base-PK identities `(k0, k1)` ONCE up-front (before any base op mutates) and route BOTH per-side base ops' identifying `in`-subqueries through that captured set instead of a live re-query of the join body — a mutation-order-independent identity. Reuses + generalizes the per-row identity-capture plumbing the multi-source UPDATE RETURNING path already shipped, so a both-sides update *with* RETURNING materializes the capture exactly once (shared between base ops and the re-query).
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What changed (as implemented)

The bug: `decomposeUpdate` (`multi-source.ts`) emits one base UPDATE per touched
side, FK-parent before FK-child, each identified by a **live subquery over the join
body** restricted to the user predicate. The emitter (`view-mutation.ts`
`drainBaseOps`) runs them sequentially against **live** state. When the predicate
filters on a column the update also reassigns on the FK-parent side, the parent op
(runs first) mutates that column, so the child op's identifying subquery —
re-evaluated against the now-mutated state — matches nothing and the child silently
no-ops. (The symmetric child-predicate case happened to work only because the child
op runs last.)

The fix routes BOTH per-side ops through a single up-front identity capture:

- **`multi-source.ts`**
  - New exports `MS_UPDATE_KEYS_CTE = '__vmupd_keys'` + `MS_UPDATE_KEY_COLUMNS = ['k0','k1']`.
  - `decomposeUpdate`: computes `bothSidesAssigned = perSide[0].length>0 && perSide[1].length>0`.
    When true, each side's identifying `in`-subquery is `select k<side> from __vmupd_keys`
    (`buildCapturedKeySubquery`) instead of the live join-body subquery. Single-side
    keeps the live subquery (no ordering hazard — the lone op re-queries before it
    mutates), preserving all the nested-subquery-descent correctness cases.
  - Factored `buildMultiSourceUpdateKeyCapture(ctx, view, stmt) → { source, descriptor,
    keyColumns }` out of the old `buildMultiSourceUpdateReturning`. It builds the capture
    SELECT `select s0.pk0 as k0, s1.pk1 as k1 from <body> where <idPredicate>` (same
    predicate the base ops route on) + the shared `TableDescriptor`. Requires a
    single-column PK on BOTH sides (unchanged precondition).
  - New `makeMultiSourceUpdateKeyRef(scope, capture)` mints a fresh
    `InternalRecursiveCTERefNode` over the capture descriptor (fresh attr ids per call;
    descriptor identity is the runtime stitch).
  - `buildMultiSourceUpdateReturning` refactored to **accept** the pre-built capture and
    build only the EXISTS re-query over its own freshly-minted key ref — no longer mints
    its own capture. CTE renamed `__vmret_keys` → `__vmupd_keys`.

- **`view-mutation-builder.ts`** (`buildViewMutation`)
  - `buildUpdateIdentityCapture(ctx, view, req, baseOps)` builds the capture once when a
    multi-source update either assigns both sides (`baseOps.length > 1`) OR carries
    RETURNING; `undefined` otherwise.
  - `withKeyCapture(ctx, capture)` returns a `ctx` whose `cteNodes` resolves
    `__vmupd_keys → keyRef` (fresh per base op). Injected only when `baseOps.length > 1`
    (the single-side+RETURNING base op uses the live subquery, so no injection).
  - The same capture's `{ source, descriptor }` is passed to `ViewMutationNode` (so the
    emitter materializes it regardless of RETURNING) and the same capture is fed into
    `buildMultiSourceUpdateReturning` (so a both-sides update with RETURNING captures once).

- **`view-mutation-node.ts`**: renamed `ReturningCapture` → `IdentityCapture` and field
  `returningCapture` → `identityCapture`; generalized docstrings (now materialized for
  base ops too, not just RETURNING). `getChildren`/`getRelations`/`withChildren`/
  `toString`/`getLogicalAttributes` updated. Capture source stays excluded from
  `getRelations` (side input), so a both-sides void update remains a void node.

- **`view-mutation.ts`** emitter: hoisted the capture materialization (`captureIdx >= 0`
  → `tableContexts.set(descriptor)` + `finally` delete) to wrap **all** branches via a
  new `runBody` inner fn, so the **void** (no-RETURNING) both-sides update materializes
  the capture before `drainBaseOps`. Removed the now-duplicate set/delete from the
  RETURNING-update branch.

## Use cases / validation to confirm

Primary repro (now fixed — both `note` and `label` land):
```sql
create table rp2 (pid integer primary key, label text);
create table rc2 (cid integer primary key, pref integer, note text,
    foreign key (pref) references rp2(pid));
insert into rp2 values (10, 'P10'), (20, 'P20');
insert into rc2 values (1, 10, 'a'), (2, 10, 'a'), (3, 20, 'b');
create view rjoin2 as select c.cid as cid, c.note as note, p.label as label
    from rc2 c join rp2 p on p.pid = c.pref;
update rjoin2 set note = 'B', label = 'PY' where label = 'P10';  -- parent-predicate clash
select cid, note, label from rjoin2 order by cid;
-- cid 1,2 → {note:'B', label:'PY'}  (previously note stayed 'a')
```

Tests added/changed in `93.4-view-mutation.sqllogic` (file passes, `--grep "93.4-view-mutation"`):
- § RETURNING (d): **restored** the both-sides parent-predicate-clash RETURNING
  assertion (`where label = 'PX'` → both sides land); kept a both-sides child-predicate
  RETURNING case; kept a single-side `returning *` child-clash; **dropped** the deferral
  NOTE that pointed at this ticket.
- Phase 2 multi-source section: **added** a NON-RETURNING twin (`pc_*` fresh tables) —
  the repro shape predicating on the FK-parent's reassigned column with no RETURNING,
  asserting both `note` and `label` land and the view reflects it.
- Pre-existing both-sides cases (`ms_jv` line ~163, no-RETURNING) and all single-side /
  RETURNING (e)-edge cases continue to pass — they now exercise the void-path and
  single-side capture paths respectively.

Validation run (all green):
- `yarn build` (tsc) — clean.
- Full `packages/quereus` suite: **4260 passing, 9 pending, 0 failing**.
- Full repo `yarn test` (memory): **0 failing** across all workspaces.
- `yarn lint` (quereus, single-quoted globs): clean.

## Reviewer focus / known gaps (treat tests as a floor)

- **Optimizer cross-talk on the injected key ref.** I mint a **fresh**
  `InternalRecursiveCTERefNode` per base op (via `withKeyCapture` called inside the
  `baseOps.map`) sharing the one descriptor, specifically to avoid two subtrees sharing a
  node instance. Worth confirming there's no memoization keyed on node identity that
  would still couple them, and that the both-sides plan optimizes/emits as expected
  (emit-roundtrip-property.spec passed, but it does not specifically target this shape).
- **strict-fork mode not exercised.** I did not run with `QUEREUS_FORK_STRICT` set. The
  capture set/delete now wraps the whole `run` (mirroring the prior RETURNING-update and
  envelope patterns), but a reviewer running strict-fork would harden the
  "context mutated while a fork is live" question, since base-op sub-programs can fork
  internally (e.g. fanout-lookup-join).
- **No both-sides + body-WHERE test.** The capture's `idPredicate` is user WHERE ∧ body
  WHERE (identical to the live subquery's), so a both-sides update through a view whose
  body carries its own WHERE *should* capture exactly the pre-mutation visible set — but
  there is no dedicated test combining a join body WHERE with a both-sides predicate
  clash. (`ax_filt` is single-side; `fjoin` push-out-of-filter is single-side + RETURNING.)
  Consider adding one.
- **k0/k1 column-name collision.** The captured columns are literally `k0`/`k1`; the
  base op subquery is `select k0 from __vmupd_keys` (resolves against the `__vmupd_keys`
  FROM scope, not the base table). Collision with a real base column named `k0`/`k1` is
  implausible and resolves to the inner scope regardless, but it is untested.
- **Out of scope (unchanged, still correct):** an update that rewrites a **base PK** or
  the **join-key/FK** column breaks the captured `(k0,k1)` identity (those columns are
  generally not writable through supported shapes); the general n-base snapshot-consistent
  multi-side **DELETE** fan-out remains deferred (`decomposeDelete` routes to one side and
  was not touched).

## Docs

`docs/view-updateability.md` updated: § Inner Join Phase-2a box now describes the
both-sides up-front capture (`select k<side> from __vmupd_keys`); § Multi-Base-Table
Mutations adds a "Shipped — eager key materialization" note realizing the pre-statement
snapshot guarantee for both-sides row identification; § `returning` Clauses update bullet
renamed `__vmret_keys`→`__vmupd_keys` / `returningCapture`→`identityCapture` and notes the
single shared capture; the Residual-edges paragraph drops the now-closed both-sides
parent-predicate-clash from the deferred list.
