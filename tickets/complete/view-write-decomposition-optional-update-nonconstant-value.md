description: Generalized the constant-only gate on optional-columnar / EAV-pivot decomposition UPDATE values into a value-shape classifier admitting two non-constant shapes — an **anchor-resolvable** value (`set c = a + 1`) realized as a single `on conflict … do update set col = excluded.col` upsert, and a columnar **member self-reference** (`set c = c + 1`) realized matched-update-only. Arbitrary values (subquery / cross-member / mixed anchor+self, any EAV self-reference) stay rejected `unsupported-decomposition-update`.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md
----

## Outcome

Implemented and reviewed. The constant-only gate on optional/EAV-member UPDATE values is replaced
by a `ValueKind` classifier (`constant` / `anchor` / `self`, else reject). Anchor-resolvable groups
collapse the matched-update + materialize branches into one `do update` upsert (the value computed
once over the anchor scan, matched rows reading it via `excluded.<col>`); columnar self-references
are matched-update-only; the shared insert-select + the two plan-time soundness gates were factored
into `buildOptionalMemberInsertSelect` / `buildEavInsertSelect` so the gates fire identically on
both `do nothing` and `do update` flavours. EAV self-references lower to a correlated subquery and
land `arbitrary` (rejected). See `docs/lens.md` § The Default Mapper (UPDATE) for the timeless
description, which was updated.

Build, lint, and the full memory-path test suite pass.

## Review findings

**Diff reviewed first, fresh, before the handoff** (commit `b6c1af57`): the full
`decomposition.ts` change plus the test and docs deltas. Read the current state of
`decomposeUpdate`, `routeAssignment`, `lowerMaterializedValue`, `collectValueScopes`,
`emitOptionalMemberUpdate`, `buildOptionalMemberInsertSelect`, `emitEavMemberUpdate`,
`buildEavInsertSelect`, `memberUpdateOp`, `anchorPredicate`/`assertAnchorScoped`, `excludedColumn`,
`stripMemberQualifier`, and cross-checked the `UpsertClause` AST + `building/insert.ts` upsert
scope (`excluded.*`/`NEW.*` registration) and `view-mutation-builder.ts`' upsert-rejection gate.

### Checked — sound

- **Anchor-resolvable upsert.** `do update set col = excluded.col` over **all** cells (including
  constant/null siblings) agrees row-for-row with the absent-insert branch; the conflict target is
  the same deploy-guaranteed PK/non-partial-UNIQUE the existing `do nothing` materialize relies on.
  Anchor-last emit order preserved, so an upsert that reads an anchor column (`set a = a+10, c = a+1`)
  observes the pre-update anchor value — matching SQL old-value SET semantics. ✓
- **Soundness gates on the upsert path.** The unassigned-value-column non-null-default widen guard
  and `assertNoMissingNotNull` now live in the shared `buildOptionalMemberInsertSelect` and fire on
  both flavours (pinned: `set e1 = a + 1` reject). Gating on the union of matched+absent is correct
  — one op serves both, and absent rows genuinely need the gate. ✓
- **Classifier scoping.** `collectValueScopes` walks the lowered value, keyed on relationId
  qualifiers; a value mixing anchor+self leaves, an unqualified ref, or any subquery (caught even
  when nested under a non-subquery wrapper, since the walk recurses to the inner `select` node)
  falls through to `arbitrary`. Group-level anchor+self mix rejected in `emitOptionalMemberUpdate`.
  EAV value column → correlated subquery → `arbitrary` (EAV self-ref reject pinned). ✓
- **Predicate interaction.** `assertAnchorScoped` rejects any WHERE column backed by a non-anchor
  member, so the self/anchor matched UPDATE never has to evaluate a member column in its
  anchor-keyed subquery. ✓
- **Lint / build / full suite.** `yarn workspace @quereus/quereus run lint` clean; full
  memory-path suite green (5028 passing, 9 pending, 0 failing). ✓
- **Docs.** `docs/lens.md`, `docs/view-updateability.md` updated to the value-shape model and read
  consistent with the code; the test-file headers match the shipped routing. ✓

### Found — MAJOR (filed `tickets/fix/view-write-decomposition-self-reference-null-result-materialization.md`)

The columnar **`self`** realization is **matched-update-only on the assumption that an absent row
"has no prior value to transform, so stays absent."** That holds only for **null-propagating**
self-expressions. The classifier admits *any* expression whose every leaf is the owner's column,
so a self-expression that maps null → non-null is silently mishandled:

```sql
-- id 2 absent in T_c → logical c reads null. new c = coalesce(null,0)+1 = 1 → should materialize.
update x.T set c = coalesce(c, 0) + 1 where id = 2;
select c from x.T where id = 2;   -- EXPECTED [{c:1}]   ACTUAL [{c:null}]  (reproduced)
```

The materialize is suppressed, so the write is **silently dropped** and the PutGet/round-trip
oracle fails. Same root cause drops a non-null constant sibling in a self group (`set c1 = c1+1,
c2 = 5` leaves absent rows absent instead of materializing `c2 = 5`). The flagship `set c = c + 1`
is correct (null-propagating). Not affected: the anchor path (always materializes) and EAV
self-references (rejected). The handoff's "reviewer focus #3" called out the opposite, benign
direction (present row → runtime-null leaves a phantom row, read-sound) but **missed** this
absent-row data-loss direction. Confirmed by a throwaway repro spec (since removed). Disposition:
**major** — the sound fix (materialize absent rows with owner-cols→NULL substitution + a
non-empty-row filter + `do nothing`, preserving the `c = c + 1` "stays absent" behavior) is a
non-trivial query-construction + test-design change, so filed to `fix/` rather than patched in the
review pass.

### Checked — not defects (handoff "where to dig" items)

- **#1 `yarn test:store` not run.** Out-of-band per ticket policy; the `do update` upsert reuses
  the same `DmlExecutorNode` upsert machinery the existing `do nothing` materialize already drives,
  and no store-specific code was touched. Not gating; left for a store pass / CI.
- **#2 lens-synthesized CHECK on the anchor upsert.** The op's target table is unchanged, so
  `constraintsForOp` routing is unaffected; no shipped shape combines a logical CHECK on the
  optional member with the anchor upsert, but nothing in the diff weakens it. No defect observed.
- **#3 self-ref → runtime-null phantom present-but-null row.** Read-sound (a stored-null value
  column renders identically to absence); benign representational redundancy, distinct from the
  MAJOR finding above.
- **#4 `hasUnqualifiedColumn` → arbitrary branch untested.** Defensive guard against a future
  body-synthesis regression; not reachable through the advertisement surface, so no test is
  constructible without fabricating a malformed body. Acceptable as a guard.
- **#5 op-count change for anchor groups (one op vs two).** Full suite green; nothing observed
  depends on op count. Not a defect.

### Not changed

No inline fixes were needed for the *minor* category — none surfaced. The single finding is major
and filed. The pre-existing-error path was not triggered (suite green).
