description: Review the single-source view-mutation widening that lets an inverse-profile column (`b + 1 as bp`) be writable on `update`, consuming the threaded plan-node `inverse` so the dynamic single-source spine matches the static `column_info`/`view_info` `is_updatable = 'YES'` and the multi-source join path. `update v set bp = 9` now stores `t.b = 8`; an `opaque` column stays `no-inverse`; INSERT stays inverse-blind.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic, docs/view-updateability.md

## What landed

The single-source view-mutation spine now consumes the threaded `inverse` on the
**UPDATE write path**, closing the static↔dynamic divergence the ticket described.
Previously the static surfaces (`column_info`/`view_info` via `baseSiteOf`) reported a
single-source inverse column (`b + 1 as bp`) `is_updatable = 'YES'`, but
`update v set bp = …` was rejected `no-inverse` because the dynamic spine classified
projections AST-only (`classifyProjectionExpr`, identity-only). The multi-source join
path already consumed the inverse; the single-source spine was the lone holdout.

### Design as built (matches the ticket's "separate full-lineage reader" approach)

- `single-source.ts`:
  - New `InverseSite` shape (`baseColumn`, `inverse: (written) => Expression`, optional
    `domain`) and a new `ViewAnalysis.inverseSites: ReadonlyMap<string, InverseSite>`
    keyed by **lowercased view-column name**.
  - `analyzeView` builds `inverseSites` from the already-planned `bodyPlan`: it reads
    `bodyPlan.physical.updateLineage`, and for each view column reuses the shared
    `resolveBaseSite` (imported from `analysis/update-lineage.ts`). A column is recorded
    only when `site.writable && !site.nullExtended && site.inverse && site.baseColumn`.
    Index alignment `viewColumns[i] ↔ attrs[i]` holds (same `select *` expansion the
    `viewColumnsFromUpdateLineage ⇄ deriveViewColumns` parity relies on).
  - `rewriteViewUpdate` intercepts an inverse-column assignment **before**
    `requireBaseColumn`: it base-term-lowers the RHS (`substitute` + `descend`), then
    wraps it with `inv.inverse(loweredValue)` and targets `inv.baseColumn`. Non-inverse
    columns fall through to `requireBaseColumn` unchanged. The `findViewColumn` /
    `guardTopLevelScope` guards are preserved (a single `findViewColumn` call now).
  - The inverse wraps **after** base-term substitution (it expects a value already in
    base terms) — identical to `multi-source.ts` `decomposeUpdate` (`out.inverse(baseValue)`).
- **Decision on the shared-reader refactor** (ticket left this open): I used the
  **inline read** in `analyzeView`, reusing the shared `resolveBaseSite` primitive rather
  than factoring out a new helper alongside `backward-body.ts`'s `analyzeBodyLineage`.
  Rationale: `resolveBaseSite` already *is* the DRY primitive both spines share; a
  further wrapper would be more churn than value for a ~12-line read. Reviewer may
  reconsider if a third consumer appears.
- The identity-only readers (`deriveViewColumns` / `classifyProjectionExpr` /
  `identityBaseColumn` / `viewColumnsFromUpdateLineage`) were **NOT** widened — their
  parity is the contract pinned by `property.spec.ts`. INSERT routing still uses the
  identity-only `viewColumns`, so an inverse column stays `computed` there.

### Behavior

- `update v set bp = 9` → `set b = 9 - 1` (stores `t.b = 8`); reads back `bp = 9`.
- `update v set bp = id + 100` → `set b = (id + 100) - 1` (inverse applied after the
  view→base substitution of the RHS).
- `opaque` column (`b * 2`, `substr(s,1,1)`, string fns) → no `inverse` site → still
  `no-inverse`. The widening is inverse-gated, not a blanket allow.
- **INSERT explicitly unchanged**: an explicit `insert (bp)` or the implicit target set
  still raises `no-inverse` (the inverse column is non-insertable on both spines — the
  envelope has no inverse hook). `is_updatable = 'YES'` is an UPDATE claim.
- **DELETE / RETURNING unchanged**: an inverse column in a `where`/RETURNING resolves
  via `columnMap` to its forward base term (read context). No value lowering.
- **Materialized-view write-through inherits this** automatically (MV write-through is
  the single-source spine): an MV `x + 1 as y` column is now writable and stores the
  inverted base value; maintenance re-derives the computed columns.

## Use cases to validate (acceptance)

```sql
create table t (id integer primary key, b integer null);
create view v as select id, b + 1 as bp from t;
select column_name, is_updatable, base_column from column_info('v');  -- bp -> YES, base_column = b
insert into t values (1, 9);
update v set bp = 9 where id = 1;   -- stores t.b = 8
select b from t where id = 1;       -- 8
select bp from v where id = 1;      -- 9
```

