description: A commit-time set-level (logical unique/PK) uniqueness CHECK synthesized by the lens layer is threaded onto EVERY base op of a decomposition UPDATE fan-out — including member ops (UPDATE / materialize-INSERT) whose target table does not carry the logical key's basis column. When the logical PK is not carried by every member AND has no basis covering structure (the natural surrogate-keyed shape), the member op fails to BUILD with `QuereusError: NEW.<keycol> isn't a column`, making the whole UPDATE path unusable. Fix: gate `extraConstraints` per base op so a lens-synthesized constraint rides only the op(s) whose target table can resolve the write-row columns it references.
files: packages/quereus/src/planner/building/view-mutation-builder.ts (extraConstraints threading — buildViewMutation ~L144-176, baseOps.map → buildBaseOp; buildBaseOp ~L852-866), packages/quereus/src/planner/mutation/lens-enforcement.ts (collectLensSetLevelConstraints ~L589, collectLensRowLocalConstraints ~L96, rewriteToBasisTerms ~L78, synthesizeUniqueCountExpr ~L529), packages/quereus/src/planner/mutation/propagate.ts (BaseOp.table: TableReferenceNode, ~L161), packages/quereus/src/planner/nodes/reference.ts (TableReferenceNode.tableSchema.columns), packages/quereus/src/planner/building/constraint-builder.ts (buildConstraintChecks — where NEW.* resolution throws, ~L88-133), packages/quereus/test/lens-put-fanout.spec.ts (surrogate-keyed optional-member UPDATE describe ~L1429; setupSurrogateOptional ~L1454 carries the `doc_key text unique` workaround to remove), docs/view-updateability.md (§ Current limitations ~L827)
----

## Summary

A decomposition-backed logical table whose **logical primary/unique key is not carried by every
member** and **lacks a basis covering structure** cannot be UPDATEd at all — the statement throws at
**plan-build time**, before any row is touched:

```
QuereusError: NEW.doc_key isn't a column
  at resolveColumn (planner/resolve.ts)
  at buildConstraintChecks (planner/building/constraint-builder.ts)
  at buildUpdateStmt (planner/building/update.ts)
  at buildBaseOp (planner/building/view-mutation-builder.ts)   ← baseOps.map(... extraConstraints ...)
  at buildViewMutation (planner/building/view-mutation-builder.ts)
```

This is a hard build failure (the affected schema's UPDATE path is entirely unusable), not a silent
correctness bug. **Reproduced** (this fix run): in `lens-put-fanout.spec.ts`, dropping the
`doc_key text unique` workaround from `setupSurrogateOptional` (anchor becomes `doc_key text`) makes
all four `surrogate-keyed optional-member UPDATE` tests throw `NEW.doc_key isn't a column` on the very
first `update x.Doc set …`.

## Root cause (confirmed)

1. The logical PK `docKey` maps to `Doc_core.doc_key`. With no basis `UNIQUE` on `doc_key`, the lens
   prover has no covering structure, so it classifies the key `enforced-set-level` / `mode:
   'commit-time'`.
2. `collectLensSetLevelConstraints` (`lens-enforcement.ts:589`) synthesizes a deferred count-subquery
   uniqueness CHECK. Its `NEW.*` side references the **basis** key column: `synthesizeUniqueCountExpr`
   emits `{ type: 'column', name: basisColumn, table: 'NEW' }` (i.e. `NEW.doc_key`); the subquery
   FROM is the logical view aliased `_u`, so its inner refs are alias-qualified (`_u.docKey`), not
   write-row refs.
3. `buildViewMutation` (`view-mutation-builder.ts` ~L144-151) computes `extraConstraints` **once**,
   then `baseOps.map(op => buildBaseOp(ctx, op, extraConstraints, …))` threads that SAME list onto
   **every** base op of the fanned-out UPDATE — anchor AND members alike.
4. A member op (the `Doc_meta` UPDATE for `set note=…`, or its materialize-INSERT on the absent-row
   branch) targets only `Doc_meta(meta_sid, note)`. `buildConstraintChecks`
   (`constraint-builder.ts:88-133`) only registers `new.<col>` for columns of the op's `tableSchema`,
   so `NEW.doc_key` cannot resolve → `resolveColumn` throws.

