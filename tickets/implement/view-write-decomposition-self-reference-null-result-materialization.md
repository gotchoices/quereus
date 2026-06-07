description: A decomposition optional-columnar UPDATE classified `self` (every value leaf is the owning member's own column) is realized matched-update-only — the materialize INSERT is suppressed on the assumption that an absent row "has no prior value to transform, so stays absent". That holds only for **null-propagating** self-expressions (`c + 1`, `c * 2` → null on an absent/null row). For a self-expression that maps null → non-null (`coalesce(c, 0) + 1`, an `iif`/`case` with a non-null else, etc.) the new logical value is non-null, so the absent row **should materialize**, but the suppression silently drops the write and the PutGet round-trip fails. Fix: in `emitOptionalMemberUpdate`'s `hasSelf` branch, keep the matched UPDATE for present rows **and** add back a materialize INSERT for absent rows that projects the self-expression with the owner's own column refs substituted by NULL, filters to rows whose materialized image is non-empty, and cedes matched rows via `on conflict (<memberKey>) do nothing`. Confirmed silent-wrong-result in a shape the surface advertises as supported.
files: packages/quereus/src/planner/mutation/decomposition.ts (emitOptionalMemberUpdate `hasSelf` branch ~L1060-1066; buildOptionalMemberInsertSelect ~L1130; stripMemberQualifier ~L1374; file-header UPDATE bullet L56-57; lowerMaterializedValue doc L899-901; emitOptionalMemberUpdate doc L1027-1028), packages/quereus/test/lens-put-fanout.spec.ts (self-reference round-trip tests ~L331; multi-value optional member describe ~L390; file header L18-19,L32-35), packages/quereus/test/property.spec.ts (`update-c-self` oracle arm ~L5209,L5260-5264), docs/lens.md (§ The Default Mapper UPDATE bullet L154; Current limitations L591-592)
----

## Root cause (confirmed reproduced)

`packages/quereus/src/planner/mutation/decomposition.ts`, `emitOptionalMemberUpdate`, the
`hasSelf` branch (around L1060):

```ts
if (hasSelf) {
    // Self-reference group → matched-update-only over the owner-qualifier-stripped values;
    // no materialize (an absent row has no prior value to increment).
    ops.push(memberUpdateOp(ctx, view, shape, member,
        cells.map(c => ({ column: c.basisColumn, value: stripMemberQualifier(c.value, member) })), pred, stmt));
    return;
}
```

The `self` classifier (`lowerMaterializedValue`, L913+) admits **any** expression whose every
column leaf is the owner member's own column. `coalesce(c, 0) + 1` lowers to `T_c.coalesce(c,0)+1`
— all leaves are `T_c.c` — so it classifies `self` and takes the matched-update-only path. Row 2
has no `T_c` row, the `update T_c … where id in (select id from T_core where id=2)` matches
nothing, and the new logical value `coalesce(null,0)+1 = 1` is silently dropped.

Reproduced with the `split()` fixture (anchor `T_core(id,a)`, mandatory `T_b(b)`, optional
`T_c(c)`; row 1 present in `T_c`, row 2 absent):

```sql
update x.T set c = coalesce(c, 0) + 1 where id = 2;
select c from x.T where id = 2;   -- EXPECTED [{ c: 1 }]   ACTUAL [{ c: null }]  (T_c id=2 never created)
```

The flagship `set c = c + 1` is correct only because it is null-propagating (`null + 1 = null`,
which reads identically to absence). There is **no reliable syntactic null-propagation predicate**
(`+ - * /` propagate; `coalesce`/`iif`/`case`/comparisons/string fns do not), so we cannot fix this
by narrowing the `self` classifier — the materialize must be added back and gated at **runtime**.

## Fix (prototyped end-to-end; confirmed correct)

Replace the `hasSelf` branch so it emits **two** ops:

1. The existing matched UPDATE over present rows (real prior member values, owner qualifier
   stripped) — unchanged.
2. A **materialize INSERT** for absent rows (a new `buildSelfMaterializeInsertSelect`, modeled on
   `buildOptionalMemberInsertSelect`) that:
   - projects each cell's value with the **owner's own column refs substituted by a NULL literal**
     (an absent row's prior value is null), via `transformExpr(value, col => col.table === owner.relationId ? { type:'literal', value:null } : undefined)`. So `coalesce(c,0)+1 → coalesce(null,0)+1 = 1` and `c + 1 → null + 1 = null` each compute correctly over the anchor scan; constant sibling cells carry no ref and pass through unchanged;
   - selects over the **anchor** scan (`from <anchor> alias <anchorRelationId>`), threading
     `<anchorKey>` into `<memberKey>` exactly like the constant/anchor insert-selects;
   - **filters** to a non-empty image: `where <pred> and (<v1> is not null or <v2> is not null or …)`
     where each `<vi>` is the null-substituted projected value. `is not null` is a
     `{ type: 'unary', operator: 'IS NOT NULL', expr }` node; OR-chain them. This is what makes
     `c + 1` create **no** phantom row (its substituted image is constant-null → filter is
     constant-false → zero rows) while `coalesce(c,0)+1` materializes (filter constant-true);
   - uses `on conflict (<memberKey>) do nothing` so present rows (whose member row exists) conflict
     and are ceded to the matched UPDATE — only absent rows materialize;
   - reuses the **identical soundness gates** as `buildOptionalMemberInsertSelect`: the
     unassigned-value-column widen guard (a value column the statement does not assign must be
     nullable + no declared default) and `assertNoMissingNotNull`.

### Why two ops, not an upsert (key design constraint)

The `anchor`-resolvable path collapses both branches into one `do update set c = excluded.c`
upsert because the value agrees row-for-row across branches. **A `self` group cannot collapse
this way**: the matched value is computed over the *member* scan (`c + 1` reads the real prior
`c`), but the materialize value is computed over the *anchor* scan with `c` substituted to null
(`null + 1`). An upsert's `do update set c = excluded.c` would feed matched rows the
null-substituted value — wrong. The matched UPDATE (real member value) and the `do nothing`
materialize (null-substituted absent value) must stay **two distinct ops**. (Order is immaterial:
the UPDATE targets the member, the INSERT scans the untouched anchor.)

### Always-emit is correct (no special-casing needed)

Because the runtime non-empty filter suppresses null-propagating self-expressions automatically
(`c + 1` → zero rows), the materialize INSERT can be emitted **unconditionally** for the `hasSelf`
branch — no need to retain a static suppression. The existing `set c = c + 1` regression test
(lens-put-fanout.spec.ts L331) passes unchanged under this with the prototype.

### Behavior note to call out in the review handoff

A **partial** self-update that leaves a non-null-defaulted sibling value column unassigned
(e.g. `update x.M set e1 = e1 + 1` where `M_def.e2 default 7`) will now **reject** via the existing
unassigned-value-column widen gate (`/silently widening|base default/`), whereas the old
matched-update-only path silently accepted it. This is the right conservative call: we cannot
statically distinguish `e1 + 1` (null-propagating, no materialize) from `coalesce(e1,0) + 1`
(materializes, would widen `e2` to 7), and the constant/anchor paths already enforce exactly this
gate. No existing test covers this case, so nothing breaks; flag it in the review ticket as an
intentional surface change.

## Validation notes

- Prototype (the two-op `hasSelf` branch above) was applied and **all 85 tests** in
  `lens-put-fanout.spec.ts` passed, including the `set c = c + 1` regression. Repro
  (`coalesce(c,0)+1` absent → `c=1`, present → updates) confirmed fixed. Then reverted.
- **`ifnull` is NOT a registered function** in this engine (`Function not found: ifnull/2`).
  `coalesce` and `iif` ARE registered (`packages/quereus/src/func/builtins/scalar.ts`). Use
  `coalesce`, `iif(c is null, 0, c) + 1`, and/or a `case when c is null then 0 else c end + 1`
  expression for the non-null-propagating test arms — **not** `ifnull`.

## TODO

- In `decomposition.ts`, rewrite the `emitOptionalMemberUpdate` `hasSelf` branch to emit the
  matched UPDATE plus a new `buildSelfMaterializeInsertSelect` materialize INSERT (per the Fix
  section). Keep `stripMemberQualifier` for the matched UPDATE values.
- Add `buildSelfMaterializeInsertSelect` (modeled on `buildOptionalMemberInsertSelect`, sharing
  its gate logic — extract a shared helper if it keeps things DRY rather than copy-pasting the
  two soundness gates) and a small `substituteOwnerColumnsWithNull` helper. Document why it stays
  two ops (cannot upsert) and why always-emit is sound (runtime non-empty filter).
- Update the prose: `decomposition.ts` file-header UPDATE bullet (L56-57), `lowerMaterializedValue`
  doc (L899-901), `emitOptionalMemberUpdate` doc (L1027-1028), and the `self` arm of the
  `ValueKind` doc — the "matched-update-only / materialize suppressed" claim is now wrong for
  non-null-propagating self-expressions.
- Tests in `lens-put-fanout.spec.ts`:
  - `coalesce(c, 0) + 1` on an **absent** row (id=2) → materializes `c = 1`; on a **present**
    row (id=1, c=1000) → updates to `1001`; on a present-but-null row → updates to non-null.
  - an `iif`/`case` else-non-null self-expression on an absent row → materializes.
  - **regression pin**: `set c = c + 1` on an absent row → still **no** row created (already at
    L331 — keep it; optionally assert no row springs into being even when emitting the filtered
    materialize).
  - **self + non-null-constant sibling** on the multi-value `M_opt` (c1, c2 both nullable):
    `update x.M set c1 = c1 + 1, c2 = 5 where id = 2` (absent) → materializes `(c1=null, c2=5)`;
    `where id = 1` (present) → updates both. (Confirms the constant cell is no longer dropped on
    absent rows when a self cell is present.)
  - (optional) a partial self-update leaving a non-null-defaulted sibling unassigned on `M_def`
    rejects `/silently widening|base default/` — pins the intentional surface change above.
- Extend the `update-c-self` PutGet oracle arm in `property.spec.ts` (around L5209 / L5260): add a
  **non-null-propagating** self arm, e.g. `update-c-coalesce-self` running
  `update x.T set c = coalesce(c, 0) + 1 where id = ${K}` with oracle
  `if (core.has(K)) { cMap.set(K, (cMap.has(K) ? cMap.get(K)! : 0) + 1); mutated++; }` so the
  fuzzer covers the absent-materialize transition (today the arm only fuzzes the null-propagating
  `c + 1`). Update the explanatory comment at L5949-5950.
- Update `docs/lens.md`: the § The Default Mapper UPDATE bullet (L154) — the self-reference is no
  longer "matched-update-only / materialize suppressed"; it now materializes an absent row when the
  null-substituted image is non-null (and stays absent when null-propagating, via the runtime
  filter). Adjust the Current limitations notes (L591-592) accordingly. Also refresh the spec file
  header comment (lens-put-fanout.spec.ts L18-19, L32-35).
- Run `yarn workspace @quereus/quereus test` (or at minimum the `lens-put-fanout` and `property`
  specs) and `yarn workspace @quereus/quereus lint` before handing off to review.
