description: Admit outer-join (left / right / full) bodies into the multi-source write-through substrate for the statically-expressible cases — preserved-side update passthrough, delete-to-preserved-by-default, and insert routing (both-side / preserved-only / non-preserved-only). The per-row null-extended-update → insert materialization is deferred to `view-write-optional-member-transitions`.
prereq: view-write-nway-inner-join
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Why

`docs/view-updateability.md` § Outer Joins fully specifies outer-join write-through and the `null-extended` lineage site already exists (`deriveJoinUpdateLineage` wraps non-preserved sides under the join-predicate guard). What is missing is the **consumer**: `collectInnerJoinSources` (`multi-source.ts`) rejects every non-inner join (`joinType !== 'inner'`), so an outer-join body — including the lens default-mapper's outer-joined optional members — is rejected wholesale. This ticket admits outer joins and wires the cases the **static** base-op fan-out can express, which is most of the model's value (the Car optional-member insert/delete). The one case that needs new runtime — an update on a non-preserved column, which is a per-row insert-or-update branch — is split into `view-write-optional-member-transitions` and stays rejected here with a precise deferral diagnostic.

## What the lineage already gives us

`resolveBaseSite` / `BackwardColumn.nullExtended` already mark non-preserved-side columns non-writable with `nullExtended: true`, carrying the inner base site and the join-predicate guard. `analyzeJoinView` already routes these into `OutColumn { writable: false, nullExtended: true, … }`. So the backward walk is ready; the work is (a) stop rejecting the join shape and (b) per-op routing that honors preserved vs non-preserved.

## Target architecture

### Recognition

Generalize `collectInnerJoinSources` (now n-way from the prereq) to accept `joinType ∈ {inner, left, right, full}`. Record per side whether it is **preserved** or **non-preserved** *for each outer join in the chain* (a side can be preserved relative to one join and non-preserved relative to another in a >2-table chain; for v1, scope outer joins to the two-table and simple anchor-rooted shapes — a left/right join of two tables, or an anchor inner-joined to ≥1 left-joined optional member, mirroring the decomposition default mapper). `full outer join` is the generalization where every side is both (§ Outer Joins). Surface the preserved/guard info on `JoinSide` (e.g. `preserved: boolean`, `guard?: AST.Expression`) derived from the planned `JoinNode.joinType` + condition, not re-parsed from AST.

### UPDATE

- **Preserved-side column** → ordinary base update, unchanged passthrough (the row is never null-extended on that side).
- **Matched non-preserved-side column where the per-row guard provably holds** — not statically decidable in general (the guard is per-row), so a non-preserved-side `set` **defers** here.
- **Non-preserved-side column** (the general per-row matched-vs-null-extended split) → **reject** with a new precise diagnostic (`unsupported-outer-join-update`, message naming the deferral to the insert/delete materialization fan-out) — the same class of deferral `decomposition.ts` already raises for optional-member updates (`unsupported-decomposition-update`). Picked up by `view-write-optional-member-transitions`.

### DELETE

