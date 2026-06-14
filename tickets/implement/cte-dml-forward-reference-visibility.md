description: A CTE-name DML target whose body reads a sibling CTE defined LATER (whose name also shadows a real base table) currently rejects (`CTEReference … not updateable in phase 1`) instead of writing through to the real table, because `contextForCteTarget` removes only the target's OWN name from `cteNodes` and leaves every other sibling — including the later one — in scope for the body re-plan. Make the re-plan context respect per-CTE definition-order visibility: the body sees only the target's PRIOR siblings.
difficulty: medium
files:
  - packages/quereus/src/planner/building/dml-target.ts          # contextForCteTarget — change signature + strip target-and-later siblings; ctesBefore helper already here
  - packages/quereus/src/planner/building/update.ts              # caller: contextForCteTarget(contextWithCTEs, cteTarget.name)
  - packages/quereus/src/planner/building/delete.ts              # caller: same
  - packages/quereus/src/planner/building/insert.ts              # caller: same
  - packages/quereus/src/planner/mutation/cte-flatten.ts         # READ-ONLY reference: flattener already respects prior-sibling-only visibility (its own ctesBefore)
  - packages/quereus/src/planner/building/with.ts                # READ-ONLY reference: buildCommonTableExpr builds each body against PRIOR siblings only (the read-path analog this mirrors)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # flip the "FORWARD reference" boundary test (~line 3279) to a positive write-through; add edge tests
  - docs/view-updateability.md                                   # remove the "Forward-reference shadowing a real table" v1 boundary (~line 696); nuance the sibling-visibility prose (~line 676); update the ctxBody description (~line 680)

# CTE-name DML target: forward-reference shadowing a real table

## Problem

```sql
create table fwd (id integer primary key, color text);
insert into fwd values (1,'red');
with x as (select id, color from fwd), fwd as (select id, color from fwd)
    update x set color='z' where id=1;
-- v1: error "is not updateable in phase 1" (CTEReference). Should write through to real fwd.
```

Per SQL scoping a non-recursive CTE is visible only to *later* siblings and the main
query, so inside `x`'s body the later `fwd` CTE is out of scope and `from fwd` binds the
**real** base table. The statement should write through to `fwd`.

The flattener (`cte-flatten.ts`) is already correct here — it treats `x`'s body as
terminal (only PRIOR siblings, `ctesBefore`, are inlinable, and `x` has none). The reject
originates in the **re-plan context**: `contextForCteTarget` (`dml-target.ts:171`) removes
only the *target's own* name from `cteNodes` and leaves every other sibling — including
the later `fwd` — in scope. So when the ephemeral body `select id, color from fwd` is
re-planned, `buildFrom` resolves `fwd` against `cteNodes` (which still holds the later
CTE) → `CTEReferenceNode` → `no-base-lineage`.

Not silently wrong today — a clean reject, never a write to the wrong table.

## Fix

Make `contextForCteTarget` strip the target's own name **and every sibling defined at or
after it** in the statement's WITH clause, leaving only the target's **prior** siblings (+
any parent-WITH CTEs of unrelated names) in `cteNodes`. This mirrors `buildCommonTableExpr`
(`with.ts:67`), which builds each CTE body against the prior siblings only (`existingCTEs`
holds just the CTEs constructed so far when it plans each body).

### Signature change

`contextForCteTarget` currently takes `(ctx, cteName: string)` and cannot compute the
prior-sibling prefix from the name alone. Change it to take the WITH clause too:

```ts
export function contextForCteTarget(
  ctx: PlanningContext,
  withClause: AST.WithClause,
  targetName: string,
): PlanningContext {
  if (!ctx.cteNodes?.size) return ctx;
  const idx = withClause.ctes.findIndex(c => c.name.toLowerCase() === targetName.toLowerCase());
  // The target itself + every sibling defined at-or-after it are out of scope inside the
  // target's body (a non-recursive CTE sees only PRIOR siblings). idx is always >= 0 here
  // (resolveCteTarget already matched targetName), so slice(idx) is the removal set.
  const shadowed = new Set(withClause.ctes.slice(idx < 0 ? 0 : idx).map(c => c.name.toLowerCase()));
  const cteNodes = new Map(ctx.cteNodes);
  for (const name of shadowed) cteNodes.delete(name);
  return { ...ctx, cteNodes };
}
```

Notes on the implementation:
- The existing private `ctesBefore(withClause, cte)` helper (`dml-target.ts:146`) already
  computes the prior-sibling array; you may reuse/generalize it, but the removal set is the
  complementary slice (`slice(idx)`), so computing it directly as above is simplest.
