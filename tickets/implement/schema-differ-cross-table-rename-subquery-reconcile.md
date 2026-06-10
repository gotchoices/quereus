description: Generalize the differ-side inverse table-rename reconcile in CHECK / partial-index WHERE bodies from owning-table-only to ALL in-diff table renames, so a subquery referencing ANOTHER renamed table no longer churns a benign drop+recreate. Fix is reproduced and prototype-validated.
files:
  - packages/quereus/src/schema/schema-differ.ts          # reconciledDeclaredBody case 'check' (~line 1074); declaredIndexCanonicalBody (~line 877) + its computeSchemaDiff call site (~line 488)
  - packages/quereus/test/declarative-equivalence.spec.ts # add tests near the existing "QUALIFIED self-reference under a pure table rename" block (~line 2820)
  - packages/quereus/src/runtime/emit/alter-table.ts      # reference only: rewriteTableForTableRename — the forward all-tables loop this mirrors
effort: medium
----

# Reconcile cross-table renames in CHECK / index-predicate bodies (diff side)

## Reproduced

```sql
declare schema main {
  table lim { id INTEGER PRIMARY KEY, cap INTEGER }
  table a { id INTEGER PRIMARY KEY, qty INTEGER,
            constraint chk check (qty <= (select max(cap) from lim)) }
}
apply schema main
-- then rename lim → lim2 (with tags ("quereus.previous_name" = 'lim')), CHECK follows new name
```

The diff emits `constraintsToDrop: ["chk"]` + `constraintsToAdd: ["constraint chk check (qty <= (select max(cap) from lim2))"]` on top of the rename. Confirmed **benign and converging**: apply succeeds (rename ordered before the add), the forward propagation (`rewriteTableForTableRename` walks ALL tables) rewrites the stored body to `lim2`, and the re-diff is empty. Same churn when the OWNING table is renamed in the same diff (the self-rename half reconciles, the cross-table half doesn't, so the body still mismatches).

## Root cause

`reconciledDeclaredBody` case `'check'` inverse-applies only the owning table's own rename (`tableRenames.find(r => r.oldName === tableName)`); `declaredIndexCanonicalBody` is threaded only `indexTableRename` (the index's own table). The forward path rewrites EVERY table's CHECKs and index predicates for a rename — the diff-side inverse must mirror that all-renames scope.

## Validated fix (prototype passed all repro variants + full declarative-equivalence suite, 105 passing)

**CHECK** — in `reconciledDeclaredBody` case `'check'`, replace the `selfRename` find/if with a loop over ALL renames (same inverse direction; the self rename is just one iteration):

```ts
for (const r of tableRenames) {
    renameTableInAst(clone.expr!, r.newName, r.oldName, schemaName);
}
```

The OLD-seeded column-rename loop below it is unchanged — the qualifier pass still normalizes the owning table's qualifier to OLD first, and cross-table renames don't affect the seed (`tableName` is already the owning table's actual/OLD name).

**Index** — change `declaredIndexCanonicalBody`'s `tableRename: RenameOp | undefined` parameter to `tableRenames: ReadonlyArray<RenameOp>` and pass `tableRenames.renames` at the call site (dropping the call-site `indexTableRename` find). Inside:
- loop all renames over the WHERE clone (replacing the single `renameTableInAst` call);
- the column-rewrite seed still needs the index's OWN table rename specifically: find it inside by `r.newName.toLowerCase() === indexStmt.table.name.toLowerCase()` (exactly the moved call-site lookup) and keep `seedTableName = ownRename?.oldName ?? indexStmt.table.name`;
- the clone guard becomes `colRenames.length > 0 || tableRenames.length > 0`.

## Why sequential application of multiple inverse renames is safe (no chain/swap hazard)

`resolveRenames` (schema-differ.ts ~line 661–686) makes rename chains and swaps **unrepresentable**: for any declared name that also exists in the actual catalog, the name match either wins outright (no rename) or, combined with a hint to a different actual, throws a "Rename conflict" error. Therefore every rename's `newName` is a name absent from the actual catalog while every `oldName` IS an actual-catalog name — no rename's inverse output (`oldName`) can ever match another rename's inverse input (`newName`). Sequential in-place application over one clone is order-independent and equivalent to simultaneous substitution. Worth a sentence in the updated doc comment.

## Scope-naïveté (accepted, document)

Same per-rename edge already accepted for the self-rename: `renameTableInAst` is scope-naive about a subquery alias that happens to equal a renamed table's NEW name — worst case a spurious but valid recreate (status-quo churn). Symmetric with the forward path.

## Index-path testability caveat

The memory backend rejects subqueries in partial-index predicates at create time (`compilePredicate` → "Unsupported expression in partial-index predicate: subquery", `src/vtab/memory/utils/predicate.ts:66`), and a bare cross-table qualified ref in an index WHERE is equally uncompilable — so a cross-table name **cannot currently exist in an actual catalog index** and no end-to-end apply repro is constructible. The index-side generalization is still worth landing for symmetry with the forward path and future backends. Test options, implementer's choice:
- a differ-level test feeding `computeSchemaDiff` a hand-built `SchemaCatalog` whose `CatalogIndex.definition` is rendered via `createIndexBodyToCanonicalString` (exported from `src/emit/ast-stringify.ts`) over the pre-rename predicate, with the declared side from `db.declaredSchemaManager` after a `declare` (declare alone executes no DDL); or
- skip the test and note the unreachability in the doc comment.

## Doc comments to update

- The block above `reconciledDeclaredBody` (~line 1046): CHECK bullet currently says "this table's own rename, looked up in `tableRenames` by its actual/OLD name" → all in-diff renames, with the chain/swap-unrepresentable safety note.
- The block above `declaredIndexCanonicalBody` (~line 853) and the call-site comment in the index loop (~line 469): same generalization; the own-table rename's remaining special role is only the column-rewrite seed.

## TODO

- [ ] Generalize `reconciledDeclaredBody` case `'check'` to loop all `tableRenames` (validated 3-line change above)
- [ ] Generalize `declaredIndexCanonicalBody` to take the full rename array; move the own-rename lookup inside for the column seed; update the call site
- [ ] Update the three doc comments (reconciledDeclaredBody, declaredIndexCanonicalBody, index-loop call site) — all-renames scope + sequential-safety rationale
- [ ] Tests in `declarative-equivalence.spec.ts` (pattern at ~line 2820, `diffOf` helper in scope):
  - pure cross-table rename in a CHECK subquery → no constraint churn, only the rename; apply converges (re-diff empty)
  - BOTH owning and referenced table renamed in one diff → no churn; converges
  - REGRESSION: genuine body edit (e.g. `max` → `min`) layered on the cross-table rename → still drops+recreates `chk`; converges
  - (optional) differ-level index test per the caveat above
- [ ] `yarn test` (root) green; lint `packages/quereus`
