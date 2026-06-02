description: Extended the View Round-Trip Law property harness (`test/property.spec.ts`) from single-source Tier A to Family B (multi-source key-preserving inner join) and Family C (n-way decomposition fan-out, advertisement-driven via `quereus.lens.decomp.*` tags). This is the acceptance gate the `view-mutation-derived-backward-walk` migration is checked against.
files: packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/vtab/mapping-advertisement.ts
----

## What shipped

The `describe('View Round-Trip Laws')` block of `test/property.spec.ts` now asserts the
three backward-direction laws (PutGet / GetPut / forward-backward lineage agreement) across
three families, each reusing the Tier A pure law cores (`assertRowsEqual`,
`assertPlanLineageAgreement`) plus a per-family negative self-test, with a shared
`expectMutationReject(sql, reason)` pinning the structured `mutationDiagnostic.reason`.

- **Family B — multi-source inner join**: existing PutGet extended with `update-both`;
  new tests for directly-supplied shared-key insert, `delete_via=parent` routing,
  reject-don't-widen + static plan-lineage agreement, and a negative self-test.
- **Family C — decomposition fan-out** (new): columnar (+optional member), EAV pivot, and
  surrogate PutGet; columnar GetPut; structural lineage agreement; reject-don't-widen for
  the deferred shapes; negative self-test. Fixtures built purely from `quereus.lens.decomp.*`
  tags via `buildAdvertisementsFromTags`.

Docs updated: `docs/view-updateability.md` "Landed" block and `docs/lens.md` write-path
pointer. Full detail is in the implement commit `ec4a4b4c`.

## Review findings

**Verdict: accepted.** The harness is sound, the families do real work, all reject codes
match the engine, docs are accurate, and — critically — the laws were verified to red on a
real engine-side put-path fault, not just on oracle mismatches. One minor robustness fix
applied inline; residual coverage gaps filed as a backlog ticket.

### Checked — and what was found

- **End-to-end fault detection (the implementer's #1 flagged gap): RESOLVED POSITIVELY.**
  The handoff worried the negative self-tests prove only the *comparison core* reds, never
  that a real backward-walk bug is caught. I injected a deliberate fault into the
  decomposition put path (`routeAssignment` in `decomposition.ts` returning a constant
  `999999` instead of the rewritten assigned value) and ran the Family C columnar PutGet:
  it red immediately — `round-trip violation on T_b: base/image diff, expected 21, actual
  999999`, shrunk to the `update-b` counterexample. Fault reverted; full suite green again.
  The laws genuinely catch real put-path bugs end-to-end.

- **Reject reason codes: all verified against engine source.** `unsupported-join`,
  `cross-source-assignment` (multi-source.ts); `unsupported-decomposition-predicate`,
  `unsupported-decomposition-update`, `unsupported-decomposition-key`, `no-default`,
  `no-inverse` (decomposition.ts). Confirmed the subtle one: a `uuid7` surrogate hits the
  `generator.strategy !== 'integer-auto'` → `no-default` branch (decomposition.ts:315)
  *before* `requireIntegerSurrogate`, so the test's expected `no-default` and its comment
  are correct even though the anchor key is declared `integer`.

- **Vacuous-assertion audit: one found, fixed inline (minor).** The Family B static
  lineage test read `attrs = node.getAttributes?.() ?? []` and then asserted
  `attrs.every(...)` plus a totality loop — both no-ops on an empty list, so the test
  could pass vacuously if the join ever stopped exposing attributes (the single-source
  equivalent at :2504 guards this with a `length === 3` check; this one did not). Added
  `expect(attrs.length).to.equal(3)` before the lineage assertions. Family C's lineage
  agreement already guards with `keys.length > 0`; no other vacuity found.

- **Oracle correctness spot-checks: clean.** Both-sides Family B update correctly reflects
  a shared parent across multiple children via post-state `pvAfter`; surrogate mint
  `max(anchor)+1` matches the engine on the empty-seed edge; EAV insert with all-null
  values correctly materializes only the anchor row (exercising the optional-member
  no-row path); columnar insert routes the optional `c` through its presence gate.

- **Type laziness (`any`): not a finding.** Family C uses `any` (`advertisementOf`, the
  member/column loop casts). The file carries a blanket
  `/* eslint-disable @typescript-eslint/no-explicit-any */` (line 2) and uses `any`
  pervasively (e.g. line 40), so the usage is consistent with the file's established
  convention and is not a lint violation. Retyping against the exported
  `MappingAdvertisement`/`DecompositionMember` types would be inconsistent churn; left as-is.

- **Docs: accurate.** Read the full `view-updateability.md` "Landed" block and `lens.md`
  write-path addition against the shipped tests — per-family descriptions, reason codes,
  and the `checkedNodes`-style guard claims all match the code. No stale references.

- **Lint + tests: pass.** `eslint test/property.spec.ts` clean; full `node test-runner.mjs`
  → 4273 passing, 9 pending, exit 0 (matches the implement baseline; the inline guard adds
  an assertion to an existing test, not a new test). No pre-existing failures surfaced.

### Major findings → new ticket

None are correctness defects in shipped code. The implementer honestly flagged a set of
residual *dynamic-coverage* gaps (oracle models the shape, seeding never generates it):
Family C never exercises the mandatory-member-missing/anchor-non-key-predicate paths;
surrogate minting through the decomposition is single-row only; structural lineage
agreement runs only over the columnar advertisement; `delete_via` and directly-supplied
insert are single deterministic scenarios. These weaken the acceptance gate for the
downstream `view-mutation-derived-backward-walk` migration (which already names this
harness as its gate), so they are filed for follow-up rather than left implicit:

→ `tickets/backlog/view-roundtrip-laws-coverage-extensions.md`

### Empty categories

- **Minor findings beyond the vacuity guard:** none.
- **Engine-code defects:** none — the fault-injection probe and reject-code audit found the
  put path behaves as the harness asserts.
