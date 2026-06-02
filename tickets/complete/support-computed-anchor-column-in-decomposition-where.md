description: A DELETE/UPDATE WHERE filtering on a computed (non-invertible) decomposition column whose mapping basis lives on the **anchor** (`bumped = a + 1`, `combined = a || b`) is now *supported* instead of being wrongly rejected as a "non-anchor decomposition member". Such a predicate substitutes entirely into anchor base terms (`bumped = 11` → `a + 1 = 11`), which the existing anchor key subquery already evaluates — no new substrate. Genuinely non-anchor members / EAV pivots / embedded subqueries still defer, each now with an accurate case-specific diagnostic under the unchanged `unsupported-decomposition-predicate` reason. Build + lint + full suite green.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped

The `assertAnchorScoped` gate (`decomposition.ts:875`, reached by both `decomposeDelete`
and `decomposeUpdate` via `anchorPredicate`) was rewritten from a single `nonAnchor`
boolean into a per-name walk:

- **Subquery first** (`refs.hasSubquery`) — defers with a subquery-specific message,
  regardless of which columns it names.
- **Anchor-resolvable → admitted**: `(route.kind === 'member' || route.kind ===
  'computed-mapping') && route.member.relationId === anchorId`. An identity base column on
  the anchor *or* a computed mapping whose basis lives on the anchor both substitute (via
  `substituteViewColumns`) into a predicate over the anchor's own base columns.
- **Otherwise → defer** via the new `nonAnchorPredicateDiagnostic` (`decomposition.ts:922`),
  which switches on `route.kind` for an accurate per-case message: `eav` (EAV pivot member),
  `unbacked` (no backing member), and the `default` genuine non-anchor member (which
  preserves the `non-anchor decomposition member` substring the deferral test pins). All
  keep `reason: 'unsupported-decomposition-predicate'` — the structured contract is unchanged.

The `unknown-view-column` encapsulation-leak guard runs first, unchanged. Doc comments and
both `docs/lens.md` / `docs/view-updateability.md` updated to "anchor-resolvable" wording
with the supported/deferred split spelled out.

## Review findings

Adversarial pass over commit `c55da976`. Read the source diff fresh before the handoff.

### Checked