Why other shapes dodge it:
- **Decomposition INSERT** member ops dodge it because `buildDecompositionInsert` →
  `buildDecompositionMemberInsert` passes `[]` extras (set-level / row-local enforcement on
  decomposition insert is already deferred — see the comment at `buildDecompositionMemberInsert`).
- **Logical-tuple** decompositions dodge it: their logical PK *is* the stitch key, present on every
  member and basis-PK-unique, so the key proves out and no commit-time set-level CHECK is synthesized.
- **Single-source** lens writes dodge it: exactly one base op, which carries the key column.

The bug is specific to: **logical PK not carried by every member + no basis uniqueness** (the natural
surrogate-keyed case) → an UPDATE fans out to ≥1 member op that cannot resolve the key's basis column.

## Expected behavior

The set-level uniqueness obligation must ride **only the op(s) that can introduce a duplicate of the
logical key** — i.e. the op(s) whose target table carries (and can change) the key's basis column(s).
A member op that neither carries nor can alter the key column cannot create a duplicate, so threading
the CHECK onto it is both wrong (build failure) and semantically over-broad.

After the fix, the reproduction (anchor `doc_key text`, no UNIQUE) must build and run: a
`update x.Doc set note=…` fans out, the uniqueness CHECK rides only an op that owns `doc_key` (none,
for a note-only UPDATE — correct, since it cannot dup the key), and the member UPDATE /
materialize-INSERT build cleanly. An `update x.Doc set docKey=…` routes the CHECK onto the `Doc_core`
op that owns `doc_key`.

## Recommended fix — uniform per-op resolvability gate at the threading site

Audit-and-gate uniformly across **all** `extraConstraints` classes (set-level, row-local CHECK,
child-FK EXISTS, parent-FK NOT EXISTS), not just set-level — the same overbroad-threading latently
affects row-local / FK constraints on any multi-op fan-out (a logical CHECK / FK spanning columns on
more than one member would crash the member op lacking a referenced column). Gate them all by the same
rule rather than special-casing set-level.

**Rule:** thread a lens-synthesized constraint onto a base op iff every **write-row column reference**
it makes resolves on that op's target table columns (`op.table.tableSchema.columns`, case-insensitive).
Write-row column references are:
- any `NEW.*` / `OLD.*`-qualified `ColumnExpr` anywhere in the constraint expr (the correlated
  write-row side — set-level, FK, parent-FK all qualify with `NEW`/`OLD`); **plus**
