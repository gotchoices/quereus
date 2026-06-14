description: Re-plan context for a CTE-name DML target now respects per-CTE definition-order visibility — the target's body sees only its PRIOR siblings. A target body that reads a sibling defined LATER (whose name shadows a real table) now writes through to the real table instead of rejecting (`CTEReference … not updateable in phase 1`). Review the prior-sibling-prefix stripping in `contextForCteTarget`, the 3 caller signature changes, and the flipped/added tests.
files:
  - packages/quereus/src/planner/building/dml-target.ts          # contextForCteTarget — new signature (ctx, withClause, targetName) + strip target-and-later siblings
  - packages/quereus/src/planner/building/update.ts              # caller (line ~90): passes stmt.withClause!
  - packages/quereus/src/planner/building/delete.ts              # caller (line ~90): passes stmt.withClause!
  - packages/quereus/src/planner/building/insert.ts              # caller (line ~478): passes stmt.withClause!
  - packages/quereus/src/planner/building/view-mutation-builder.ts # READ-ONLY: ctx is the shared body+user-clause context; self-capture (ctxSelfRead) re-adds only the target name
  - packages/quereus/src/planner/mutation/single-source.ts       # READ-ONLY: cteTarget doc-comment still says "target-EXCLUDED" (accurate; prior-sibling-prefix is a superset — left unchanged)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # flipped forward-ref test + new reject test (~line 3279); self-read×later-sibling combo (~line 3379)
  - docs/view-updateability.md                                   # sibling-visibility prose (~676), ctxBody (~680), removed forward-ref boundary + added user-clause boundary (~695)

# CTE-name DML target: forward-reference shadowing a real table — REVIEW

## What changed

Per SQL definition-order scoping a non-recursive CTE is visible only to *later* siblings
and the main query. So inside a CTE-name DML target's body, a sibling defined LATER is out
of scope, and a same-named `from` source in the body should bind the **real** base table.

Before: `contextForCteTarget` removed only the *target's own* name from `cteNodes` and left
every other sibling — including later ones — in scope for the body re-plan. A body reading a
later sibling that shadowed a real table resolved to a `CTEReferenceNode` and rejected with
`is not updateable in phase 1`.

After: `contextForCteTarget` strips the target's own name **and every sibling defined at or
after it** from a *copied* `cteNodes`, leaving only the target's **prior** siblings in
scope. This mirrors `buildCommonTableExpr` (`with.ts:67`), which builds each CTE body against
the prior siblings only. The motivating statement now writes through:

```sql
create table fwd (id integer primary key, color text);
insert into fwd values (1,'red'),(2,'green');
with x as (select id, color from fwd), fwd as (select id, color from fwd)
    update x set color='z' where id=1;
select * from fwd order by id;
-- → [{"id":1,"color":"z"},{"id":2,"color":"green"}]   (was: error "is not updateable in phase 1")
```

### Signature change (1 function, 3 callers)

`contextForCteTarget(ctx, cteName)` → `contextForCteTarget(ctx, withClause, targetName)`.
It needs the WITH clause to compute the prior-sibling prefix (the name alone is
insufficient). The 3 callers (`update.ts`, `delete.ts`, `insert.ts`) thread
`stmt.withClause!` — guaranteed non-null on the CTE-name path because `resolveCteTarget`
returns `undefined` when `withClause` is absent. The non-null assertion is the path
guarantee, not a type loosening. **Lint/tsc (run via `yarn lint`) confirms no signature
drift remains.**

