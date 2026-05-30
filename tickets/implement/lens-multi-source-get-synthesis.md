description: Synthesize the n-way `get` read body for a logical table backed by a resolved primary-storage advertisement — a join over several basis relations (columnar split / EAV / column-family), with optional (`presence:'optional'`) members outer-joined onto the existence anchor and mandatory (`presence:'mandatory'`) members inner-joined, a key-equi-join that may use a surrogate or a logical tuple, EAV pivot expansion, and the singleton (`primary key ()` / `on true`) degenerate case. Also executes advertisement-driven gap-fill for sparse overrides. Read direction only — `put` fan-out + surrogate threading and IND injection are sibling tickets. Design source: `docs/lens.md` § "The Default Mapper".
prereq: lens-module-mapping-advertisement
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/logic/51-lens-foundation.sqllogic, docs/lens.md
----

## Scope

`lens-module-mapping-advertisement` (shipped) resolves, validates, and **stores**
a primary-storage `MappingAdvertisement` on `LensSlot.advertisement` — but the
body producer is still the **v1 single-source name aligner** (`compileDefaultBody`
in `lens-compiler.ts`): it emits `select <logical cols> from B.T'` over one
name-matching basis table and ignores the advertisement entirely.

This ticket makes the default mapper **consume** a resolved advertisement to
synthesize the n-way **`get`** join body. It is the read half of the decomposition
work; the `put` fan-out (`lens-multi-source-put-fanout`) and the existence-anchor
IND injection (`lens-multi-source-ind-injection`) are split into siblings because
they hard-depend on the view-mutation substrate and the IND foundation
respectively, while this read synthesis depends only on the already-landed
advertisement protocol and is independently shippable + testable.

After this ticket: `select * from Logical.T` over a columnar/EAV/column-family
decomposition reads correctly through the synthesized join, riding the existing
view-resolution path with zero new runtime. Writes through such a table still go
through the v1 single-source view-updateability rewrite and therefore continue to
reject the multi-source shape with a structured diagnostic — that is the put
ticket's to flip; this ticket must not silently present a multi-source table as
writable beyond what the substrate already allows.

## Current state (verified, do not re-discover)

- `packages/quereus/src/schema/lens-compiler.ts`:
  - `deployLogicalSchema` compiles-first (atomic), then clear-and-rebuilds slots +
    views. For a table with **no override** it calls `compileDefaultBody(...)`
    (line ~127); the advertisement is resolved at line ~101 and stored on the slot
    but never read by the body producer.
  - `compileDefaultBody(logicalTable, logicalSchemaName, basisSchema, basisSchemaName)`
    (line ~311) emits the single-source `select`. **This is the function this
    ticket forks**: when `slot.advertisement` is present, route to a new
    `compileDecompositionBody(...)` that builds the join; otherwise keep today's
    single-source path verbatim.
  - `compileOverrideBody(...)` (line ~409) composes override-covered columns ⊕
    gap-fill ⊖ hidden. Today gap-fill resolves only against the **override's own
    FROM** sources (`gapFillRef`). Advertisement-driven gap-fill (an uncovered
    column filled from the advertisement's per-member mapping, *richer* than
    name-match) is the protocol's deferred `lens-multi-source-decomposition`
    execution — it lands here.
  - `validateOverrideAdvertisementConflict(...)` (line ~856) already errors when a
    *sparse* override's FROM references a relation outside the advertised members.
    That guard stays; this ticket adds the *execution* of the gap-fill it protects.
  - `resolveBasisRelation(...)`, `buildColumnBackingMap(...)`,
    `collectColumnRefNames(...)` (helpers near the bottom) are reusable for member
    resolution / column-backing during synthesis.
- `packages/quereus/src/vtab/mapping-advertisement.ts` — the descriptor consumed
  here: `StorageShape { anchorRelationId, members[], sharedKey }`,
  `DecompositionMember { relationId, relation, presence, columns[], attributePivot? }`,
  `LogicalColumnMapping { logicalColumn, basisExpr }`,
  `SharedKey { kind:'surrogate'|'logical-tuple', keyColumnsByRelation, generator? }`,
  `AttributePivot { entityColumn, attributeColumn, valueColumn }`. All structurally
  validated by `validatePrimaryAdvertisement` already — synthesis may assume a
  coherent shape (anchor is a member, every referenced column exists, key columns
  cover every member, surrogate ⇒ generator, logical-tuple ⇒ per-member arity =
  PK arity).
- `packages/quereus/src/parser/ast.ts` — `FromClause` with `type:'join'` carries
  `left`, `right`, `joinType:'inner'|'left'|'right'|'full'|'cross'`, `onClause`.
  The ON-clause expression is the `condition` field (USING is `columns`); the
  right side may be aliased via a wrapping `TableSource.alias`.
  The synthesized body is `{ type:'select', columns, from:[<join tree>] }`. The
  view is registered with `astToString(body)` as `sql` and `selectAst` as the
  inlined body, identical to today.
- `LensColumnProvenance.advertisedBy` is already annotated by
  `annotateProvenanceWithAdvertisement` — keep it accurate for the synthesized
  body (the EAV-backed columns attribute to the pivot member, etc.).
