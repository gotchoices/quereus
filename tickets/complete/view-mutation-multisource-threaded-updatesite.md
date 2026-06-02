description: Phase B1 — the multi-source (two-table inner-join) view-mutation UPDATE path now consumes the FULL threaded `UpdateSite` (including `inverse` / `domain`) instead of the identity-only `identityBaseSite`, so an `inverse`-profile column (e.g. `c.cv + 1`) is writable through a join body. Reviewed, validated, and extended with adversarial coverage. Build + lint + full quereus suite green.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/06.3.4-view-info.sqllogic, docs/view-updateability.md

## What shipped

`writableBaseSite` replaced `identityBaseSite` in `multi-source.ts`: a `base`
`UpdateSite` is writable on update regardless of whether it carries an `inverse`
(a `computed` / `null-extended` site stays read-only). `OutColumn` gained
`inverse?` / `domain?`. On UPDATE, an assignment to an inverse-profile column has
its assigned (view-domain) value rewritten to base terms, side-qualifier-stripped,
then wrapped with the site's inverse closure last (`cv1 = N` ⇒ stores `cv = N - 1`).
Any `site.domain` is conjoined into the single-side identifying predicate via the
new `qualifyDomainToSide` helper. Multi-source INSERT of an inverse column stays
rejected (`no-inverse`). The AST round-trip is retained (B2 retires it). The static
`view_info` / `column_info` surfaces already reported these columns updatable
(`baseSiteOf`), so the fix makes the dynamic path agree with the pre-existing
static truth.

## Review findings

**Read the implement diff (`e11e3974`) first, then the codebase.** Scrutinized the
inverse contract end-to-end, the both-sides capture path, the cross-source guard,
RETURNING, the domain plumbing, the static/dynamic agreement, and the insert
rejection. Findings by category:

### Correctness — inverse ordering & contract: PASS
- Verified the substitute → strip → **inverse-wrap-last** ordering against
  `traceInvertibleColumn` / `composeUpdateSite` in `scalar-invertibility.ts` /
  `update-lineage.ts`. The `±k` inverse closure builds `<w> op k` and is
  value-agnostic about whether `w` is a literal or a base-column expression, so
  wrapping the already-base-term value last is correct. Confirmed against the
  self-referential case `set cv1 = cv1 + 10` (substitutes to `(cv+1)+10`, inverts
  to `((cv+1)+10)-1 = cv+10` — the correct stored delta).
- The inverse closure captures the literal `k` AST node from the throwaway view-body
  plan; literals are immutable values, so reuse in the lowered base op is safe.

### Edge cases & interactions — fixed inline (test gaps the implementer flagged)
The implementer's acceptance PutGet assigns the inverse column *alone* on the
single-side path. Three flagged-but-uncovered interactions are now locked by a new
`property.spec.ts` test (`inverse column: both-sides capture path, cross-source
reject, and forward-image RETURNING`) — all verified green:
- **Both-sides + inverse** (`set cv1 = N, pv = M`): routes through the eager
  `__vmupd_keys` capture; the inverse is applied per-side independent of the capture
  path. Verified the child stores `N - 1`, the parent stores `M`, and an untouched
  joined row is unperturbed. (This was the highest-value gap — minor, fixed inline.)
- **Cross-source ref through an inverse value** (`set cv1 = pv + 1`): the
  side-qualifier strip rejects `cross-source-assignment` before the inverse wraps,
  so a cross-source ref never reaches the closure. Verified the rejection fires.
- **RETURNING through an inverse column**: the forward re-query uses the raw
  projection (`cv + 1`), so `returning cv1` surfaces the forward image (`15`) while
  the base stores the inverted value (`14`). Verified both.

### Documentation: PASS
Read every touched doc against the new reality. `docs/view-updateability.md`
(§ Inner Join, § Scalar Invertibility) accurately describes the widened path, the
domain-conjoin-but-unreachable state, the insert rejection, and — importantly — the
single-source divergence below. The `identityBaseColumn` / `writableBaseSite`
doc-comments are accurate and explain the deliberate identity-only single-source
reader. No doc drift found.

### Major finding — filed as a new ticket (out of B1 scope, pre-existing)
- **Single-source inverse-column static/dynamic divergence.** A *single-source* view
  `select b + 1 as bp from t` reports `is_updatable = 'YES'` via `column_info` /
  `view_info` (their `baseSiteOf` resolves any base site), but a real
  `update v set bp = ...` is rejected `no-inverse` (the single-source spine still
  uses the identity-only `classifyProjectionExpr`). Confirmed by code reading; the
  static surface (`schema.ts`) and single-source spine were untouched by this
  ticket, so the divergence is **pre-existing**, not introduced here. It is
  documented (docs § Scalar Invertibility) but untested by goldens, and the fix
  direction (widen dynamic vs. narrow static) is a design question. Filed:
  `backlog/single-source-inverse-column-static-dynamic-divergence.md`.

### Honest deferrals confirmed (no action — correctly out of scope)
- **`domain` conjoin is wired but unreachable** — no shipped invertibility profile
  produces a domain (`x ± k` is unrestricted), so `qualifyDomainToSide` and the
  `assignmentDomains` plumbing execute on no test. The both-sides captured-key path
  does NOT thread per-assignment domains (the capture is built from the user WHERE
  only). Both are explicitly deferred until the first domain-bearing profile lands;
  the deferral is documented in code and docs. Left as-is.
- **Chained inverse** (`(cv + 1) + 2`): the registry's closure composition is unit-
  tested; no multi-source *write* exercises a chain. Not added — the self-referential
  case above plus the registry unit test cover the composition mechanics; a chained
  multi-source write would be incremental confidence only.
- **AST round-trip not yet retired** (B2) — unchanged, as intended.

### Validation (all green)
- `node test-runner.mjs --grep "multi-source inner join"` → **10 passing** (the prior
  9 + the new adversarial test).
- `yarn workspace @quereus/quereus build` → exit 0 (tsc clean).
- `yarn workspace @quereus/quereus lint` → exit 0.
- `yarn workspace @quereus/quereus test` → **4349 passing, 9 pending** (was 4348 +
  the 1 new test; no regression).
- `test:store` not run — no store-specific code touched (consistent with the
  implementer's deferral).
