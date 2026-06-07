description: Decomposition optional-columnar UPDATE classified `self` (every value leaf is the owning member's own column) was realized matched-update-only — the materialize INSERT was suppressed on the assumption that an absent row "has no prior value to transform, so stays absent". That holds only for **null-propagating** self-expressions (`c + 1`, `c * 2` → null on an absent row). For a self-expression that maps null → non-null (`coalesce(c, 0) + 1`, an `iif`/`case` with a non-null else) the new logical value is non-null, so the absent row **should** materialize; the suppression silently dropped the write and the PutGet round-trip failed. Fixed: `emitOptionalMemberUpdate`'s `hasSelf` branch now keeps the matched UPDATE for present rows **and** adds a materialize INSERT for absent rows that projects the self-expression with the owner's own column refs substituted by NULL, filters to a non-empty materialized image (so null-propagating expressions create no phantom row), and cedes matched rows via `on conflict (<memberKey>) do nothing`.
files: packages/quereus/src/planner/mutation/decomposition.ts (emitOptionalMemberUpdate `hasSelf` branch, buildSelfMaterializeInsertSelect, assertNoUnassignedValueColumnWiden, substituteOwnerColumnsWithNull, doc blocks), packages/quereus/test/lens-put-fanout.spec.ts (self-reference round-trip tests ~L331-410, multi-value optional member describe ~L516-565), packages/quereus/test/property.spec.ts (`update-c-coalesce-self` oracle arm ~L5209/L5266), docs/lens.md (§ The Default Mapper UPDATE bullet, Current limitations), docs/view-updateability.md (decomposition UPDATE summaries)
----

## What changed

`emitOptionalMemberUpdate`'s `hasSelf` branch (decomposition.ts) previously emitted **only** the
matched UPDATE. It now emits **two** ops:

1. The matched UPDATE over present rows (real prior member value, owner qualifier stripped) — unchanged.
2. A new `buildSelfMaterializeInsertSelect` materialize INSERT for absent rows that:
   - projects each cell's value with the **owner's own column refs substituted by a NULL literal**
     (`substituteOwnerColumnsWithNull`) — an absent row's prior member value is null, so
     `coalesce(c,0)+1 → coalesce(null,0)+1 = 1` and `c + 1 → null + 1 = null`;
   - selects over the **anchor** scan, threading `<anchorKey>` into `<memberKey>` like the
     constant/anchor insert-selects;
   - **filters to a non-empty image**: `where <pred> and (<v1> is not null or <v2> is not null …)`
     over the null-substituted values — this is what suppresses a null-propagating self-expression
     (`c + 1` → constant-false filter → zero rows) while a null→non-null one materializes;
   - uses `on conflict (<memberKey>) do nothing` to cede present rows to the matched UPDATE;
   - reuses the same two soundness gates as the constant/anchor path — the unassigned-value-column
     widen guard (now extracted to the shared `assertNoUnassignedValueColumnWiden` helper, called by
     both builders) and `assertNoMissingNotNull`.

The self classifier (`lowerMaterializedValue`) is unchanged — the materialize is gated at **runtime**
by the non-empty filter, not by narrowing the classifier (there is no reliable syntactic
null-propagation predicate). Prose updated in decomposition.ts (file header, `ValueKind` doc,
`lowerMaterializedValue` doc, `emitOptionalMemberUpdate` doc), docs/lens.md, docs/view-updateability.md.

## Validation (the test floor — treat as a starting point, not exhaustive)

`yarn workspace @quereus/quereus test` → **5033 passing, 9 pending, 0 failing**. Lint clean.
No pre-existing failures surfaced (no `.pre-existing-error.md` written).

lens-put-fanout.spec.ts (all passing) — the supported self-reference round-trips:
- **`c + 1` regression pin** (null-propagating): present increments, absent creates **no** row
  (filtered materialize). Comment updated to reflect the INSERT-is-emitted-but-filtered behavior.
- **`coalesce(c, 0) + 1`** (split fixture): absent → materializes `c = 1`; present → matched UPDATE
  to `1001` (no double-apply).
- **`iif(c is null, 0, c) + 1`** and **`case when c is null then 0 else c end + 1`**: absent → materializes 1.
- **self + non-null-constant sibling** (`c1 = c1 + 1, c2 = 5`, M_opt): absent → `(null, 5)`; present → `(101, 5)`.
- **two self cells, mixed propagation** (`c1 = c1 + 1, c2 = coalesce(c2, 0) + 1`): absent → `(null, 1)`
  (per-cell null-substitution + OR-filter); present → `(101, 201)`.
- **present-but-null matched arm** (`c1 = coalesce(c1, 0) + 1` over a present M_opt row whose c1 = null) → 1.
- **partial self-update widen reject** (`set e1 = e1 + 1` on M_def with `e2 default 7`) → rejects
  `/silently widening|base default/`, materializes nothing.

property.spec.ts — new **`update-c-coalesce-self`** PutGet oracle arm
(`update x.T set c = coalesce(c, 0) + 1`) with oracle `if (core.has(K)) { cMap.set(K, (cMap.has(K) ?
cMap.get(K)! : 0) + 1); … }`, covering the absent-materialize transition the existing
null-propagating `update-c-self` arm cannot reach (fuzzed at numRuns: 100).

## Reviewer attention / known gaps

- **Intentional surface change** (pinned by a test): a partial self-update leaving a
  non-null-defaulted sibling value column unassigned now **rejects** via the widen gate, whereas the
  old matched-update-only path silently accepted it. We cannot statically distinguish `e1 + 1`
  (null-propagating, no materialize) from `coalesce(e1, 0) + 1` (materializes, would widen the
  unassigned sibling), so the conservative reject matches the constant/anchor paths. Confirm this is
  the desired surface.
- **Op order is NOT immaterial** (the ticket's prose said it was — it is wrong on this point). The
  matched UPDATE **must run before** the materialize INSERT: if the INSERT ran first it would
  materialize an absent row, which the subsequent UPDATE's `where <memberKey> in (<anchor subquery>)`
  would then re-match and **double-apply** the transform. The code pushes UPDATE-then-INSERT
  (consistent with the constant/anchor paths) and the comment documents this. Worth a reviewer check
  that nothing reorders a member's ops between accumulation and execution.
- **Why two ops, not an upsert**: a `self` group cannot collapse like the `anchor` group because the
  matched value is computed over the *member* scan (real prior `c`) while the materialize value is
  computed over the *anchor* scan with `c` nulled — they disagree row-for-row, so `do update set c =
  excluded.c` would feed matched rows the null-substituted value. Verify the reasoning holds.
- **Engine NOT-NULL default**: a bare `integer` column is NOT NULL by default in this engine (the
  multi-value fixtures declare `integer null` precisely for this). The split-fixture `T_c.c` is NOT
  NULL, so the present-but-null arm rides the nullable `M_opt` fixture instead. Not a code concern,
  but a fixture subtlety a reviewer extending these tests should know.
- **Coverage shape not exercised**: a surrogate-keyed (distinctly-spelled member key) self-reference
  materialize. The surrogate optional-member UPDATE path is tested for constant/anchor values
  elsewhere in the spec, and `buildSelfMaterializeInsertSelect` threads `<anchorKey> → <memberKey>`
  the same way as `buildOptionalMemberInsertSelect`, so it should compose — but it is not directly
  pinned by a self-reference test. Low risk; flagging as a floor gap.
- **Adjacent deferral unchanged**: anchor+self mixed groups and EAV self-references still reject
  (`hasAnchor && hasSelf` reject; EAV self lowers to a subquery → `arbitrary`). Existing tests for
  those still pass.
