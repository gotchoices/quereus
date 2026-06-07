description: Generalize the decomposition optional-columnar / EAV-pivot UPDATE to admit a non-constant assigned value in two self-contained cases — an **anchor-resolvable** value (`set c = a + 1`, every leaf lowers to an anchor base column) via an upsert (`on conflict … do update`) unification, and a **member self-reference** value (`set c = c + 1`) via a matched-update-only (present-rows) write that suppresses materialization. Arbitrary cross-member / subquery / mixed self+anchor values stay rejected (deferred to the shared-capture follow-up).
prereq:
files: packages/quereus/src/planner/mutation/decomposition.ts (lowerMaterializedValue → classifier; emitOptionalMemberUpdate; emitEavMemberUpdate; buildOptionalMaterializeInsert; buildEavMaterializeInsert; exprHasColumnRef), packages/quereus/src/parser/ast.ts (UpsertClause: action 'update' + assignments — already supported), packages/quereus/src/planner/building/insert.ts (DO UPDATE SET scope: excluded.*/NEW.* — reference only), packages/quereus/test/lens-put-fanout.spec.ts (flip the line-305 reject test; add the new round-trips + new rejects), docs/view-updateability.md (§ Decomposition put fan-out — UPDATE bullet), docs/lens.md (§ The Default Mapper)
----

## Problem

`lowerMaterializedValue` (decomposition.ts) narrows an optional-columnar / EAV-pivot UPDATE
value to a **constant** (or null literal). Any value referencing a column rejects
`unsupported-decomposition-update`. The narrowing exists because the matched-UPDATE base op
evaluates the value in the **member's** row scope while the materialize-INSERT evaluates it
over the **anchor** — only a scope-independent (constant) value survives both. This ticket
widens the expressible surface to the two cases that need **no new runtime substrate**, and
leaves the genuinely-capture-needing case rejected with a precise diagnostic.

## Design (resolved)

Replace the constant-only gate with a **classifier** over the lowered (base-term) value. After
`substituteViewColumns(asg.value, …)`, every logical column ref is qualified to its backing
member's relation alias (the synthesized body aliases each member by `relationId` — the same
qualifier `rewriteAssignedValue` already keys cross-source rejection on). Inspect the lowered
expression's column-ref `table` qualifiers + subquery presence and classify:

| lowered value shape | kind | matched (present) rows | absent rows |
|---|---|---|---|
| no column refs, no subquery | `constant` | base UPDATE (fast lane, **unchanged**) | materialize INSERT `do nothing`, or all-null → DELETE (**unchanged**) |
| all refs qualified to **anchor**, no subquery | `anchor` | — unified — | **one upsert**: `insert … select <anchorKey>, <value> from <anchor> where <pred> on conflict (<memberKey>) do update set <col> = excluded.<col>` |
| all refs qualified to **owner member**, no subquery (columnar only) | `self` | bare base UPDATE (`set c = c + 1`) | **suppressed** (absent rows have no prior value → stay absent) |
| subquery present / cross-member / unqualified / **mixed anchor+self** | `arbitrary` | — | **reject** `unsupported-decomposition-update` (deferred — see backlog `view-write-decomposition-update-arbitrary-value-capture`) |

### Why upsert for the anchor-resolvable case (not a correlated subquery)

The anchor-resolvable value is expressible over the anchor scan the materialize already builds
(`select <anchorKey>, <value> from <anchor>`). The matched side, scoped to the member, cannot
see the anchor column without a correlated subquery — but instead of synthesizing one, **unify
both branches into a single upsert** keyed on the member stitch key:

```sql
insert into <member> (<memberKey>, c, d)
select <anchorKey>, <value_c>, <value_d> from <anchor> <anchorAlias> where <pred>
on conflict (<memberKey>) do update set c = excluded.c, d = excluded.d
```

The value is computed **once** over the anchor scan; absent rows insert, matched rows
`do update`. Both branches read the identical anchor-computed value, so they agree row-for-row
(the PutGet / round-trip oracle holds by construction). `excluded.<col>` is the proposed-insert
value (registered in the upsert scope by `building/insert.ts`; `NEW.<col>` is the equivalent
alias). `action: 'update'` + `assignments` is already in the `UpsertClause` AST — no parser /
runtime change. This replaces *both* the matched UPDATE and the materialize INSERT for an
anchor-resolvable group with one op; the conflict target is the member stitch key
(`validatePrimaryAdvertisement` guarantees it is a declared PK / non-partial UNIQUE), exactly
as the existing `do nothing` materialize relies on.

### Member self-reference is present-rows-only