- `opaque` sibling stays read-only: `create view o as select id, b*2 as bo from t; update o set bo = 4;` → `no-inverse` / read-only.
- INSERT of the inverse column rejects: `insert into v (id, bp) values (2, 5);` → `non-invertible`.
- MV parity: `create materialized view mv as select id, x, x+1 as y from e; update mv set y = 99;` → base `x = 98`, MV re-derives.

## Tests added/changed (all green; `yarn workspace @quereus/quereus test` → 4410 passing, 0 failing; build + lint clean)

- `property.spec.ts`:
  - NEW standalone `PutGet + lineage: an inverse-profile column (b + 1) is writable
    through the single-source view` (mirrors the multi-source B1 test): asserts the
    static plan-lineage (`base` t.b + inverse, writable), asserts `deriveViewColumns`
    still reports `bp` `computed` (parity proof), then fuzzes PutGet (writes `bp = NV`,
    asserts `t.b = NV - 1` and view reads back `bp = NV`).
  - CHANGED `computed view columns are read-only …`: the read-only assertion now uses an
    **opaque** column `b * 2 as bp` (was `b + 1`, which is now writable). The `no-inverse`
    rejection assertion is preserved against a genuinely non-invertible column.
  - The identity-only parity test (`viewColumnsFromUpdateLineage agrees with
    deriveViewColumns …`) is **unchanged and green** — proof the identity-only readers
    were not widened.
- `93.4-view-mutation.sqllogic`: NEW single-source inverse section — reproduction
  (`bp = 9` → `b = 8`; `bp = id + 100` → `b = 101`), opaque-stays-read-only
  (`substr(s,1,1) as s1`), and inverse-column INSERT rejection.
- `06.3.5-column-info.sqllogic`: NEW single-source inverse block with
  static↔dynamic agreement (static `YES`/`base_column = b` + a real write storing the
  inverted value; opaque sibling `NO`).
- `53.1-materialized-view-write-through.sqllogic` §7: rewritten — the MV `x + 1 as y`
  column is now writable (stores inverted base, computed columns re-derive); added an
  opaque `x * 2 as z` to retain the read-only assertion.
- Docs: `view-updateability.md` § Scalar Invertibility ("Where inverse profiles are
  consumed") now states **both** spines consume the inverse and explains the INSERT
  inverse-blindness + the identity-only-parity-reader rationale; `update-lineage.ts`
  `identityBaseColumn` doc-comment updated accordingly.

## Honest gaps / things for the reviewer to probe

- **Conflicting base-column assignments through an inverse column.** A view can project
  both a base column and its inverse (`select id, b, b + 1 as bp from t`). With `bp` now
  writable, `update v set b = 5, bp = 10` lowers to **two assignments to base `b`**
  (`set b = 5, b = 9`). This is a *pre-existing* class (already reachable via duplicate
  identity/rename projections, e.g. `select b, b as b2`), but the inverse widens the
  surface that can hit it. I did **not** add a duplicate-base-column guard — out of
  scope and not introduced by this change — but it is worth a reviewer decision on
  whether to detect/reject. No test covers this corner yet.
- **Index-alignment robustness.** `inverseSites` relies on `viewColumns[i] ↔ attrs[i]`.
  If they ever diverged, `attrs[i]` is `undefined` → `resolveBaseSite(undefined)` → no
  inverse site → safe fallback to identity/`no-inverse` routing (no crash). The
  alignment is pinned by the parity test for the accepted shapes; a reviewer may want an
  explicit arity assertion (the multi-source `analyzeBodyLineage` has one).
- **Domain deferral.** `InverseSite.domain` is threaded but **not** conjoined into the
  identifying predicate — mirroring the documented multi-source deferral. No shipped
  invertibility profile produces a domain (`x ± k` is unrestricted over integers), so
  this is dormant. If a domain-bearing profile lands, both spines need the conjunction
  wired (and tests).
- **Only the registry's profiles are exercised** (`x ± k`, `k ± x`, no-op cast, collate).
  Chained inverses (`(b + 1) + 2`) compose via `traceInvertibleColumn`/`composeUpdateSite`
  and are unit-covered statically (`invertibility registry composes inverses …`) but the
  single-source *dynamic write* fuzz only exercises `b + 1`. A reviewer could add a
  chained-inverse single-source write case for completeness (multi-source doesn't cover
  it dynamically either).
- **MV maintenance interaction** with an inverse-routed update is covered only by the
  one rewritten 53.1 §7 case (single-row, then passthrough/insert follow-ups). Broader
  MV-inverse fuzzing was not added.
