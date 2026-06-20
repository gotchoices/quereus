description: |
  Verified the fix that keeps a CHECK distinct when two storage tables (split from one
  logical table) happen to name their value columns the same — the rewrite now tags each
  column with the storage table that owns it instead of conflating the two.
prereq:
files:
  - packages/quereus/src/schema/table.ts                              # writeRowRelationCorrelation(schema, table) helper (~L581-599)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # makeLensRewriteScope / rewriteToBasisTerms / collectLensRowLocalConstraints relation-qualify on multi-member decomposition
  - packages/quereus/src/planner/building/constraint-builder.ts       # per-op scope registers <corr(opSchema,opTable)>.<col> alongside new.<col> (~L94-126)
  - packages/quereus/test/lens-put-fanout.spec.ts                     # unit test asserting relation-distinct rewrite (~L2937)
  - docs/lens.md                                                      # § Constraint Attachment notes
difficulty: medium
---

# Complete: relation-qualify the lens logical→basis CHECK rewrite so colliding basis-column names stay distinct

## Summary of the implemented change (verified)

On a **multi-member decomposition**, the row-local logical CHECK rewrite now qualifies each
mapped write-row column with a **per-member synthetic correlation** —
`writeRowRelationCorrelation(schema, table)` ⇒ `__lens_new__<schema>__<table>`, the
decomposition analogue of bare `NEW` — instead of conflating two members that spell their
value column with the same basis NAME (`id`→`w_id.val`, `name`→`w_name.val`). The per-op
constraint scope (`constraint-builder.ts`) registers `<corr>.<col>` for the op's own target
relation alongside `new.<col>`, so a single-member CHECK resolves on its owning op while a
sibling-member term fails loudly (`Column not found`) rather than silently mis-computing.
Single-source lenses are unchanged (stay on `NEW`). The cross-member deferral is now a
timing/perf choice, not a correctness necessity.

This was a **latent** flaw (cross-member CHECKs are deferred by the per-op gate today, so the
collapsed term was never executed); the fix removes the trap for any future single-member
routing.

## Review findings

**Diff reviewed fresh** (`git show 6ba81bab`) before reading the handoff, across all five
touched files plus the call sites and resolution paths they depend on.

### Correctness / architecture — checked, no major issues
- **Rewrite qualifier ↔ constraint-builder registration consistency.** The rewrite qualifies
  with `writeRowRelationCorrelation(member.relation.schema, member.relation.table)`; the
  per-op scope registers `writeRowRelationCorrelation(tableSchema.schemaName, tableSchema.name)`.
  These match because the tag-built advertisement sets `member.relation.schema = basisSchema.name`
  (`mapping-advertisement-tags.ts:225`) and `analyzeDecomposition` (`decomposition.ts:175`)
  **already requires** `member.relation.schema === ref.tableSchema.schemaName` for routing to
  function at all — so schema-qualifier equality is a pre-existing invariant, not a new
  assumption. Confirmed both sides lowercase via the helper, so casing cannot drift them apart.
- **No missed call sites.** `rewriteToBasisTerms` (signature gained two params) has exactly one
  caller — `collectLensRowLocalConstraints`, updated. `makeLensRewriteScope` is only reached
  through it. `writeRowRelationCorrelation` is used only in `lens-enforcement.ts` and
  `constraint-builder.ts`, consistently. Verified via `find_references`.
- **`relationQualify` gate** (`members.length > 1`) and the authored-inverse forward branch
  (stays on `NEW`, since `authoredForwardMap` admits only subquery-free single-source forwards)
  are correct as written.
- **Fail-safe direction confirmed.** The partial-attribution fallback (`owningRelation`
  returns `undefined` ⇒ rewrite uses `NEW` for that column ⇒ `buildWriteRowRelations` returns
  `undefined` ⇒ gate falls back to bare-name path) degrades to a loud `Column not found`, never
  a silent wrong answer.

### Tests — implementer's set is sound; coverage is stronger than the handoff claimed
- The new unit (`a cross-member row-local CHECK rewrites to relation-distinct write-row
  terms`) asserts the AST-string shape (`__lens_new__main__w_id.val` /
  `__lens_new__main__w_name.val`, not collapsed `new.val`) — meaningful and green.
- **The implementer flagged "no decomposition subquery-correlation capture test" as a gap, but
  it is substantially already covered:** the pre-existing `decomposition: a subquery CHECK
  correlating the renamed key column (docKey→doc_key) builds and enforces` test runs over a
  3-member `surrogateOptionalAd` (⇒ `relationQualify = true`), with a correlated write-row ref
  inside a subquery, and asserts **commit-time ABORT**. That exercises the relation-qualified
  rewrite end-to-end (rewrite → constraint-builder registration → resolution → enforcement),
  not just at the AST-string level — direct proof the registration matches the qualifier in a
  real decomposition write. The `single-member subquery CHECK rides/ABORTs` and cross-member
  `defers` tests likewise stayed green. No additional test judged load-bearing.

### Minor finding — FIXED IN THIS PASS (comment accuracy)
- The comments in `table.ts`, `constraint-builder.ts`, and `lens-enforcement.ts` claimed the
  synthetic correlation name "is not producible by a parsed user identifier." This is
  **inaccurate**: `new`/`old` are **not** reserved keywords (verified — absent from
  `parser/lexer.ts` `KEYWORDS`), and `__lens_new__<schema>__<table>` is an ordinary identifier
  a user *could* type as a FROM alias. The genuine, sound capture-safety argument is that such
  a name is *vanishingly implausible* as a user-written alias — exactly the basis `NEW` itself
  relies on — unlike the **bare basis table name**, which a subquery's FROM routinely
  references (which is the real reason the bare table name could not be used). Reworded all
  three comments to state this accurately. Comment-only; no behavioral change.

### Out of scope — checked, no ticket warranted (latent, no live bug)
- **FK / set-level synthesizers still emit bare `NEW.*`.** They build their write-row side
  directly (not via `rewriteToBasisTerms`), and a cross-member FK / set-level key is itself
  deferred — so there is no analogous live collapse. The originating fix scoped this to the
  row-local CHECK rewrite; making cross-member row-local CHECKs *fully evaluable* over the
  joined logical row remains deliberately out of scope (deferral is the contract). No
  reachable defect ⇒ no new ticket.
- **Partial-attribution (EAV-pivot) edge** and **degenerate single-member decomposition**: both
  reasoned through above; behavior is fail-safe / unchanged, no live bug, exotic enough that a
  dedicated test was not added. No ticket.

### Validation run during review
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) →
  **exit 0** (re-run after the comment edits).
- `yarn workspace @quereus/quereus test` (full suite) → **6376 passing, 9 pending, 0 failing.**
- Targeted `lens-put-fanout.spec.ts` + `lens-enforcement.spec.ts` → **273 passing.**

## Docs
`docs/lens.md` § Constraint Attachment was updated by the implement stage and reviewed: the
row-local CHECK bullet documents the per-member synthetic correlation (and why the bare basis
table name could not be used), and the "Two consequences" paragraph notes the cross-member
deferral is now a timing/perf choice rather than a correctness necessity. Accurate against the
landed code.