- **Correctness — the anchor-resolvable admission.** The gate admits a `computed-mapping`
  whose `member` is the anchor on the *assumption* its basis only names anchor columns. This
  is **structurally guaranteed upstream**, not merely assumed (the handoff's gap #3):
  `resolveAdvertisement` validation (`schema/lens-compiler.ts:1591`) rejects any member
  whose `basisExpr` references a column absent from *that member's own* table
  (`table.columnIndexMap.has(refName)`). So a computed mapping on the anchor necessarily has
  a basis over anchor base columns → `substituteViewColumns` yields an anchor-scoped
  predicate. No gate-level assertion is needed; the invariant cannot be violated by a
  validly-deployed advertisement. **Sound.**
- **Correctness — union narrowing & type safety.** Both `member` and `computed-mapping`
  carry `member`; `eav` also carries `member` but is excluded from the admission OR and
  handled explicitly in the diagnostic switch. The switch `default` correctly covers only
  `member`/`computed-mapping` on a *non-anchor* member (eav/unbacked are explicit cases). No
  `any`; `MutationDiagnostic` import is clean. **Sound.**
- **Correctness — check ordering & multi-column WHERE.** Leak guard → subquery → per-name
  loop. A WHERE mixing an admissible and a non-resolvable column (`where a = 1 and b = 2`)
  throws on the first non-resolvable name (loop raises and exits) — correct deferral, atomic
  (build-time raise, no partial write). Verified by the existing `split()` deferral test and
  the new multi-member test.
- **Path coverage.** `anchorPredicate` is the single chokepoint for both DELETE
  (`decomposition.ts:605`) and UPDATE (`:678`); the gate runs once per statement before any
  base op. INSERT does not carry a user WHERE, so it is correctly unaffected.
- **Branch reachability.** `eav` and `subquery` WHERE branches are reachable and now tested
  (below). The `default` branch is covered by the pre-existing `delete filtered on a
  non-anchor member is deferred` test. The `unbacked` branch is **unreachable for a
  validly-deployed advertisement** — to reach it a name must pass the `shape.columns` leak
  guard yet classify `unbacked`, but every logical column in `shape.columns` is
  validator-required to be backed (member mapping / EAV / name-match), and a name-matched or
  identity column routes to `member` or `no-base-lineage`, never `unbacked`. Left as
  defensive depth (consistent with the sibling `no-base-lineage`/self-decomposition guards);
  not contrived a test, since constructing it requires an advertisement the resolver rejects
  at deploy.
- **Docs.** Read both touched docs end-to-end against the new code. `docs/lens.md` (the
  "anchor-resolvable" admission sentence + the Pending list splitting non-anchor / EAV /
  subquery) and `docs/view-updateability.md` (the `decomposition.ts` and `backward-body.ts`
  bullets) accurately reflect the shipped gate. No stale wording found.
- **Tests + lint + typecheck.** `tsc --noEmit` clean; `eslint` on the touched test file
  clean. Full `@quereus/quereus` suite **4421 passing, 9 pending, 0 failing**; focused
  `lens-put-fanout.spec.ts` **44 passing** (41 → 44 with the additions below). The
  property-planner "Rule '…' never fired" lines are pre-existing, unrelated.

### Found and fixed (minor, inline)

The handoff's gaps #1 and #2 were **untested branches / interactions**, not code defects.
Closed inline by adding three tests to `lens-put-fanout.spec.ts`:

- **EAV-served WHERE column defers with the EAV-pivot message** (`delete from x.E where p =
  11` → `/EAV pivot member/i`, in the EAV block). Confirms the `eav` branch is reachable and
  not misattributed as a non-anchor member.
- **Subquery WHERE defers with the subquery-specific message** (`delete from x.N where
  bumped = (select max(a) from main.N_core)` → `/embeds a subquery/i`, in the nonIdentity
  block). Confirms the subquery branch fires even when the predicate also names an otherwise
  anchor-resolvable column.
- **Multi-member computed-anchor DELETE fans out** (new `multiMemberComputedAnchorAd`
  fixture: anchor `M_core` with `bumped = a+1` plus a mandatory non-anchor member `M_b`;
  `delete from x.M where bumped = 11` deletes id=1 from **both** members). Closes gap #2 —
  the anchor-scoped substituted predicate (`a + 1 = 11`) drives each member's
  `select anchorKey from anchor where <pred>` identifying read, so the fan-out to other
  members is unaffected.

### Reviewed, no action (with reasons)

- **Basis-on-anchor invariant assertion (handoff gap #3).** Resolved above — guaranteed by
  the advertisement validator at deploy, so a redundant gate-level assertion would be pure
  belt-and-suspenders. No ticket. (If a future advertisement source could bypass
  `resolveAdvertisement` validation, the assertion question would reopen — but every
  deployment path runs that validation today.)
- **`unbacked` WHERE branch (handoff gap #1 tail).** Unreachable for valid advertisements,
  as reasoned above; kept as defensive depth. No ticket.
- **Store path not exercised (handoff gap #4).** The predicate substitution is AST
  construction consumed by the anchor subquery — path-agnostic, identical AST for the memory
  and store backends. `yarn test:store` is not agent-runnable per stage guidance; the
  store-specific code path is unchanged by this diff. No ticket; deferred to the standard
  store-suite cadence.
- **`nonAnchorPredicateDiagnostic` object repetition.** Three near-identical literals sharing
  `reason`/`column`/`table`. Readable and intentional (each message is the load-bearing
  difference); DRYing into a builder would obscure more than it saves. No change.

**Major findings: none.** No new tickets filed.