`set c = c + 1` lowers to `<member>.c + 1`. An absent row has no prior `c` to increment, so a
self-reference is matched-update-only **by nature**: strip the owner qualifier (reuse the
`rewriteAssignedValue` transform) → `set c = c + 1`, and **suppress** the materialize INSERT.
It is a value transform, never an all-null-delete trigger (it is not a syntactic null literal),
so the existing delete branch is untouched.

### EAV pivot

The EAV value column substitutes to a **correlated subquery** in the get body (an EAV column is
projected as `(select val from pivot where entity = anchor.id and attr = 'p')`, never a plain
column), so an EAV **self-reference** (`set p = p + 1`) lands in `arbitrary` → rejected
(deferred). An EAV **anchor-resolvable** value (`set p = id * 2`) lowers to anchor-qualified
refs (no subquery) → the `anchor` branch, emitted as the EAV upsert analogue:

```sql
insert into <pivot> (<entity>, <attr>, <val>)
select <anchorKey>, '<attribute>', <value> from <anchor> where <pred>
on conflict (<entity>, <attribute>) do update set <valCol> = excluded.<valCol>
```

The conflict target `(entity, attribute)` is the deploy-guaranteed unique key (not the
one-to-many stitch `entity`), as the existing `do nothing` EAV materialize already relies on.

### Group resolution (per member, per attribute)

Cells accumulate per member (per attribute for EAV). Resolve a columnar member group from its
cells' kinds:

- all `constant` → existing fast lane (base UPDATE + materialize `do nothing`, or all-null DELETE).
- has `anchor`, no `self` → **upsert** (constant cells fold in as literal projections / `do update set col = excluded.col`).
- has `self`, no `anchor` → **matched-update-only**, suppress materialize (constant cells ride along as bare literals — a self-reference makes the whole group present-rows-only).
- has **both** `anchor` and `self` → reject `arbitrary` (the matched side would need a per-leaf correlated subquery / capture — deferred).

For EAV each attribute is its own group; `self` never occurs (it lands `arbitrary`), so an EAV
attribute is `constant` (existing path) or `anchor` (upsert).

## Edge cases & interactions

- **`set c = a + 1` where `a` is an anchor column** — the existing reject test
  (`lens-put-fanout.spec.ts` ~line 305, asserts `/constant \(or null\) value/i`) flips to a
  round-trip: present rows update, absent rows materialize `a + 1` from the anchor. Update both
  the test and its narration.
- **`set c = c + 1` self-reference** — present rows increment; absent rows stay absent (no
  spurious materialization). Add a round-trip test asserting the absent row (`id = 2`, no `T_c`)
  reads `c = null` afterwards and no `T_c` row was created.
- **Self-reference computing to runtime-null** — leaves a physically-present member row whose
  value column is null. The read renders a stored-null value column **identically to absence**
  (anchor LEFT JOIN member), so the view image stays sound; the phantom row is a benign storage
  artifact (a later `set c = <non-null>` re-finds it; a DELETE fans out to it). Document this as
  the all-null-result rule for self-references — it is **not** the syntactic-null DELETE path.
- **Anchor value that is itself a computed anchor mapping** (`bumped = a + 1` logical column,
  `set c = bumped + 1`) — substitutes to `(a + 1) + 1`, all anchor-qualified → `anchor` branch.
  Add a test.
- **Multi-value-column optional member, partial anchor write** (`set c1 = a + 1` on the
  `M_opt(c1,c2)` lens around line 334) — the upsert projects `c1 = a+1` and lands `c2` at its
  base default; the unassigned-value-column soundness gate (a `do update`/insert that would
  leave an unassigned value column to a **non-null** base default silently widens) must still
  fire. Keep `buildOptionalMaterializeInsert`'s gate (NOT NULL / declared-default unassigned
  value column → reject) on the upsert path too.
- **Mixed anchor + self in one member** (`set c = c + 1, d = a + 1`) — reject `arbitrary` with a
  message naming the conflict. Add a reject test.
- **Cross-member value** (`set c = b` where `b` backs a different member) — lowers to a
  non-anchor, non-owner qualifier → `arbitrary` → reject. Add a reject test.
- **Subquery value** (`set c = (select …)`) — subquery present → `arbitrary` → reject.
- **EAV `set p = id * 2`** — anchor-resolvable EAV upsert; round-trip (present entity updates,
  absent entity materializes the triple). **EAV `set p = p + 1`** — `arbitrary` (substitutes to
  a subquery) → reject. Add both.
- **Anchor-resolvable value with a null-literal sibling** (`set c = a + 1, d = null`) — `anchor`
  group; the upsert projects `null` for `d` and `do update set d = excluded.d` (= null). Not the
  all-null DELETE path (the group has a non-null anchor cell). Confirm soundness.
