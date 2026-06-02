description: Review of Phase B1 — the multi-source (two-table inner-join) view-mutation UPDATE path now consumes the FULL threaded `UpdateSite` (including `inverse` / `domain`) instead of the identity-only `identityBaseSite`, so an `inverse`-profile column (e.g. `c.cv + 1`) is writable through a join body. The AST round-trip stays (B2 retires it). Treat the work below as a starting point — the tests are a floor, not a ceiling.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md

## What changed (the diff to review)

**`planner/mutation/multi-source.ts` — the core change**
- `identityBaseSite` (which required `inverse === undefined`) was **replaced** by
  `writableBaseSite`, which returns the base reference for *any* `base` site,
  carrying its `inverse` closure + optional `domain`. A `computed` /
  `null-extended` site stays read-only. Routing to the owning side still uses
  `site.table` → `sideByTableId`.
- `OutColumn` gained `inverse?` / `domain?` fields; `analyzeJoinView` populates them.
- `decomposeUpdate`: for an assignment to an `inverse`-profile column, the base
  value is now `out.inverse(substituted+stripped value)` — i.e. the assigned
  (view-domain) value is rewritten to base terms, side-qualifier-stripped, **then**
  wrapped with the inverse closure last. Verify this ordering against
  `composeUpdateSite` / `traceInvertibleColumn` (the inverse expects a value
  already in base terms — that is the documented contract).
- `decomposeUpdate`: any `site.domain` is conjoined into the single-side
  identifying predicate via a new `qualifyDomainToSide` helper (qualifies bare
  base-column refs to the owning side's alias).
- `analyzeMultiSourceInsert`: an `inverse` column is **kept non-insertable** (raises
  `no-inverse`; excluded from the implicit no-column-list target set). This
  preserves pre-change insert behavior exactly — the shared-surrogate envelope
  writes supplied values verbatim, with no hook to apply the inverse.

**`planner/analysis/update-lineage.ts`** — doc-only: `identityBaseColumn`'s comment now
explains it stays identity-only **by design** (it is the single-source AST-parity
reader; widening it would break the `viewColumnsFromUpdateLineage ⇄ deriveViewColumns`
parity test). No behavior change.

**Static surfaces** — *no code change needed*: `func/builtins/schema.ts`'s `baseSiteOf`
already resolves any `base` site (inverse included) as writable, so `view_info` /
`column_info` already reported inverse join columns `is_updatable = 'YES'`. The
fix makes the *dynamic* UPDATE path agree with that pre-existing static truth.

## Use cases / behavior to validate

The acceptance shape (now green in `property.spec.ts` § View Round-Trip Laws → `multi-source inner join`):

```sql
create view jv2 as
  select c.cc as cc, c.cv + 1 as cv1, p.pv as pv
  from jchild c join jparent p on p.pp = c.pr;

update jv2 set cv1 = N where cc = K;   -- stores jchild.cv = N - 1
select cv1 from jv2 where cc = K;       -- reads back N (forward image cv + 1)
```

- **PutGet (new, `numRuns: 50`)**: writing `cv1 = N` stores the *inverted* base value
  `jchild.cv = N - 1`; the parent is untouched; the view reads `cv1 = N`. Unjoined
  children are never perturbed (the join-escape guard).
- **Static plan-lineage agreement (new)**: `cv1`'s `UpdateSite` is `base` (jchild.cv)
  **with** an `inverse`; `assertPlanLineageAgreement` confirms every output column is
  base-writable and the forward key reconstructs.
- **Goldens (`06.3.5-column-info`, `06.3.4-view-info`)**: a join view with `nv1 = c.nv + 1`
  reports `is_updatable = 'YES'` tracing to `iv_child.nv`; a real `update iv_jv set nv1 = 9`
  stores `nv = 8` and reads back `nv1 = 9` (static ⇄ dynamic agreement, cross-checked).

Worth poking adversarially:
- **Both-sides + inverse**: `update jv2 set cv1 = N, pv = M where cc = K` (one inverse
  side + one identity side) — routes through the eager `__vmupd_keys` capture. The
  inverse is applied per-side in `perSide` (independent of single/both-sides), so it
  *should* be correct, but this exact combo is **not** covered by a dedicated law —
  the new test only assigns the inverse column alone. **Add a both-sides+inverse
  PutGet** if you want this locked.
- **Inverse value referencing another view column**: `update jv2 set cv1 = pv + 1` —
  `pv` is on the *other* side, so `stripSideQualifier` should reject it
  (`cross-source-assignment`) *before* the inverse wraps it. Confirm the rejection
  fires (the inverse wrap is after the strip, so a cross-source ref never reaches it).
- **Chained inverse** (`(cv + 1) + 2`): the registry composes `w ↦ (w - 2) - 1`
  (outer undone first). The invertibility-registry unit test covers the *closure*;
  no multi-source *write* exercises a chain — consider one.
- **RETURNING through an inverse join column**: the forward re-query uses
  `viewColToBaseRef` (the raw projection `cv + 1`), so `returning cv1` should surface
  the forward image. Not separately asserted here — spot-check.

## Known gaps / honest deferrals (do not treat as done)

- **`domain` conjoin is unreachable today.** No shipped invertibility profile
  attaches a `domain` (`x ± k` is unrestricted), so `qualifyDomainToSide` and the
  `assignmentDomains` plumbing are **wired but never executed by any test**. When the
  first domain-bearing profile lands (e.g. reciprocal `k / x` with `x <> 0`): (a)
  verify `qualifyDomainToSide`'s alias qualification binds correctly against the
  two-source join FROM, and (b) the **both-sides captured-key path does NOT thread
  per-assignment domains** (the capture in `buildMultiSourceKeyCapture` is built from
  the user WHERE only) — that interaction is explicitly deferred.
- **Multi-source insert of an inverse column is rejected**, not supported (the envelope
  writes raw values). `attributeDefaults`' inverse-insert NOTE (plan-node.ts:263) is
  therefore **not exercised on the multi-source path** — `analyzeMultiSourceInsert`
  does not consume `attributeDefaults` at all (it uses base-table defaults at the base
  insert level). Single-source insert-default inverse handling is out of scope.
- **Single-source inverse columns stay read-only on a write** (the single-source spine
  still classifies projections at the AST level via identity-only
  `classifyProjectionExpr`). This is intentional and out of B1's scope; the static
  surface (`baseSiteOf`) reports such a single-source column writable, so a
  **static/dynamic divergence already exists for single-source inverse columns** and
  is pre-existing (not introduced here). Untested by goldens. Flag if you want it
  tracked as a separate fix ticket.
- **AST round-trip not yet retired** (B2). This ticket only stops discarding the
  richer lineage; the lowering-to-AST machinery is unchanged.

## Validation run (all green)

- `node mocha property.spec.ts --grep "multi-source inner join"` → 9 passing (incl. new test).
- `node mocha logic.spec.ts --grep "column-info|view-info"` → 2 passing.
- `yarn workspace @quereus/quereus test` → **4348 passing, 9 pending**.
- `yarn workspace @quereus/quereus build` → exit 0 (tsc clean).
- `yarn workspace @quereus/quereus lint` → exit 0.
- (Did not run `test:store` — no store-specific code touched.)
