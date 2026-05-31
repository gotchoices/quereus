description: Review the n-way `get` synthesis for advertisement-backed logical tables — the join skeleton, key-equi-join (incl. singleton `on 1 = 1`), EAV correlated-subquery pivot, surrogate equi-join, advertisement-driven gap-fill, provenance, and the read-correct/write-rejected boundary.
prereq:
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/lens.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/logic/51-lens-foundation.sqllogic, docs/lens.md
----

## What landed

The default mapper now **consumes** a resolved primary-storage `MappingAdvertisement`
to synthesize the n-way **`get`** read body, instead of falling through to the v1
single-source name aligner. Everything lives in
`packages/quereus/src/schema/lens-compiler.ts`; there is **zero new runtime** — the
synthesized body is an ordinary `SelectStmt` registered as a `ViewSchema`, so reads
ride the existing view-resolution path.

Routing change in `deployLogicalSchema` (~line 137): a table with **no override** but
a resolved `slot.advertisement` routes to the new `compileDecompositionBody(...)`;
no-advertisement tables keep `compileDefaultBody` verbatim; override tables keep
`compileOverrideBody` (now passed the advertisement for gap-fill).

### New functions (all in lens-compiler.ts)
- `compileDecompositionBody` — left-deep join tree rooted at `storage.anchorRelationId`
  (anchor emitted first regardless of its own presence), each other **non-EAV** member
  inner-joined (`presence:'mandatory'`) or left-joined (`presence:'optional'`), aliased
  by `relationId`. Projects each logical column via the shared resolver, falling back to
  a member name-match; errors precisely on an unresolvable column.
- `buildKeyEquiJoin` — positional conjunction `member.kᵢ = anchor.kᵢ` over
  `sharedKey.keyColumnsByRelation` (paired by **index**, not name, so a surrogate spelled
  differently per relation pairs correctly). Empty key column list ⇒ the vacuously-true
  `1 = 1` literal — the singleton (`primary key ()`) case falls out with **no special branch**.
- `resolveAdvertisedColumn` — the **shared** column→backing-expression resolver used by
  both the decomposition body and the override gap-fill. Precedence: (1) explicit
  per-member `LogicalColumnMapping.basisExpr`, re-qualified to the member alias; (2) EAV
  attribute pivot (exactly one pivot member + an entity correlation key) → correlated
  scalar subquery; (3) `none` → caller name-matches. Returns `unreachable` when the
  backing member isn't reachable from the caller's FROM.
- `buildEavSubquery` — `(select p.<value> from <pivot> p where p.<entity> = anchor.<key>
  and p.<attribute> = '<logicalColumn>')`. EAV pivot members are **not** join members
  (joining a triple store would multiply rows); each EAV column is an independently-nullable
  correlated subquery.
- `requalifyColumnRefs` — deep-clones a stored `basisExpr` and rewrites every `column`
  ref's `table` to the member alias (reflective walk, mirrors `collectColumnRefNames`).
- `nameMatchAgainstMembers` — name-match fallback against join members, anchor first.

`compileOverrideBody` now takes an optional `advertisement` and, for each `source:'default'`
(uncovered) column, gap-fills from the advertisement member mapping (re-qualified to the
member's alias in the override's FROM) via the shared resolver, falling back to the existing
FROM name-match. When the advertisement backs an uncovered column from a member the
override's FROM omits, it errors precisely (names the column + the member) rather than emit
an unsound body.

`docs/lens.md` (§ module mapping advertisement / Override-vs-advertisement / Implementation
Surface): flipped n-way `get` synthesis + advertisement-driven gap-fill from "pending" to
shipped; `put` fan-out + IND injection stay pending.

## Use cases to validate

Tests added: 7 unit/AST-shape cases in `test/lens-advertisement.spec.ts` (new
`describe('lens advertisement: get synthesis (n-way decomposition)')`) + 1 round-trip
section in `test/logic/51-lens-foundation.sqllogic` (part 4, columnar split via decomp tags).

Worth re-deriving / poking at:

- **Optional-component preservation (the load-bearing property).** Optional members MUST be
  `left join` — inner-joining everywhere silently drops logical rows missing an optional
  component. The `optional component` test asserts a row present only in the anchor survives
  with the optional column null. Confirm the join-type selection
  (`presence === 'mandatory' ? 'inner' : 'left'`) and that nothing downstream (optimizer
  join reordering / null-rejecting predicate inference) can turn the outer join back into an
  inner one for these synthesized bodies.
