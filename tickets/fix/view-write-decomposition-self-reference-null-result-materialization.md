description: A decomposition optional-columnar UPDATE whose value is classified `self` (every leaf is the owning member's own column) is realized **matched-update-only** — the materialize INSERT is suppressed on the assumption that an absent row "has no prior value to transform, so stays absent". That assumption only holds for **null-propagating** self-expressions (`c + 1`, `c * 2` → `null` on an absent/null row). For a self-expression that maps null → non-null (`coalesce(c, 0) + 1`, `ifnull(c, 0) + 1`, a `case`/`iif` with a non-null else, etc.) the new logical value is non-null, so the absent row **should materialize**, but the suppression silently drops it: the write is lost and the PutGet / round-trip oracle fails. This is a silent-wrong-result in a shape the shipped surface advertises as *supported* (not a rejected/deferred case).
files: packages/quereus/src/planner/mutation/decomposition.ts (lowerMaterializedValue `self` classification; emitOptionalMemberUpdate `hasSelf` branch — the matched-update-only realization; buildOptionalMemberInsertSelect; stripMemberQualifier), packages/quereus/test/lens-put-fanout.spec.ts (self-reference round-trip tests), packages/quereus/test/property.spec.ts (`update-c-self` oracle arm), docs/lens.md (§ The Default Mapper, UPDATE — the self-reference bullet)
----

## Repro (confirmed during review of `view-write-decomposition-optional-update-nonconstant-value`)

Using the `split()` fixture from `lens-put-fanout.spec.ts` (anchor `T_core(id,a)`, mandatory
`T_b(b)`, **optional** `T_c(c)`; row 1 present in `T_c`, row 2 absent):

```sql
-- id 2 is absent (no T_c row) → logical c reads null.
-- new c = coalesce(c, 0) + 1 = coalesce(null, 0) + 1 = 1 → the logical row should become c = 1.
update x.T set c = coalesce(c, 0) + 1 where id = 2;

select c from x.T where id = 2;   -- EXPECTED [{ c: 1 }]   ACTUAL [{ c: null }]
```

`coalesce(c, 0) + 1` lowers to `T_c.coalesce(...)+1` — every column leaf is the owning member's
own column, so `collectValueScopes` returns `qualifiers = {T_c}`, `lowerMaterializedValue`
classifies it `self`, and `emitOptionalMemberUpdate`'s `hasSelf` branch emits **only** the
matched UPDATE (`update T_c set c = coalesce(c,0)+1 where id in (select id from T_core where
id=2)`). Row 2 has no `T_c` row, so the UPDATE matches nothing and the value is silently dropped.
The read renders the still-absent `T_c` row as `c = null`, so the write `c = 1` is lost.

The flagship case `set c = c + 1` is correct (it is null-propagating: `null + 1 = null`, which
reads identically to absence), but the `self` classifier admits **any** expression whose every
leaf is the owner's column — it does not (and cannot easily, syntactically) distinguish
null-propagating from non-null-propagating shapes.

## Scope of the defect

- **Single-column self, non-null-propagating** (above) — absent rows in the predicate range that
  should materialize to a non-null value stay absent. Silent data loss.
- **Self mixed with a non-null constant sibling** on a multi-value optional member, e.g.
  `set c1 = c1 + 1, c2 = 5`: `hasSelf` forces the whole group present-rows-only, so the
  constant `c2 = 5` — which on its own (pure-constant group) would materialize absent rows to
  `(c1=null, c2=5)` — is dropped on absent rows. Same root cause (materialize suppressed for the
  whole self group).

Not affected: the **anchor** path (always materializes over the anchor scan, so no drop) and the
**EAV self-reference** case (lowers to a correlated subquery → classified `arbitrary` → rejected,
never reaches a cell). The bug is specific to the **columnar `self`** realization.

## Expected behavior

`update <logical> set c = <self-expr>` must round-trip for **all** self-expressions, not only
null-propagating ones: an absent row whose new value is non-null materializes; an absent row whose
new value is null stays absent (no phantom row). The PutGet oracle must hold for
`coalesce`/`ifnull`/`case`/`iif` self-expressions and for a self+non-null-constant mix.

## Direction (for the implement stage — not prescriptive)

The clean general realization that preserves the shipped `set c = c + 1` "absent stays absent"
behavior **and** fixes the non-null-result case: keep the matched UPDATE for present rows, and add
back a materialize INSERT for absent rows that

- projects the self-expression with the **owner's own column refs substituted by NULL literals**
  (an absent row's prior value is null), so `coalesce(c,0)+1 → coalesce(null,0)+1 = 1` and
  `c + 1 → null + 1 = null` are each computed correctly over the anchor scan, and
- filters the select to rows whose materialized image is non-empty
  (`where <v1> is not null or <v2> is not null or …`), so a self group that resolves to all-null
  on an absent row creates **no** phantom row (preserving the `c = c + 1` test), while a non-null
  result materializes, and
- uses `on conflict (<memberKey>) do nothing` to cede matched rows to the matched UPDATE.

This is the materialize-with-null-substitution analogue of the existing constant/anchor
insert-selects (`buildOptionalMemberInsertSelect`) and reuses its soundness gates
(unassigned-value-column widen guard, `assertNoMissingNotNull`). Decide whether the present-rows
matched UPDATE and the absent materialize should likewise collapse, or stay two ops.

Alternative (narrower, less satisfying): keep matched-update-only but **reject** any self-expression
that is not provably null-propagating — but there is no reliable syntactic null-propagation
predicate (`+ - * /` propagate; `coalesce`/`ifnull`/`case`/string fns/comparisons do not), so this
risks both false rejects and missed cases. Prefer the materialize approach.

## Tests to add

- `coalesce(c, 0) + 1` (and `ifnull` / a `case` else-non-null) self-expression on an absent row →
  materializes the non-null value; on a present-but-null row → materializes/updates to non-null.
- `set c = c + 1` on an absent row → still **no** row created (regression pin — already present).
- self + non-null-constant sibling (`set c1 = c1 + 1, c2 = 5`) over an absent row → materializes
  `(c1=null→dropped? or row with c2=5)` per the chosen semantics; over a present row → updates both.
- Extend the `update-c-self` property.spec oracle arm to a non-null-propagating self-expression so
  the fuzzer covers the absent-materialize transition (today it only fuzzes `c + 1`).