- Keep the early-return when `cteNodes` is empty/absent (a WITH-less DML or a single bare
  CTE with no parent context) — byte-identical to today for those.
- Removal is by **name** (lowercased). If a later sibling shadows a same-named parent-WITH
  CTE, the `cteNodes` entry is the later sibling (overwritten in `buildWithContext`), so
  removing the name also drops the shadowed parent — see Edge cases. This matches today's
  behavior for the target's own name (already removed) and is the consistent v1 boundary.

### Callers (3 sites)

Each currently calls `contextForCteTarget(contextWithCTEs, cteTarget.name)`. Thread the
WITH clause (`stmt.withClause`, guaranteed non-null on the CTE-name path because
`resolveCteTarget` returned truthy):

- `update.ts` — `contextForCteTarget(contextWithCTEs, stmt.withClause!, cteTarget.name)`
- `delete.ts` — same
- `insert.ts` — same (note: insert builds `contextWithCTEs` inline inside the `if (cteTarget)` block)

Use a non-null assertion or a local guard; do not loosen the type beyond what the path
guarantees.

## Design decision (resolved): body vs user-clause context

The body re-plan AND the user `where`/`set`/`returning` descent share the **same** `ctx`
inside `buildViewMutation` → `propagate` → `single-source` (`view-mutation-builder.ts:173`,
`propagate(ctx, view, req, ctxSelfRead)`). The only existing split is `ctxSelfRead`, which
re-adds the **target's own** name (bound to an eager capture) for a Halloween-safe
self-read; sibling resolution is shared.

Consequence: stripping later siblings from `ctx` strips them from the user clauses too. Per
strict SQL the UPDATE/DELETE user clause is main-query scope and *should* see later
siblings. **Decision: accept the shared context (single-function fix).** Rationale:
- The motivating bug has no user-clause later-sibling reference; the fix is correct for it.
- No existing test reads a *non-target* sibling from a user clause (verified by grep over
  `93.4-view-mutation.sqllogic`), so nothing regresses.
- It is consistent with the documented v1 user-clause limitation (the target's own name
  only resolves via the self-capture path).
- It is never silently wrong: a user-clause read of a later sibling resolves to a real
  same-named table (deterministic, explainable) or errors table-not-found.
- The faithful alternative (a separate user-clause context retaining full sibling
  visibility) would thread a second context through propagate/single-source/multi-source —
  disproportionate and outside this ticket's "re-plan context construction" scope.

Document the user-clause-reads-a-later-sibling case as the (narrowed) remaining v1 boundary
in `docs/view-updateability.md`; do **not** build the split here.

## Tests (`packages/quereus/test/logic/93.4-view-mutation.sqllogic`)

Flip the existing "v1 boundary — a FORWARD reference …" block (~line 3279-3289) from a
reject to a positive write-through, and add edge coverage. In the spirit of TDD, the
expected outputs:

- **Flip the boundary test** — target is the first CTE, body reads a later sibling that
  shadows a real table; writes through to the real table:
  ```sql
  create table fwd (id integer primary key, color text);
  insert into fwd values (1,'red'),(2,'green');
  with x as (select id, color from fwd), fwd as (select id, color from fwd)
      update x set color='z' where id=1;
  select * from fwd order by id;
  → [{"id":1,"color":"z"},{"id":2,"color":"green"}]
  ```
  (The later `fwd` CTE is never the write target and is unused; `x`'s body binds the real
  `fwd`.)

- **Forward name with NO real backing rejects cleanly** — a body that reads a later sibling
  whose name is NOT a real table is table-not-found (the later CTE is out of scope, no real
  object to fall back to):
  ```sql
  create table fwdr (id integer primary key, color text);
  insert into fwdr values (1,'red');
  with x as (select id, color from later), later as (select * from fwdr)
      update x set color='z' where id=1;
  -- error: <table-not-found shape for 'later'>
  ```
  Confirm the actual diagnostic wording when implementing (match the harness's
  table-not-found assertion convention used elsewhere in this file).

- **Regression guards (must still pass — already in the file, verify unchanged):**
  - Combined shadow + inline (`base2`, ~line 3269): target is the *later* sibling reading a
    *prior* sibling `a` — prior sibling stays in scope. → `[{"id":1,"color":"z"},{"id":2,"color":"green"}]`
  - Multi-level prior-sibling chains (`ml2`/`mlren`/`mlrens`, ~line 3243-3267): prior
    siblings must remain visible/inlinable. Unchanged expected outputs.
  - Self-read tests (`hw`/`hwk`/`base`/…, ~line 3346+): the target-own-name capture path is
    untouched (still uses `ctxSelfRead`).