- any **bare** (no `table`/`schema` qualifier) `ColumnExpr` that is **not inside a subquery**
  (row-local CHECKs rewrite logical refs to *bare* basis refs — see `rewriteToBasisTerms`, which emits
  `{ type: 'column', name: basisColumn }` with no qualifier — and the `enforced-row-local` class is
  subquery-free by the prover's definition, so its bare refs are always top-level write-row refs).
  Subquery-internal refs (`_u.docKey`, FK child/parent aliases) are alias-qualified and must be
  ignored — they resolve against the subquery's own FROM, not the write row.

Two viable implementations (pick one; the first is recommended — localized, no schema-type change):

**(A) AST-walk resolvability helper in `view-mutation-builder.ts`** — add a small
`writeRowColumns(expr): Set<string>` that walks the constraint AST collecting (i) `NEW`/`OLD`-qualified
column names anywhere and (ii) bare column names not descended into via a `ScalarSubquery`/`Exists`
(stop bare-collection at subquery boundaries; still descend for NEW/OLD-qualified). Then replace
`baseOps.map(op => buildBaseOp(ctx, op, extraConstraints, …))` with a per-op filter:
`extraConstraints.filter(c => [...writeRowColumns(c.expr)].every(col => opCols.has(col)))`, where
`opCols` is the lowercased column-name set of `op.table.tableSchema.columns`. Note `extraConstraints`
is **exclusively** lens-synthesized (the physical table's own checks are added inside
`buildConstraintChecks` from `tableSchema.checkConstraints`, never via this seam), so gating every
entry is safe.

**(B) Metadata on the synthesized constraint** — give each lens collector annotate the basis write-row
columns it references (e.g. an optional `referencedNewColumns?: readonly string[]` on
`RowConstraintSchema`, or carried via `tags`), which every collector already has in hand
(`keyColumns[].basisColumn` for set-level; the mapped basis columns for row-local via
`resolveLogicalReferencedColumns` / the `logicalToBasisColumnMap`; the FK basis columns). Threading
site filters by `referencedNewColumns ⊆ opCols`. More robust against future constraint shapes (no AST
walk) but touches the shared schema type + all four collectors.

### Resulting semantics (document, don't fight)

- **Set-level uniqueness on a key-unchanged UPDATE** is dropped (no op carries the key) — correct: a
  key-unchanged UPDATE provably preserves uniqueness. (A single-source lens UPDATE still rides the one
  base op that carries the key even when the key is unchanged — harmless extra O(n) scan; optimizing
  that away by gating on whether the SET assigns a key column is OUT OF SCOPE here.)
- **Cross-member row-local CHECK / FK on a decomposition UPDATE** is filtered off every member op (no
  single member's write row can evaluate it) → not enforced — consistent with decomposition INSERT,
  which already defers row-local / set-level enforcement (passes `[]`). A row-local CHECK / FK entirely
  within one member still rides that member's op. Consider a `log()` (debug) when a constraint is
  dropped from all ops so a silent non-enforcement is at least traceable.

## Verification

- `yarn workspace @quereus/quereus test --grep "surrogate-keyed optional-member UPDATE"` with the
  `doc_key text unique` workaround removed → all four green (matched UPDATE, absent→materialize INSERT,
  all-null DELETE, null-to-absent no-op — all exercise member ops the CHECK must not ride).
- Full `yarn workspace @quereus/quereus test` + `yarn workspace @quereus/quereus lint` clean.

## TODO

- Implement the per-op resolvability gate (approach **A** recommended) in
  `view-mutation-builder.ts`: add the `writeRowColumns` AST-walk helper (NEW/OLD-qualified anywhere +
  bare-not-in-subquery), compute each op's lowercased column set from `op.table.tableSchema.columns`,
  and filter `extraConstraints` per op before `buildBaseOp`. Keep it uniform across all
  `extraConstraints` classes (set-level, row-local, child-FK, parent-FK).
- Optional: `log()` (debug) when a lens-synthesized constraint resolves on no base op of a fan-out, so
  a silently-dropped cross-member CHECK/FK is traceable.
- Remove the `doc_key text unique` workaround in `setupSurrogateOptional`
  (`lens-put-fanout.spec.ts` ~L1465) — revert to `doc_key text` — and update its now-stale explanatory
  comment (lines ~1458-1464) to state the fixed behavior (the CHECK rides only the key-owning op, so a
  member UPDATE builds even with no basis uniqueness).
- Add a focused regression test alongside the surrogate-optional describe: a no-basis-uniqueness
  surrogate decomposition whose `update x.Doc set note=…` (member-only, key untouched) builds and runs,
  AND an `update x.Doc set docKey=…` that routes the uniqueness CHECK onto the anchor (`Doc_core`) op —
  i.e. a duplicate `docKey` is rejected at commit (count ≥ 2 ⇒ ABORT), proving the CHECK still fires on
  the op that owns the key.
- (If approach A's bare-ref handling proves fragile in review, fall back to **B**.)
- Update `docs/view-updateability.md` § Current limitations: this is currently an *undocumented build
  failure*, so there is no stale "deferred" note to remove. After the fix the surrogate-no-basis-unique
  UPDATE just works — do NOT add a "deferred" note for it. If approach A/B leaves cross-member row-local
  CHECK / FK enforcement deferred on a decomposition UPDATE (it does — matching INSERT), document that
  one residual precisely (single-member-resolvable logical CHECK/FK is enforced; a CHECK/FK spanning
  more than one member is deferred on the decomposition fan-out, as on INSERT).
- Run the verification commands above; ensure green + lint clean.
