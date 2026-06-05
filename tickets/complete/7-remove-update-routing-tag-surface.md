description: Removal of the redundant view-update routing tags (quereus.update.target / exclude / delete_via / policy), now subsumed by per-row presence/membership columns and predicate/FK defaults. default_for is the sole retained quereus.update.* key. Reviewed and completed.
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/logic/53-reserved-tags.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md, docs/schema.md
----

## Summary

The four `quereus.update.*` **routing** keys — `target`, `exclude`, `delete_via`, and the `policy` knob — were removed, leaving **`default_for.<column>` as the sole retained `quereus.update.*` key**. The override surface is now one mechanism: predicates rule, per-row writable presence/membership columns state routing explicitly (outer-join existence column + set-op membership columns, both delivered by the `outer-join-existence-column` / `set-op-membership-write` prereqs), and `default_for` supplies missing insert values. Removed keys are hard `unknown-reserved-tag` errors at every site, validated through the single typed reserved-tag registry.

The implementation landed in `ticket(implement): remove-update-routing-tag-surface` (8e2dcb9e). See that commit and `docs/view-updateability.md § Tags: The Override Surface` for the timeless design.

## Review findings

Adversarial pass over commit 8e2dcb9e + the two review-pass fixes below. Build, lint, and the full quereus suite are green after the fixes.

### What was checked
- **Source removal completeness** — `git grep` across `packages/` (all workspaces) and `docs/` for every removed symbol (`readPolicy`/`readDeleteVia`/`readTargetNames`/`readExcludeNames`/`hasRoutingTags`/`applyTargetExclude`/`resolveDeleteViaSide`/`allSideIndices`/`DELETE_VIA_VALUES`/`UPDATE_POLICY_VALUES`/`DeleteViaValue`/`UpdatePolicyValue`/`policy-strict-ambiguity`/`tag-conflict`) and the four routing key strings. **No live consumer remains** anywhere — only removal-documenting prose and intentional negative tests. No external workspace/plugin referenced the removed types or readers.
- **Retained `tag-target-not-found`** — confirmed it is still legitimately emitted by `single-source.ts:resolveDefaultForColumn` for the retained `default_for` key (a `default_for.<col>` naming an unknown column), so keeping the diagnostic reason is correct, not dead code. Pinned by the `default_for.nope → "not a column"` case in 93.4.
- **Removed `TagSite` members** (`'join'`, `'union-branch'`) — verified no residual references in `src/` (the `'join'` grep hits are all AST from-clause join types, an unrelated namespace). `getReservedTag` / `getReservedTagByTemplate` remain exported and used by the lens paths.
- **`decomposeUpdate`/`decomposeDelete` simplification** — the dropped `allowedSides` guards were tag-conflict checks only; the existence-side write itself is governed by the prereq's existence column, so removing the guards does not weaken routing. The new `chooseDeleteSides` (preserved candidates → provable FK-child → else lenient fan-out, no tags) was read end-to-end and matches the rewritten doc.
- **Highest-risk edit — Family B property conversion** (inner-join `delete_via=parent` → LEFT-join `set hasP=false`). Hand-derived both the deterministic and the fuzz `expView`: the sole base mutation is removing the one matched parent (`pp = target.pr`); children are untouched (FK enforcement off, no cascade); so the LEFT-join image is `{hasP:true, pv:parent.pv}` for children whose parent survives and `{hasP:false, pv:null}` otherwise — exactly what `expView` computes. The shared-parent null-extend-all invariant is preserved. `routedSeen`/`sharedSeen` guards are satisfiable under the generator bounds (pr∈[1,3], ≤10 children ⇒ sharing common) and held in the review run.
- **Test conversions** (reserved-tags.spec.ts, schema-differ.spec.ts, 53-/93.4-sqllogic) — enum/csv coverage correctly repointed onto the surviving `lens.decomp.*` specs; `RESERVED_TAGS` count 20→16 asserted; removed keys → `unknown-reserved-tag` at `view-ddl`/`dml-stmt`/`physical-table`; the semantic change (a routing tag on a single-source view is now a hard error, not an inert no-op) is pinned in 93.4 `sst_v`.
- **Docs** — read every touched section of `view-updateability.md`, `sql.md`, `schema.md`; all reflect the single-override + presence-column reality and the diagnostic-catalog deletions. `lens.md` confirmed free of routing-tag references.
- **Build / lint / tests** — `yarn workspace @quereus/quereus build` clean; `lint` exit 0; `test` → **4740 passing, 9 pending**.

### Minor findings (fixed inline this pass)
1. **`decomposeDelete(ctx, …)` — `ctx` is now unused** (tags removed, `ctx` never referenced in the body). Per AGENTS.md ("Prefix unused arguments with `_`") renamed to `_ctx`. (`multi-source.ts:2008`)
2. **`buildNullExtendedInsert(ctx, …)` — pre-existing unused `ctx`** (already unused at the parent commit; surfaced by editing the file). Same category, renamed to `_ctx` to clear the TS 6133 hint and keep the file consistent. (`multi-source.ts:1541`)
3. **Broken intra-doc anchor** introduced by the commit: `view-updateability.md:159` linked `[Existence columns](#existence-columns)` but the heading anchor is `#existence-columns-on-outer-joins` (correctly used at line 45). Fixed the link.

### Major findings
None. The removal is complete and internally consistent; the routing outcomes that the removed tags expressed are all reachable via the documented replacements (predicate narrowing, FK-child default, outer-join existence column, set-op membership columns), each covered by tests here and in the two prereq tickets.

### Notes / accepted as-is (no action)
- **`TypedValueFor<K extends string> = K extends string ? string : string`** — a degenerate conditional kept as a mapped type so a future enum key can reintroduce a closed union without touching call sites. Harmless; no call site depends on the distinction. Left as documented.
- **Coverage parity, not addition** — per the ticket, existing routing coverage was *converted*, not extended; some Family B conversions overlap the prereqs' existence/membership coverage intentionally (to preserve the named shared-parent invariant).