Route to the **preserved** side(s) by default (§ Outer Joins — "the only way for the joined row to disappear from the view; deleting from the non-preserved side merely null-extends it"). Tags override (`delete_via` / `target` / `exclude`) within the candidate set, reusing `chooseDeleteSides` with the candidate set restricted to preserved sides by default. The eager key capture + identifying predicate are unchanged (built from the preserved side's PK).

### INSERT

Follow structural intent (§ Outer Joins — Inserts):
- values for both sides → inserts on both sides under the join predicate (the existing multi-source insert envelope, with the non-preserved side's columns supplied);
- values only for the **preserved** side → a single preserved-side insert (the row is null-extended through the view);
- values only for the **non-preserved** side → requires the join predicate satisfiable against an existing preserved row; reject (`null-extended-create-conflict`) when not — for v1, an insert that supplies *only* non-preserved columns with no preserved-side key to join may stay rejected (document it) since the envelope mints/threads the shared key from the anchor (preserved) side.

This reuses `analyzeMultiSourceInsert` / `buildMultiSourceInsert`; the change is recognizing non-preserved sides as **optional** members of the envelope fan-out (a side whose columns are all absent emits no insert — the per-row presence gate the decomposition insert already implements in `buildDecompositionMemberInsert`). Lean on that existing presence-gate machinery rather than inventing a second one.

### The decomposition path already handles optional-member insert/delete

`decomposition.ts` already inserts/deletes optional (outer-joined) members correctly (presence-gated insert, anchor-last delete). So the lens Car optional-member **insert** and **delete** already work through the decomposition path; this ticket brings the **generic multi-source join** path (a hand-written `left join` view, not a decomposition advertisement) to parity for insert/delete + preserved-update.

### Static surfaces

Relax the outer-join body-level all-`NO` gate in `func/builtins/schema.ts` (`deriveViewInfo` / `deriveColumnInfo`) to **per-side** writability now that outer joins are partially writable: a preserved-side column reports `is_updatable = 'YES'`; a non-preserved-side column reports `'NO'` (update deferred) but the view is `is_insertable_into` / `is_deletable` per the new routing. Keep the surfaces agreeing with the dynamic `propagate()` truth — a non-preserved update still rejects, so `column_info` must report that column `'NO'`.

## Out of scope (defer / keep rejecting)

- **Update on a non-preserved-side column** (matched→update / null-extended→insert per-row branch) → `view-write-optional-member-transitions`. Reject here with `unsupported-outer-join-update`.
- Decomposition **optional-member update** (`unsupported-decomposition-update`) — also `view-write-optional-member-transitions`; untouched here.
- Cross-source `set` through an outer join — stays rejected (`view-write-cross-source-set` is inner-join only).

## Tests (acceptance gate: `test/property.spec.ts` § View Round-Trip Laws → `describe('multi-source inner join')` + a new outer-join block)

Build on the existing `rj_outer` fixture (`create view rj_outer as select c.cc as cc, c.cv as cv, p.pv as pv from rjchild c left join rjparent p on p.pp = c.pr`, property.spec ~L3452):

- **Insert, both sides** — flip the current negative `expectMutationReject('insert into rj_outer (cc, cv, pv) values (2,22,222)','unsupported-join')` (property.spec ~L3458) to an **accept**: inserts the child + (presence-gated) parent; round-trip green.
- **Insert, preserved-only** (`insert into rj_outer (cc, cv) values (…)`) — single preserved-side (child) insert; the row reads back null-extended (`pv` null).
- **Preserved-side update** (`update rj_outer set cv = NV where cc = K`) — child-only update; PutGet green (including rows whose parent is absent — null-extended rows stay null-extended).
- **Delete** (`delete from rj_outer where cc = K`) — routes to the preserved (child) side; the joined row disappears; an unmatched/null-extended row is deletable too. GetPut variant.
- **Negative (deferred, still red):** `update rj_outer set pv = NV where cc = K` rejects with `unsupported-outer-join-update` (non-preserved update — handed to the transitions ticket). Keep the `rj_self` / composite negatives per their owning tickets.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` and `yarn workspace @quereus/quereus lint`.

## TODO

- Generalize `collectInnerJoinSources` to accept `left`/`right`/`full`; surface per-side `preserved` + `guard` on `JoinSide`, derived from the planned `JoinNode`.
- UPDATE: route preserved-side assignments as ordinary base updates; reject a non-preserved-side assignment with a new `unsupported-outer-join-update` diagnostic (add to `mutation-diagnostic.ts` reason union) naming the transitions-ticket deferral.
- DELETE: default the candidate sides to the preserved side(s); keep tag overrides within candidates; reuse the existing capture.
- INSERT: treat non-preserved sides as presence-gated optional members of the envelope fan-out (reuse the decomposition presence-gate machinery); implement preserved-only and both-side routing; reject non-preserved-only-with-no-join-target (`null-extended-create-conflict`) for v1 with a documented message.
- Relax the outer-join all-`NO` gate in `func/builtins/schema.ts` to per-side; verify `view_info` / `column_info` agree with the dynamic truth (preserved `'YES'`, non-preserved update `'NO'`).
- Add the `rj_outer` accepts/negatives above; flip the insert negative; keep the non-preserved-update negative red.
- Update `docs/view-updateability.md` § Outer Joins (remove the "not yet wired" note for insert/delete/preserved-update) and § Current limitations (narrow to "non-preserved-side update materialization").