Implementation detail: `idx = findIndex(target)`; removal set is `slice(idx)` (target +
later). Guards: early-return byte-identical when `cteNodes` empty/absent; `idx < 0`
returns `ctx` unchanged (defensive — `resolveCteTarget` already matched). Removal is by
lowercased name, on a copied `Map` (the spread of `ctx` preserves `cteReferenceCache`; the
copy never mutates the caller's map).

## Validation done

- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json`).
- `yarn workspace @quereus/quereus test` — **6231 passing, 9 pending, exit 0** (memory vtab).
- NOT run: `yarn test:store` (LevelDB path) — this change is pure planner re-plan-context
  construction with no storage interaction; the store path is not implicated. Reviewer may
  run it if desired but it is not expected to differ.

## Tests to focus on (`packages/quereus/test/logic/93.4-view-mutation.sqllogic`)

**Flipped / added (~line 3279):**
- `fwd` — forward-ref write-through: target is the FIRST CTE; body reads a LATER sibling
  `fwd` shadowing a real table → writes through to the real `fwd`. (was a reject)
- `fwdr`/`later` — forward name with NO real backing → clean `Table 'later' not found`
  (the later CTE is out of scope, no real object to fall back to). Verify the error
  assertion convention matches the harness (matched `-- error: Table 't' not found` style
  already in the file at ~line 3507).

**Added self-read interaction (~line 3379):**
- `hwls` — self-read × later-sibling combo: target `t` (first CTE) self-reads in WHERE; its
  body reads `hwls` which is ALSO a later sibling shadowing the real table. Body + eager
  capture are planned prior-sibling-prefix (over the REAL `hwls`); the self-read `from t`
  resolves to the capture. Confirms the self-capture path (`ctxSelfRead`, which re-adds only
  the target name) is untouched by later-sibling stripping. → Halloween-safe write.

**Regression guards (verify unchanged — these pin the no-regression boundary):**
- `base2` (~3269) — combined shadow + inline: target is the LATER sibling reading a PRIOR
  sibling `a`; prior sibling stays in scope. (Target-is-last case ⇒ removal set is just the
  target ⇒ byte-identical to old behavior.)
- `ml2`/`mlren`/`mlrens` (~3243-3267) — multi-level prior-sibling chains stay inlinable.
- `hw`/`hwk`/`base`/`hwd`/`hwret`/`hwq` (~3344+) — self-read capture path untouched.

## Reviewer attention / known gaps (be adversarial here)

1. **Shared body + user-clause context (accepted v1 boundary).** The body re-plan AND the
   user `where`/`set`/`returning` descend share the SAME `ctx` (`view-mutation-builder.ts`
   `propagate(ctx, view, req, ctxSelfRead)`). Stripping later siblings from `ctx` strips
   them from the user clauses too. Per strict SQL the UPDATE/DELETE user clause is
   main-query scope and *should* see later siblings. **Decision (from the plan, accepted):**
   single-function fix; a user-clause read of a later sibling resolves to a real same-named
   table or table-not-found — never silently the wrong relation. No existing test reads a
   non-target later sibling from a user clause. The faithful fix (a second context threaded
   through propagate/single-source/multi-source) was deemed disproportionate. **Reviewer:
   confirm you agree this is an acceptable v1 boundary, and that there is genuinely no test
   that exercises a user-clause later-sibling read that would now silently change.** If you
   want belt-and-suspenders coverage, a cheap negative test (`with x as (…), y as (…) update
   x set c = (select … from y) …` resolving `y` to a real table or erroring) could be added.

2. **Parent-WITH CTE shadowed by a later sibling of same name (deep corner).** If a later
   sibling shadows a same-named parent-WITH CTE, removing the name drops the shadowed parent
   too (the `cteNodes` entry is the later sibling, overwritten in `buildWithContext`).
   Whether the parent should be visible in an earlier sibling's body is genuinely ambiguous
   SQL; v1 resolves to the real table / not-found. Documented, not special-cased. **No test
   added for this** (deep, ambiguous) — flag if you think one is warranted.

3. **Multi-source (join-bodied) target & decomposition paths.** These also receive `ctx`
   (`view-mutation-builder.ts` decompose* branches), so later-sibling stripping applies
   uniformly — no path-specific handling. The join-intermediate reject tests (~line 3313)
   still reject on body shape, not name resolution (confirmed by the green suite). Reviewer:
   worth a glance that a join-body target reading a later sibling reaches the real table the
   same way — not separately covered by a dedicated positive test.

4. **Inline-subquery target deliberately untouched.** `resolveSubqueryTarget` does NOT call
   `contextForCteTarget` (an inline subquery sits after the WITH clause and sees ALL
   siblings, with no own-name to shadow). Confirm that path and its
   `flattenCteBody(..., stmt.withClause?.ctes ?? [], undefined)` call were not changed.

5. **`single-source.ts` doc-comment** (line ~102) still says the context is "target-EXCLUDED
   (`contextForCteTarget`)". Left as-is because it remains true (the target IS excluded;
   prior-sibling-prefix is a superset). Reviewer may want it nuanced to "prior-sibling-prefix"
   for precision — judged not worth a churn edit.

## Docs

`docs/view-updateability.md` § Common Table Expressions updated: sibling-visibility prose
(now "prior siblings only", with the forward-ref example and the `buildCommonTableExpr`
mirror), `ctxBody` description (prior-sibling-prefix, target + later excluded), removed the
"Forward-reference shadowing a real table" v1 boundary bullet, added the narrowed
"User-clause read of a later-defined sibling" boundary. The `contextForCteTarget`
doc-comment block in `dml-target.ts` was rewritten to describe prior-sibling-prefix removal
and the two shared-context consequences.
