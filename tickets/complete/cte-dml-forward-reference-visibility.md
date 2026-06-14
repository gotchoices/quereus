description: CTE-name DML target re-plan context now respects per-CTE definition-order visibility — a target body sees only its PRIOR siblings; a same-named later sibling (shadowing a real table) writes through to the real table instead of rejecting `CTEReference … not updateable in phase 1`. Reviewed, validated, and pinned the documented v1 user-clause boundary with a regression test.
files:
  - packages/quereus/src/planner/building/dml-target.ts          # contextForCteTarget(ctx, withClause, targetName) — strip target + later siblings
  - packages/quereus/src/planner/building/update.ts              # caller passes stmt.withClause!
  - packages/quereus/src/planner/building/delete.ts              # caller passes stmt.withClause!
  - packages/quereus/src/planner/building/insert.ts              # caller passes stmt.withClause!
  - packages/quereus/src/planner/mutation/single-source.ts       # doc-comment nuanced: "target-EXCLUDED" → "prior-sibling prefix (superset of target-exclusion)"
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # flipped fwd, added fwdr/hwls, + NEW v1-boundary user-clause-later-sibling test
  - docs/view-updateability.md                                   # prior-sibling-visibility prose + user-clause boundary

# CTE-name DML target: forward-reference shadowing a real table — COMPLETE

## Summary

`contextForCteTarget` now strips the target CTE's own name **and every sibling defined at or
after it** from a copied `cteNodes`, leaving only the target's **prior** siblings in scope for
the body re-plan. This mirrors `buildCommonTableExpr` (each CTE body is built against its prior
siblings only). The motivating statement now writes through to the real table:

```sql
with x as (select id, color from fwd), fwd as (select id, color from fwd)
    update x set color='z' where id=1;
-- → writes the REAL fwd table (was: error "is not updateable in phase 1")
```

Signature changed `contextForCteTarget(ctx, cteName)` → `(ctx, withClause, targetName)` (the
WITH clause is needed to compute the prior-sibling prefix); the 3 callers thread
`stmt.withClause!` — non-null on the CTE-name path because `resolveCteTarget` returns `undefined`
when `withClause` is absent.

## Review findings

Adversarial pass over the implement diff (`f41b7072`), read fresh before the handoff summary.
Scrutinized: correctness of the prefix-stripping, signature/type-safety, the self-capture path,
the inline-subquery path, the parent-WITH and multi-source corners, DRY/altitude, docs accuracy,
and test coverage (happy/edge/error/regression).

**Correctness — verified sound.**
- The `slice(idx)` removal set (target + later) is computed by lowercased-name `findIndex`, with a
  defensive `idx < 0` → no-op guard and an early-return when `cteNodes` is empty. `resolveCteTarget`
  already matched the name, so `idx >= 0` in practice; the guard is belt-and-suspenders. Removal is
  on a *copied* `Map` (spread preserves `cteReferenceCache`; caller's map never mutated). ✓
- **Flattener / context consistency.** `ctesBefore` (object-identity `indexOf`, used by the
  flattener to inline) and `contextForCteTarget` (name-based `findIndex`, used to strip) compute the
  *same* prefix boundary at the target. The flattener inlines only PRIOR siblings; the context keeps
  only PRIOR siblings and strips target+later. Fully consistent — no case where a sibling is both
  inlined and left dangling, or stripped while still referenced. ✓
- **Self-capture path untouched.** `ctxSelfRead = withCteCapture(ctx, view.name, selfCapture)`
  re-adds *only* the target name to the prior-sibling-prefix `ctx`. Later-sibling stripping is
  orthogonal — confirmed in `view-mutation-builder.ts:161` and exercised by the new `hwls` test
  (self-read × later-sibling shadow → Halloween-safe write). ✓
- **Type safety.** The `stmt.withClause!` assertions are path guarantees (the `if (cteTarget)`
  branch is unreachable without a WITH clause), not type loosening. tsc/eslint clean. ✓

**Reviewer-attention items (from the handoff) — checked.**
1. *User-clause read of a later-defined sibling (shared body+user-clause ctx, accepted v1
   boundary).* Confirmed: no existing test exercised it. **Fixed inline (minor):** added a positive
   regression test (`ysib`/`ucbase`, ~line 3301) — a `set`-subquery read of a later sibling `ysib`
   that shadows a real table resolves to the REAL table (`v=42`), NOT the later CTE (`999`). This
   pins the documented "never silently the wrong relation" guarantee and will intentionally flip if
   the faithful split-context fix ever lands. Test passes.
2. *Parent-WITH CTE shadowed by a later sibling of same name.* Genuinely-ambiguous SQL; v1 resolves
   to the real table / not-found. Documented in the `contextForCteTarget` doc-comment and the v1
   boundary list. No test (deep, ambiguous) — agree it is not warranted.
3. *Multi-source (join-bodied) target & decomposition paths.* All receive the same single `ctx`, so
   later-sibling stripping applies uniformly with no path-specific handling. Mechanism is identical
   to the single-source path (one shared re-plan context). Not separately tested; mechanism review
   judged sufficient — no new test.
4. *Inline-subquery target untouched.* Verified `resolveSubqueryTarget` is unchanged and does NOT
   call `contextForCteTarget` — an inline subquery sits after the WITH and correctly sees ALL
   siblings. ✓
5. *`single-source.ts` doc-comment said "target-EXCLUDED".* **Fixed inline (minor):** nuanced to
   "narrowed to the target's prior-sibling prefix (`contextForCteTarget`, a superset of
   target-exclusion)" for precision. The sibling comment at line ~1134 was left as-is — there the
   target-vs-`descendCtx` contrast is precisely about the target name, so "target-EXCLUDED" is the
   correct framing and nuance would add noise.

**Docs.** Re-read `docs/view-updateability.md` § Common Table Expressions and the rewritten
`contextForCteTarget` / `single-source.ts` doc-comments against the new behavior — all reflect
prior-sibling-prefix visibility, the removed forward-ref boundary, and the added user-clause
boundary. Accurate. ✓

**Tests run.**
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — **clean** (before and after my edits).
- `yarn test` (full quereus, memory vtab) — **6231 passing, 9 pending, exit 0**.
- `yarn test --grep "93.4-view-mutation"` after adding the boundary test — **passing**.
- `yarn test:store` NOT run — this change is pure planner re-plan-context construction with no
  storage interaction; the store path is not implicated (consistent with the implementer's note).

**Disposition.** All findings **minor**, fixed in this pass (a doc-comment precision nuance + one
regression test). **No major findings → no new tickets filed.** No security, resource-cleanup, or
error-handling concerns (the change is a pure-functional `Map` narrowing; error paths resolve to
real-table or table-not-found, never silently wrong).