## Docs (`docs/view-updateability.md`)

- **Remove** the "Forward-reference shadowing a real table" v1 boundary bullet (~line 696)
  from the § Common Table Expressions "v1 boundaries" list.
- **Nuance** the sibling-visibility sentence (~line 676): "Sibling CTEs stay in scope" →
  only **prior** siblings stay in scope for the body re-plan (later siblings are out of
  scope, mirroring SQL's definition-order visibility and `buildCommonTableExpr`).
- **Update** the `ctxBody` description (~line 680, "the existing target-**excluded**
  context (`contextForCteTarget`)") to say it is now the prior-sibling-prefix context
  (target + later siblings excluded), not just own-name-excluded.
- **Add** (or fold into the v1-boundaries list) the narrowed remaining boundary: a
  *user-clause* read of a later-defined sibling resolves to a real same-named table (or
  table-not-found), not the later CTE — because body and user clause share one re-plan
  context in v1.
- Update the doc comment on `contextForCteTarget` in `dml-target.ts` (the big block at
  ~line 151-170) to describe prior-sibling-prefix removal rather than own-name-only removal.

## Edge cases & interactions

- **Target is the first CTE (no prior siblings).** Removal set is the whole WITH clause;
  `cteNodes` keeps only unrelated parent-WITH CTEs. Body's same-named FROM binds the real
  table (the flipped boundary test). Verify no crash when `cteNodes` becomes empty.
- **Target is the last CTE.** Removal set is just the target; all earlier siblings stay —
  byte-identical to today (the `base2`/multi-level tests pin this). This is the no-regression
  guard for the common case.
- **Forward name with no real table.** Resolves to table-not-found (covered above) — clean
  reject, never silently wrong.
- **Parent-WITH CTE shadowed by a later sibling of the same name.** Removing the name drops
  the shadowed parent too (the `cteNodes` entry is the later sibling). Whether the parent
  should be visible in an earlier sibling's body is genuinely ambiguous SQL; v1 resolves the
  name to the real table / not-found. Deep corner — document, do not special-case. Never
  silently wrong.
- **Self-read interaction (`needsSelfCapture` / `ctxSelfRead`).** The self-capture re-adds
  the **target name** only; later-sibling removal does not touch it. `buildCteSelfCapture`
  plans the body under the (now prior-sibling-prefix) `ctx`, which is *more* correct for the
  capture body (it should not see later siblings either). Verify a self-read test that also
  has a later sibling still captures + writes correctly (or add one if cheap).
- **Multi-source (join-bodied) CTE target & decomposition paths.** These also receive `ctx`
  (`view-mutation-builder.ts:163-168`). Stripping later siblings applies uniformly — a
  join-body CTE target reading a later sibling now reaches the real table the same way.
  No path-specific handling needed; confirm the join-intermediate reject tests (~line 3313)
  still reject on body shape, not on name resolution.
- **Inline-subquery target unaffected.** `resolveSubqueryTarget` does NOT call
  `contextForCteTarget` (an inline subquery sits after the WITH clause and sees ALL siblings,
  with no own-name to shadow). Leave that path and its `flattenCteBody(..., stmt.withClause?.ctes ?? [], undefined)`
  call untouched.
- **`cteReferenceCache` sharing.** `contextForCteTarget` spreads `ctx` (preserving
  `cteReferenceCache`); removing entries from a *copied* `cteNodes` map must not mutate the
  caller's map or the cache. Confirm the copy (`new Map(ctx.cteNodes)`) — already the
  pattern today.

## TODO

- [ ] Change `contextForCteTarget` signature to `(ctx, withClause, targetName)` and strip
      target-and-later siblings from a copied `cteNodes` (keep the empty-map early return).
- [ ] Update its doc-comment block to describe prior-sibling-prefix visibility.
- [ ] Update the 3 callers (`update.ts`, `delete.ts`, `insert.ts`) to pass `stmt.withClause`.
- [ ] Flip the "FORWARD reference" boundary test to a positive write-through; add the
      no-real-backing reject test.
- [ ] Verify the `base2` / multi-level / self-read regression tests still pass unchanged.
- [ ] Update `docs/view-updateability.md`: remove the forward-reference v1 boundary, nuance
      the sibling-visibility prose, update the `ctxBody` description, add the narrowed
      user-clause boundary.
- [ ] Run `yarn workspace @quereus/quereus test` (logic suite) and `yarn lint` (catches the
      signature-drift at the 3 call sites + the test-file tsc pass). Stream output with
      `2>&1 | tee` per AGENTS.md.