- **Anchor-last ordering** — an optional / EAV member is never the anchor, so the member upsert
  always reads the still-intact anchor; the existing anchor-last emit order is preserved.
- **`do update` conflict-target soundness** — the upsert relies on the same deploy-time
  PK/UNIQUE guarantee (`validatePrimaryAdvertisement`) the `do nothing` materialize already
  relies on; a non-unique stitch / `(entity, attr)` could not deploy.
- **Duplicate-target guard** (`b, b as b2` routing two logical columns to one basis column) —
  the `noteTarget` reject must still fire before classification; the upsert's own DO-UPDATE
  duplicate-assignment backstop (`building/insert.ts`) is a secondary net.
- **`store` module path** — exercise the new upsert + matched-only writes under `yarn test:store`
  is out-of-band (slow); the memory path is the in-ticket gate. The upsert / `do update` runtime
  is module-agnostic, so no store-specific code is touched.

## TODO

- Replace `lowerMaterializedValue` with a classifier returning `{ kind: 'constant' | 'anchor' | 'self'; value; isNull }` (drop the column-ref reject). Add a small AST walk collecting column-ref `table` qualifiers + a subquery flag; classify against `anchor.relationId` and the owner member's `relationId`. `arbitrary` (subquery / unqualified / foreign-member / nothing-matches) raises `unsupported-decomposition-update` with a precise, scope-explaining message that lists the three supported shapes and points at the capture follow-up. Retire/repurpose `exprHasColumnRef`.
- Thread the cell `kind` onto `OptionalCell` / `EavCell`.
- `emitOptionalMemberUpdate`: compute the group kind from cells; route to (a) existing constant path, (b) the new anchor upsert, (c) matched-update-only + suppressed materialize for self, (d) reject for mixed anchor+self. Keep the all-null-constant DELETE branch exactly as is (only reachable for a pure-constant group).
- Add `buildAnchorResolvableUpsert` (columnar): the insert-select over the anchor (alias = `anchor.relationId`) with `upsertClauses: [{ type: 'upsert', conflictTarget: [memberKey], action: 'update', assignments: cells.map(c => ({ column: c.basisColumn, value: { type: 'column', name: c.basisColumn, table: 'excluded' } })) }]`. Reuse the unassigned-value-column soundness gate + `assertNoMissingNotNull` from `buildOptionalMaterializeInsert` (factor the shared select/gate construction).
- For the `self` group, build the bare matched UPDATE via `memberUpdateOp` with each value's owner qualifier stripped (reuse `rewriteAssignedValue`'s `transformExpr` strip), and emit **no** materialize op.
- `emitEavMemberUpdate`: for an `anchor` attribute cell, emit one EAV upsert (`buildEavAnchorResolvableUpsert` — the triple insert-select with `conflictTarget: [entity, attribute], action: 'update', assignments: [{ column: valCol, value: excluded.valCol }]`) instead of matched-UPDATE + `do nothing`; keep the `constant` (non-null upsert-via-update+do-nothing, null delete) path; `self` cannot occur (it lands `arbitrary`).
- Tests (`packages/quereus/test/lens-put-fanout.spec.ts`):
  - Flip the `defers a non-constant optional-member value` test (~line 305) to a round-trip for `set c = a + 1` (present + absent) and update its narration.
  - Add: `set c = c + 1` self-reference (present updates, absent stays absent, no `T_c` row created); `set c = bumped + 1` computed-anchor mapping; mixed anchor+self reject; cross-member reject (`set c = b`); subquery reject.
  - Multi-value-column lens (~line 334): `set c1 = a + 1` upsert round-trip; confirm the unassigned-value-column non-null-default gate still fires.
  - EAV lens (~line 415/460): `set p = id * 2` anchor-resolvable round-trip; `set p = p + 1` reject.
- Extend the PutGet / round-trip oracle in `packages/quereus/test/property.spec.ts` to draw anchor-resolvable and self-reference optional-member assignments (not just constants), so the two new branches are fuzzed against the read.
- Docs: update `docs/view-updateability.md` § Decomposition put fan-out (the UPDATE bullet — replace "constant only" with the constant / anchor-resolvable-upsert / self-reference taxonomy) and the deferral list (arbitrary value → capture follow-up); update `docs/lens.md` § The Default Mapper if it states the constant-only narrowing.
- Update the module header doc-comment in `decomposition.ts` (the "Deferred" / UPDATE sections) to describe the new taxonomy and the remaining `arbitrary` deferral.
- Gate: `yarn workspace @quereus/quereus run build`, `yarn workspace @quereus/quereus test` (stream with `tee`), and lint (single-quoted globs on Windows).
