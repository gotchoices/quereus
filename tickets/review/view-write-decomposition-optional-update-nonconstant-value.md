description: Review the generalized decomposition optional-columnar / EAV UPDATE that now admits two non-constant value shapes — an **anchor-resolvable** value (`set c = a + 1`) realized as a single `on conflict … do update set col = excluded.col` upsert, and a **member self-reference** (`set c = c + 1`) realized as a matched-update-only write with the materialize suppressed. Arbitrary values (subquery / cross-member / mixed anchor+self, and any EAV self-reference) stay rejected `unsupported-decomposition-update`.
files: packages/quereus/src/planner/mutation/decomposition.ts (lowerMaterializedValue classifier, collectValueScopes, emitOptionalMemberUpdate group routing, buildOptionalMemberInsertSelect, emitEavMemberUpdate, buildEavInsertSelect, stripMemberQualifier, excludedColumn), packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts (columnar PutGet oracle), docs/view-updateability.md, docs/lens.md
----

## What landed

The constant-only gate on optional/EAV-member UPDATE values is replaced by a **value-shape
classifier**. After `substituteViewColumns` lowers the assigned value to base terms (every
column ref qualified to its backing member's `relationId` — confirmed: `requalifyColumnRefs`
in `lens-compiler.ts` qualifies identity **and** computed mappings), `lowerMaterializedValue`
walks the lowered expression (`collectValueScopes`) and classifies:

| lowered value shape | `ValueKind` | realization |
|---|---|---|
| no column ref / null literal | `constant` | **unchanged** legacy path (matched UPDATE + `do nothing` materialize, or all-null DELETE) |
| every leaf anchor-qualified | `anchor` | **one upsert** replaces both branches: `insert … select <anchorKey>, <value> from <anchor> where <pred> on conflict (<memberKey>) do update set col = excluded.col` |
| every leaf owner-member-qualified (columnar) | `self` | **matched-update-only**; materialize suppressed (absent rows have no prior value) |
| subquery / unqualified / cross-member / mixed anchor+self | reject | `unsupported-decomposition-update` (deferred → backlog `view-write-decomposition-update-arbitrary-value-capture`) |

Group resolution (per columnar member, per EAV attribute) in `emitOptionalMemberUpdate`:
all-`constant` → fast lane; has `anchor` (no `self`) → upsert; has `self` (no `anchor`) →
matched-update-only; **both** → reject (`mixes an anchor-resolvable value and a member
self-reference`). EAV: each attribute cell is `constant` (existing path) or `anchor` (the
`do update` triple upsert via `buildEavInsertSelect`); EAV `self` cannot occur (it lowers to a
correlated subquery → `arbitrary`).

The shared select + the two plan-time soundness gates (unassigned-value-column non-null-default
widen guard, `assertNoMissingNotNull`) were **factored** into one `buildOptionalMemberInsertSelect`
that takes `action: 'nothing' | 'update'`, so the gates fire identically on both flavours.
`buildEavMaterializeInsert` became `buildEavInsertSelect` the same way. `exprHasColumnRef` was
retired; `excludedColumn`/`stripMemberQualifier` added.

Why the upsert is sound: the value is computed **once** over the anchor scan; absent rows
insert it directly, matched rows read the identical proposed-insert value via `excluded.<col>`,
so the two branches agree row-for-row and the PutGet/round-trip oracle holds by construction.
The conflict target is the same deploy-guaranteed PK/non-partial-UNIQUE (`validatePrimaryAdvertisement`)
the existing `do nothing` materialize already relies on — anchor-last emit order preserved, so the
member upsert always reads the still-intact anchor.

## Validation done (the floor — treat as a starting point)