- Existing tests: `test/lens-advertisement.spec.ts` (resolution/validation/storage
  + `quereus_effective_lens` provenance — extend with synthesis assertions),
  `test/logic/51-lens-foundation.sqllogic` (read round-trips).

## Design

### Anchor selection and join skeleton

`StorageShape.anchorRelationId` names the existence anchor explicitly (never
reverse-engineered). The synthesized FROM is a left-deep join tree rooted at the
anchor member:

```
from   <anchor>                                   -- preserved side / row identity
[inner|left] join <member₂> on <key-equi-join>    -- inner if mandatory, left if optional
[inner|left] join <member₃> on <key-equi-join>
...
```

- **Mandatory member** (`presence:'mandatory'`) → `inner join` (every logical row
  has it; inner-joining is sound *because* the put fan-out + IND injection prove
  existence — but for the read body the join type is driven straight off
  `presence`).
- **Optional member** (`presence:'optional'`) → `left join`. The anchor is the
  preserved side, so a logical row missing an optional component survives with that
  component's columns null. **Inner-joining everywhere would silently drop rows —
  this is the load-bearing correctness property; a test must assert it.**
- The anchor itself is emitted first regardless of its own `presence`. If a
  mandatory non-anchor member exists it may equally serve as the preserved root,
  but v1 keeps it simple: anchor first, everyone else joined onto it. (The
  `not null`-column anchor elision — using a mandatory member's relation *as* the
  anchor to drop a separate existence relation — is already expressible by the
  module naming that member as `anchorRelationId`; synthesis honors whatever the
  advertisement names and needs no special elision logic.)

### Key-equi-join construction

For each non-anchor member, the `on` clause is the conjunction of per-key-column
equalities pairing the member's key columns to the anchor's, read from
`SharedKey.keyColumnsByRelation` (a surrogate may be spelled differently per
relation, so pair positionally by index, not by name):

```
on  member.k0 = anchor.k0 and member.k1 = anchor.k1 ...
```

Both surrogate and logical-tuple keys build the *same* equi-join — `SharedKey.kind`
only matters to the `put` direction (whether a surrogate is generated). Qualify
every column reference by the member's relation ref name (alias = `relationId` or
table name; choose a stable alias scheme so EAV pivots and repeated tables don't
collide — recommend aliasing each member by its `relationId`).

### Singleton / empty-key degenerate case (not a special path)

When the logical PK is `primary key ()` the per-member key column lists are empty,
so the equi-join conjunction is empty ⇒ **vacuously `true`**. Build it as
`on true` (a `LiteralExpr` true / a `1=1` comparison — match whatever
`ast-stringify` round-trips cleanly). `left join … on true` over a 0-or-1-row
anchor and 0-or-1-row members yields 0-or-1 row — the singleton cardinality. This
falls out of the general construction: if the key-column list is empty, the
conjunction builder returns the `true` literal. **No singleton-specific branch** —
a test asserts the empty-key body uses `on true` and reads 0-or-1 row with every
column null when only the anchor exists.

### Column projection — per-member and EAV pivot

The projection lists exactly the logical columns in declaration order (minus
hidden), each resolved to its backing basis expression:

- **Member-mapped column** (`DecompositionMember.columns` carries a
  `LogicalColumnMapping`) → the mapped `basisExpr`, re-qualified to the member's
  alias. (The stored `basisExpr` references the member's own columns; re-qualify
  its `column` refs to the member alias, reusing a walk like
  `collectColumnRefNames` but rewriting rather than collecting.)
- **Name-match column** (no advertisement mapping, but a same-named column on a
  member — the protocol allows leaving such columns to name-match) → an unqualified
  /member-qualified column ref, same as today's single-source path.
- **EAV pivot column** (`member.attributePivot`) → the value pulled from the triple
  store keyed by the attribute literal. v1 expresses each EAV-backed logical column
  as a **correlated scalar subquery** against the pivot member:
  `(select p.<valueColumn> from <pivot> p where p.<entityColumn> = anchor.<key>
   and p.<attributeColumn> = '<logicalColumnName>')`.
  This keeps every EAV column independently nullable (a logical row may have a
  triple for some attributes and not others) and rides the existing scalar-subquery
  read path with no new runtime. (A grouped conditional-aggregate pivot is a later
  optimization; the correlated-subquery form is the correctness baseline. Note the
  scalar-subquery cardinality assumption — at most one triple per (entity,
  attribute) — is a put-direction invariant the put/IND tickets enforce; for reads
  it is the EAV contract.)

`annotateProvenanceWithAdvertisement` already attributes member-mapped columns to
their member and EAV columns to the pivot member — verify it still matches the
synthesized projection and extend if the pivot/ name-match attribution drifted.

### Advertisement-driven gap-fill (sparse overrides)

When a table has both an override **and** a resolved advertisement, and the
override is *sparse* (some logical columns are `source:'default'`):

- The existing `validateOverrideAdvertisementConflict` guard already rejects a
  sparse override whose FROM re-anchors outside the advertised members — keep it.
