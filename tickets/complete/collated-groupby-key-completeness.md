description: Final-aggregate-projection builder references the aggregate's group output column for whole-expression group-key matches (collated / arithmetic / cast / any computed GROUP BY key), so the unique group-key FD survives the SELECT projection and keysOf(root) recovers the key — published under exactly the grouping collation. Reviewed and accepted; one minor test added.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts          # THE FIX: buildFinalAggregateProjections + buildGroupKeyColumnRef helper
  - packages/quereus/test/planner/groupby-key-completeness.spec.ts       # regression net (now 12 cases; review added the cast case)
  - packages/quereus/test/coarsened-backing-key.spec.ts                  # bag2 flipped reject → real-key; bag1 rejection kept
  - packages/quereus/test/materialized-view-diagnostics.spec.ts          # computed GROUP BY key moved rejectCases → acceptCases
  - packages/quereus/test/logic/51.5-materialized-views-coarsened-key.sqllogic  # grp_bag flipped reject → registers
  - docs/optimizer.md                                                    # FD-tracking note on AggregateNode row
----

# Collated / computed GROUP BY claims its group key — COMPLETE

## Summary of the landed work

`buildFinalAggregateProjections` (`select-aggregates.ts`) fingerprints each GROUP
BY expression (`expressionToString` → group-output index). A SELECT-list item that
is **non-bare** (`column.expr.type !== 'column'`) whose **whole** expression
fingerprint-matches a GROUP BY expression is emitted as a bare
`ColumnReferenceNode` to the aggregate's own group output column
(`aggregateAttributes[gbIdx]` — its `id`, `type`, column index `gbIdx`) via the new
`buildGroupKeyColumnRef` helper, instead of structurally recomputing the
expression over the representative source row. Because the emitted node references
the aggregate's own key column, `deriveProjectionColumnMap` maps it by attribute
id, `projectFds` carries the `unique` group-key FD, and `keysOf` / `isSet` recover
automatically — no change to `key-utils.ts`, `fd-utils.ts`, `project-node.ts`, or
`aggregate-node.ts`. The synthesized AST name is `expressionToString(column.expr)`
so an unaliased output column keeps its prior name.

Bare columns deliberately stay on the recompute path (they already resolve against
the aggregate group symbol registered under the column name, so their key already
survives; synthesizing a name would mangle a table-qualified bare column).

## Review findings

### What was checked

- **Implement diff, fresh eyes** — `select-aggregates.ts` fix + helper, before reading the handoff.
- **`ColumnReferenceNode` constructor arg order** (`reference.ts`) — confirmed `(scope, expr, columnType, attributeId, columnIndex)`. The helper passes `columnType = groupAttr.type`, `attributeId = groupAttr.id`, `columnIndex = gbIdx`. `gbIdx` is the correct runtime row position (group columns occupy indices `0..G-1`; aggregates start at `groupByExpressions.length`, per line 601). `attributeId = groupAttr.id` is present in the aggregate output, so `deriveProjectionColumnMap` pass-1 maps `srcIndex = gbIdx → outIndex`.
- **FD-key recovery path** — traced `deriveProjectionColumnMap` → `projectFds` / `superkeyToFd` → `keysOf`. Sound; the "no change to key-utils" claim holds.
- **Scope restriction (non-bare only)** — confirmed bare columns keep their key via recompute, and that the direct-reference branch's `alias` handling (`column.alias`) is equivalent to the recompute branch's `column.alias || (bare ? name : undefined)` for non-bare exprs (the fallback never applies to non-bare). Output naming verified equivalent (test: unaliased → `"b collate nocase"`).
- **Fingerprint soundness** — whole-expression `expressionToString` equality, the same mechanism `validateAggregateProjections`/HAVING already rely on. Sub-expression matches (`(a+1)+2` vs `a+1`) correctly fall through to recompute. Cannot mis-map an unrelated expression onto a group column.
- **`generated` flag flip** (the matched output column changes `generated: true → false` because the node is now a `ColumnReferenceNode`) — audited every read of the flag. `RelationType.column.generated` is **not** consumed on the DML or MV-backing paths (`deriveBackingShape` hardcodes `generated: false`); all behavioral reads are of `ColumnSchema.generated` (table schema), a distinct field. Cosmetic/explain only — no behavior change.
- **Reused output attribute id** — the matched column reuses the aggregate's group attr id, identical to the normal bare-column passthrough (`project-node.ts` preserves the source attr id for any `ColumnReferenceNode` projection). Standard behavior, not a new hazard.
- **Three test flips** — verified each is semantically sound (the group columns genuinely uniquely key the aggregate output, one row per distinct group; the collated case registers a **real** key, not a coarsened one, and dedups `'a'`/`'A'` under the NOCASE backing PK → `n=2`).
- **Docs** — `optimizer.md` AggregateNode row updated correctly. Confirmed the `materialized-views.md` / `optimizer.md` **read-side aggregate-rollup rewrite** docs ("computed group key ⇒ forgo") remain accurate: that matcher is an independent conservative mechanism unaffected by FD-key derivation. Newly-registerable collated/computed-group MVs simply won't be chosen as rewrite candidates — a sound miss, no doc change needed.
- **Full suite + lint** — `yarn workspace @quereus/quereus test` → **5937 passing, 9 pending, 0 failing**; `lint` → clean (exit 0).

### What was found / done

- **No major findings.** No new tickets filed.
- **Minor (fixed in this pass):** added a **CAST group-key** case to `groupby-key-completeness.spec.ts` (now 12 cases) — the one adversarial shape the implementer explicitly flagged ("a CAST or function group key") but did not cover. Verified `cast(a as text)` group key claims `keysOf = [[0]]` and reads the cast value **once** (`'5','6','7'`, not double-applied). A `function` group key (`abs(a)`) was spot-checked manually and behaves identically (same non-`'column'` expression path; no separate test added to avoid redundancy).
- **Documented-and-accepted gaps (correctly out of scope, no action):**
  - *Duplicate projection of the same group expr* (`select b collate nocase as g1, b collate nocase as g2, …`) does not recover a single-column key — both projections share the aggregate attr id and `deriveProjectionColumnMap` is first-occurrence-wins. This is the **same** pre-existing behavior as `select id, id`; runtime is correct (test asserts no-crash + `g1 == g2`). A fix would be a `deriveProjectionColumnMap`-level change affecting all duplicate-column projections — out of scope here.
  - *ORDER BY / HAVING rebuild paths* unchanged; the HAVING test confirms the key survives **through** a HAVING filter (those paths don't affect `keysOf(root)`).
  - *Soundness anchor* — `CollateNode.isInjectiveIn` stays conservatively `false`; the collation-soundness pins remain green (not weakened).

### Deferred (documented, not run)

- **`yarn test:store`** (LevelDB store path) was not run. The change is purely planner-side FD key-derivation (vtab-agnostic); the flipped MV-registration tests are memory-backed, and `test:store` is the slow store-only suite (per AGENTS.md, reserved for store-specific diagnosis). No store-specific code path is touched, so a store run is not a meaningful spot-check here.

## Disposition

Accepted. Implementation is sound, scoped honestly, and the handoff's self-flagged
caveats were each verified rather than taken on faith. The one optimistic claim in
the implement ticket (duplicate-projection key recovery) was already corrected by
the implementer to match real behavior; review confirmed that correction.