- **Build**: `yarn workspace @quereus/quereus run build` — clean.
- **Lint**: `yarn workspace @quereus/quereus run lint` — clean.
- **`lens-put-fanout.spec.ts`**: 85 passing. New deterministic round-trips + rejects:
  - `split()` (single-value optional `c`): `set c = a + 1` (present updates / absent materializes); `set c = c + 1` (present increments / **absent stays absent, no `T_c` row created**); `set c = b` cross-member reject; `set c = (select …)` subquery reject. (The line-305 constant-only reject test was **flipped** to the `a+1` round-trip.)
  - `multiSplit()` (multi-value `c1,c2` + `e2 default 7`): `set c1 = a + 1` partial upsert (c2 lands null on absent); the **unassigned-value-column non-null-default gate still fires** on the upsert path (`set e1 = a + 1` reject); `set c1 = a + 1, c2 = null` anchor-with-null-sibling (upserts both, NOT the all-null DELETE); `set c1 = a + 1, c2 = c2 + 1` mixed reject.
  - new `computedAnchorAd()` fixture: `set c = bumped + 1` (computed-anchor mapping `bumped = a+1` lowers to `(a+1)+1`, all anchor-qualified) round-trip.
  - `eavSplit()`: `set p = id * 2` anchor-resolvable triple upsert (present + absent); `set p = p + 1` EAV self-reference reject.
- **`property.spec.ts`**: 153 passing. The columnar PutGet oracle now draws **`update-c-anchor`** (`set c = a + 1`) and **`update-c-self`** (`set c = c + 1`) arms (fuzzed against the read); the reject-don't-widen line was retargeted from `set c = a + 1` (now supported) to `set c = b` (cross-member, still rejected).
- **Full suite**: `yarn workspace @quereus/quereus test` — **5027 passing, 9 pending, 0 failing**.

## Known gaps / where to dig (reviewer focus)

1. **`yarn test:store` was NOT run** (slow, out-of-band per ticket policy). The `do update`
   upsert is the same `DmlExecutorNode` upsert machinery the existing `do nothing` materialize
   already drives under the store, and no store-specific code was touched — but the **`do update`
   conflict action through a decomposition member has not been exercised under the LevelDB store
   module**. Worth a `yarn test:store` pass (or spot-run the lens-put-fanout shapes under store)
   before sign-off. (No `.pre-existing-error.md` was written — the memory-path suite is green.)

2. **Lens-synthesized constraints on the upsert op.** The `do update` upsert is a *single* base
   op that now carries both the matched and absent rows. The per-op resolvability gate
   (`view-mutation-builder.ts` `constraintsForOp`) threads row-local CHECKs / child-FKs onto a
   member op by its target columns — this should still route correctly (the op's target table is
   unchanged), but **no test combines a logical CHECK on the optional member with the new anchor
   upsert**. The surrogate-optional CHECK tests exercise only constant/identity writes. If a CHECK
   references the optional member's value column, confirm it still fires against the upsert's
   `excluded`/inserted values (both insert and do-update arms).

3. **Self-reference computing to runtime-null leaves a phantom present-but-null member row**
   (documented in the design as the all-null-result rule for self-references — NOT the syntactic
   null DELETE). The read renders a stored-null value column identically to absence, so the view
   image stays sound, but **this exact path is not pinned by a test** (a self-ref on a present row
   whose value is already null, e.g. after a partial null write, would leave `c = c + 1 = null`).
   A targeted test (drive a multi-value optional row to present-all-null, then `set c1 = c1 + 1`)
   would lock it.

4. **`hasUnqualifiedColumn` → arbitrary defensive branch is untested.** Well-formed synthesized
   bodies always qualify every member column ref, so no shipped shape reaches it; it is a guard
   against a future body-synthesis regression silently mis-classifying. No test constructs an
   unqualified lowered ref (none is reachable through the advertisement surface).

5. **Op-count change for anchor groups.** An anchor-resolvable optional/EAV write now emits **one**
   op instead of two (matched UPDATE + materialize INSERT). Nothing observed depends on the op
   count (full suite green), but flagging for any change-scope / op-shape assumptions downstream.

## Out of scope (correctly deferred, asserted to reject)

Arbitrary values — embedded subquery, cross-member column read, a single value mixing anchor +
self leaves, any EAV self-reference — stay `unsupported-decomposition-update`, routed to the
shared per-row capture substrate follow-up (`view-write-decomposition-update-arbitrary-value-capture`).
Shared-key (identity) writes, non-anchor predicates, and composite shared keys are unchanged.