- For each uncovered (gap-filled) logical column, resolve it against the
  **advertisement's per-member mapping** (the member that backs it, re-qualified to
  that member's alias in the override's FROM), instead of only the override-FROM
  name-match `gapFillRef`. This is "richer than name-match" gap-fill the protocol
  reserved for this ticket.
- The override's FROM already references the member relations (the conflict guard
  enforces that), so the gap-filled column references are reachable. If the
  override's FROM does **not** include the member backing an uncovered column,
  error precisely (naming the column and the member it would need) rather than
  emit an unsound body — the same fidelity-boundary discipline as `gapFillError`.

Factor the column→backing-expression resolution so both `compileDecompositionBody`
(pure default) and `compileOverrideBody` (gap-fill) call one shared
`resolveAdvertisedColumn(member-or-name-match, alias)` helper.

## Key tests (TDD)

Add to `test/lens-advertisement.spec.ts` (unit/AST-shape) and
`test/logic/51-lens-foundation.sqllogic` (round-trip):

- **Columnar split round-trip.** A logical `Car(id, make, maxSpeed)` advertised as
  `CarCore(id, make)` (anchor, mandatory) + `CarPerf(id, speed→maxSpeed)`
  (mandatory) → synthesized body is an inner join on `id`; insert into the basis
  members, `select * from L.Car` returns the recomposed rows; the effective SQL
  (`quereus_effective_lens`) shows the join.
- **Optional-component preservation.** Same with `CarPerf` `presence:'optional'` →
  `left join`; a `Car` row present in `CarCore` but absent from `CarPerf` survives
  with `maxSpeed` null. **Assert the row is NOT dropped** (the inner-join-drops-rows
  regression).
- **Singleton existence relation.** `Config primary key ()` over a zero-column
  existence anchor + per-column members → body uses `on true`; with only the anchor
  row present, `select * from L.Config` yields exactly one row with every column
  null; with no anchor row, zero rows.
- **EAV pivot read.** A logical table over an `attributePivot` member → each logical
  column resolves to a correlated scalar subquery on the attribute literal; a row
  with triples for some attributes and not others reads with the missing ones null.
- **Surrogate-keyed get.** A decomposition whose `sharedKey.kind:'surrogate'` (key
  spelled differently per member) → the equi-join pairs the per-member surrogate
  columns positionally and the logical key (carried as a value column) projects
  correctly. (Surrogate *generation* is the put ticket; this asserts the read join
  is correct over a surrogate key.)
- **Advertisement-driven gap-fill.** A sparse override renaming one column of a
  decomposed table → the renamed column is override-sourced, the rest gap-fill from
  the advertisement members (not just the override FROM's name-match), and the
  composed body covers every logical column.
- **Provenance.** `quereus_effective_lens` attributes each column to the right
  member (`advertised_member`) / anchor (`advertisement_anchor`) for member-mapped,
  EAV, and name-match columns.

## TODO

### Phase A — join skeleton + key-equi-join
- Add `compileDecompositionBody(logicalTable, logicalSchemaName, basis, advertisement, schemaManager)` in `lens-compiler.ts`; route to it from `deployLogicalSchema` when `slot.advertisement` is present and there is no override (else keep `compileDefaultBody`).
- Build the left-deep join tree: anchor first, each other member inner/left-joined per `presence`, aliased by `relationId`.
- Build the per-member key-equi-join as a positional conjunction over `keyColumnsByRelation`; empty key column list ⇒ `on true` (singleton case, no special branch).

### Phase B — projection (member / name-match / EAV)
- Resolve each logical column to its backing expression via a shared `resolveAdvertisedColumn` helper: member `LogicalColumnMapping.basisExpr` re-qualified to the member alias; else name-match column ref; else EAV correlated scalar subquery on the attribute literal.
- Re-qualify `basisExpr` column refs to the member alias (rewrite-walk reusing the `collectColumnRefNames` traversal shape).
- Keep `annotateProvenanceWithAdvertisement` consistent with the synthesized projection (member / pivot / name-match attribution).

### Phase C — advertisement-driven gap-fill for sparse overrides
- In `compileOverrideBody`, for each `source:'default'` column over an advertised table, gap-fill from the advertisement member mapping (re-qualified to the override-FROM alias) via the shared resolver, falling back to today's FROM name-match.
- Error precisely when an uncovered column's backing member is absent from the override's FROM (fidelity boundary; reuse the `gapFillError` discipline).
- Confirm `validateOverrideAdvertisementConflict` still guards re-anchoring (unchanged).

### Phase D — docs + tests
- `docs/lens.md` § "The Default Mapper" / § Implementation Surface: flip the n-way **`get`** synthesis + advertisement-driven gap-fill from "pending" to shipped; keep `put` fan-out + IND injection marked pending (sibling tickets). Note the EAV correlated-subquery read form and the anchor-first left-deep skeleton.
- Tests per "Key tests". Run `yarn workspace @quereus/quereus run build`, `yarn workspace @quereus/quereus test`, and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows) before handoff.
- Hand off honestly: a multi-source table is read-correct but still write-rejected for the multi-source shape (put ticket flips that); state this in the review handoff.