- **Singleton `on 1 = 1`.** Empty per-member key ⇒ `buildKeyEquiJoin` returns the `1 = 1`
  literal. Verify it round-trips through `astToString` (emits `1 = 1`) and re-parses/plans as
  a constant-true join. The singleton test asserts: anchor only ⇒ 1 row all-null; anchor + kv
  ⇒ 1 row; no anchor ⇒ 0 rows. Sanity-check the cardinality reasoning (`left join … on true`
  over 0-or-1 × 0-or-1 = 0-or-1).
- **EAV correlated subquery.** Each EAV column is a scalar subquery keyed by the attribute
  **literal** (the logical column *name*, original case). The contract is at-most-one triple
  per (entity, attribute) — a put/IND-direction invariant, NOT enforced for reads. If a basis
  has duplicate triples the scalar subquery errors/picks-arbitrarily at runtime; that's the
  documented EAV contract, but confirm the failure mode is acceptable vs. silently wrong.
- **Surrogate equi-join.** `sharedKey.kind` does **not** affect the read join (only put
  cares). The surrogate test asserts `Doc_body.doc_sid = Doc_core.sid` (paired positionally)
  and that the logical key carried as a value column projects.
- **Advertisement-driven gap-fill.** The sparse-override test renames one column and gap-fills
  `caption`→`cap` from the advertisement (a plain name-match would fail since the basis column
  is `cap`). The precise-error test asserts a column whose backing member is absent from the
  override FROM errors by name. Re-check the fallback order: advertisement mapping → FROM
  name-match → precise error / `gapFillError`.
- **Provenance consistency.** `annotateProvenanceWithAdvertisement` (unchanged) and the
  synthesized projection must agree on member attribution. The EAV test asserts
  `advertised_member` = the pivot member for EAV columns and the anchor for `id`. Confirm
  `resolveAdvertisedColumn`'s precedence matches the annotation precedence (explicit mapping,
  then sole EAV) — separate code paths that must not drift.

## Known gaps / risks (honest — reviewer should treat tests as a floor)

- **Write direction unchanged — correct for this ticket.** A multi-source `get` body is
  read-correct but still **write-rejected**: a join body is not a single-source updatable
  projection, so view-updateability's classifier (`planner/mutation/propagate.ts` →
  `unsupported-join`) rejects DML through it. The `put` fan-out (`lens-multi-source-put-fanout`)
  + IND injection (`lens-multi-source-ind-injection`) are the siblings that flip this. I did
  **not** add a test pinning the write-rejection for the multi-source shape — a reviewer may
  want one so a future change can't silently present a multi-source table as writable.
- **Cross-schema members untested.** Every test (and the sqllogic case) places members in
  `main`. The schema-qualification logic (`table.schemaName || basisSchemaName`,
  `pivot.relation.schema || basisSchemaName`) is plausibly correct but unexercised for a
  member in a different schema than the basis. Low risk (the resolver already resolves
  cross-schema members), but a test would close it.
- **EAV attribute-literal casing.** The pivot subquery matches the attribute column against
  the logical column name verbatim. If basis triples store attribute names in a different case
  than the logical declaration, reads return null. Not addressed (the protocol doesn't specify
  case-folding for attribute literals); flag for a doc note or follow-up if it bites.
- **Multi-EAV-member decomposition.** `resolveAdvertisedColumn` builds an EAV subquery only
  when there is **exactly one** pivot member (matching `annotateProvenanceWithAdvertisement`'s
  `soleEav`). A decomposition with two EAV members would leave non-mapped columns to
  name-match / error. Consistent with existing annotation behavior, but a latent corner with
  no test.
- **Surrogate per-member key arity not validated** by the resolver (only logical-tuple arity
  is). `buildKeyEquiJoin` defends with `Math.min`, so a malformed surrogate advertisement with
  mismatched per-member arity silently under-joins rather than errors. Belongs to the
  resolver/put ticket, noted here.
- **Outer-join survival under a filter.** The optional-member test checks the result (row not
  dropped) and the AST (`joinType === 'left'`), but not that the optimizer preserves the outer
  join when a logical-table read carries a WHERE on the optional column (the classic
  outer-join-to-inner pitfall). The synthesized body has no WHERE, so the shape is fine; a
  reviewer spot-check of `select ... from L.T where <optional col> is null` is the highest-value
  addition.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (0 TS errors).
- `yarn workspace @quereus/quereus run lint` — clean.
- lens specs (`lens-advertisement` + `lens-foundation` + `lens-prover`): 60 passing.
- `test/logic.spec.ts` (full sqllogic, incl. 51-lens-foundation): 211 passing.
- Full `yarn workspace @quereus/quereus test`: 4075 passing, 9 pending.
