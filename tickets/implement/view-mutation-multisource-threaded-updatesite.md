description: Phase B1 of the derived-backward-walk. Consume the FULL threaded `UpdateSite` (including `inverse` / `domain`) in the multi-source join path instead of the identity-only `identityBaseSite`, so an `inverse`-profile column (e.g. `cv + 1`) is writable through a two-table inner-join view body. The AST round-trip stays for now (retired in B2); this ticket only stops discarding the richer lineage. Acceptance gate: the View Round-Trip Law harness (Family B) stays green AND gains coverage for at least one `inverse`-profile column written through a join body.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md

## Context (Phase A has landed)

`planner/mutation/scope-transform.ts` now owns the one scope-aware substitution
primitive (`transformExpr` + `transformScopedExpr/Query` over a `ScopeContext`).
`multi-source.ts` already imports the structural walkers from it. This ticket is the
first slice of Phase B: **consume the threaded `updateLineage` richer than identity**.

## The debt this closes

`multi-source.ts` `analyzeJoinView` reads `root.physical.updateLineage` but routes each
output column through `identityBaseSite(site)`:

```ts
function identityBaseSite(site: UpdateSite | undefined): { table: number; baseColumn: string } | undefined {
	if (site && site.kind === 'base' && site.inverse === undefined) {   // <-- identity ONLY
		return { table: site.table, baseColumn: site.baseColumn };
	}
	return undefined;
}
```

So a column whose `UpdateSite` is `base` *with an `inverse`* (a non-identity invertible
transform such as `p.pv + 1` — `scalar-invertibility.ts` already classifies `x ± k` as
`{ kind: 'inverse', fn, domain? }` and `deriveProjectUpdateLineage` already composes it
onto the site) is treated as non-writable: `out.writable = false`, and a write to it
raises `no-inverse` even though the engine *can* invert it. The AST round-trip (lowering
`viewColToBaseRef`, the raw projection expr) is what forces identity-only — the AST
`BaseOp` can't carry the threaded inverse.

## Required behavior

Make the multi-source `update` path consume the full `UpdateSite`:

- In `analyzeJoinView`, replace `identityBaseSite` with a reader that keeps a `base`
  site's `inverse` / `domain` (an `OutColumn` for an `inverse` site is **writable**,
  carrying its `inverse` closure + optional `domain`). A `computed` / `null-extended`
  site stays non-writable (read-only). Routing to the owning side still uses
  `site.table` → `sideByTableId`.
- In `decomposeUpdate`, for an assignment to an `inverse`-profile column:
  - the base value becomes `inverse(substitutedValue)` — apply the site's `inverse`
    closure to the (base-term, side-qualifier-stripped) assigned value. The existing
    `substituteViewColumns` + `stripSideQualifier` produce the written value in base
    terms; wrap it with `site.inverse` before pushing onto `perSide`.
  - conjoin the site's `domain` (if present) into the identifying predicate
    (`buildIdentifyingPredicate`), matching § Scalar Invertibility ("substitutes the
    inverse and conjoins `domain` into the row-identifying predicate").
- `attributeDefaults`: an omitted-column insert default for an `inverse` site sets the
  **base** column to the default `value` directly (per the `AttributeDefault` NOTE in
  `plan-node.ts:263` — `value` lives in the base domain, no written view value to
  invert). Multi-source insert default handling is out of scope here unless trivially
  reachable; if so, honor that NOTE; otherwise leave a precise deferral.

Keep the identifying-subquery machinery, the both-sides identity capture, the RETURNING
re-query, and the FK ordering exactly as they are — this ticket changes only which sites
are writable and how an `inverse` assignment is lowered.

## Watch-outs

- The `inverse` closure maps a *written* value to the base value; it expects the value
  already in base terms. Apply it AFTER `substituteViewColumns` (which maps view-col refs
  to base terms) and the `stripSideQualifier` step, or confirm ordering against how the
  single-source path would compose it (single-source does not yet exercise `inverse`
  either — `classifyProjectionExpr` is identity-only — so there is no existing single-
  source precedent to mirror; reason from `composeUpdateSite` / `traceInvertibleColumn`).
- The both-sides identity capture and RETURNING re-query read `viewColToBaseRef` (the raw
  projection expr) for the *forward* projection — that stays correct (the forward image of
  an `inverse` column is the forward transform). Only the *backward* assignment inverts.
- A `domain` conjoined into the identifying predicate must survive the lowering into the
  `<pk> in (select ... where <idPredicate>)` subquery in base terms.

## Acceptance criteria

- `yarn workspace @quereus/quereus test` green, including View Round-Trip Laws.
- Family B (`describe('multi-source inner join')` in `test/property.spec.ts`) gains a
  view whose join body projects an `inverse`-profile column (e.g. `select c.cc as cc,
  c.cv + 1 as cv1, p.pv as pv from jchild c join jparent p on p.pp = c.pr`), with a
  PutGet assertion that `update v set cv1 = N` writes `jchild.cv = N - 1` and the view
  reads back `cv1 = N`. Static plan-lineage agreement: the column's site is `base` with
  an `inverse` and is reported writable.
- `update-lineage.ts` `viewColumnsFromUpdateLineage` / the `view_info` / `column_info`
  surfaces: decide whether an `inverse` site reports `is_updatable = 'YES'` and update
  the `column-info-*` / `view-info-*` goldens + docs accordingly (today `identityBaseColumn`
  reports only identity sites as writable — an `inverse` site newly-writable on the
  dynamic path should be reflected consistently on the static surface, or the divergence
  documented).
- `docs/view-updateability.md` § Inner Join / § Scalar Invertibility note that a
  multi-source `inverse`-profile column is now writable.

## TODO
- [ ] Replace `identityBaseSite` with a full-`UpdateSite` reader in `analyzeJoinView`; mark `inverse` sites writable.
- [ ] In `decomposeUpdate`, invert the assigned value via `site.inverse` and conjoin `site.domain` into the identifying predicate.
- [ ] Reconcile the static updateability surface (`viewColumnsFromUpdateLineage` / `view_info` / `column_info`) with the newly-writable inverse sites; update goldens.
- [ ] Add the Family-B `inverse`-profile join-write law assertion (PutGet + lineage agreement).
- [ ] Update `docs/view-updateability.md`; run full test + lint.
