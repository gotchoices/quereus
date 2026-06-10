description: Reconcile cross-table COLUMN renames (and the owning-table rename's missing scope-resolver) in the differ's CHECK body compare, eliminating benign drop+recreate churn. Reproduced; fix design mirrors two in-file precedents.
files:
  - packages/quereus/src/schema/schema-differ.ts          # reconciledDeclaredBody case 'check' (~1380): add cross-table loop + thread a declared-side ResolveColumnInSource; computeSchemaDiff pre-pass (~355) builds columnRenamesByTable; view precedent inverseRenamedViewParts (~1098); index precedent declaredIndexCanonicalBody (~1206)
  - packages/quereus/src/schema/rename-rewriter.ts        # renameColumnInCheckExpression (resolver hook param), renameColumnInAst (no hook — forward parity), ResolveColumnInSource type
  - packages/quereus/src/runtime/emit/alter-table.ts      # reference only: rewriteTableForColumnRename — forward parity contract (owning table → seeded walk WITH resolver; other tables → plain renameColumnInAst, NO resolver)
  - packages/quereus/test/declarative-equivalence.spec.ts # new tests mirror the cross-table TABLE-rename block at ~3185-3328 (same describe block, diffOf at ~2650)
  - docs/schema.md                                        # constraint body-change section (~564): "seeded with the OLD (actual) table name" sentence describes own-table-only column scope — update to the new shape
----

# Reconcile cross-table COLUMN renames in CHECK subquery bodies (diff side)

## Reproduced (fix-stage findings)

All cases were reproduced against current HEAD with a temp spec (since deleted); the churn is
**benign and converging** in every probed variation — the forward propagation
(`propagateColumnRenameInSchema` walks ALL tables' CHECKs) rewrites the stored body correctly,
apply succeeds (verified in BOTH table declaration orders — the churned ADD CONSTRAINT
referencing the new column name does not fail even when its table block precedes the renamed
table's RENAME COLUMN), enforcement stays intact, and the re-diff is empty.

Two distinct gaps produce the churn:

**Gap A — cross-table column renames never applied.** Rename `lim.cap → capacity` (column
`previous_name` hint) with CHECK on `a`: `check (qty <= (select max(cap) from lim))` declared as
`max(capacity)`. Diff emits the rename on `lim` **plus** `constraintsToDrop: ["chk"]` /
`constraintsToAdd` on `a`. Cause: `reconciledDeclaredBody` case `'check'` applies only the owning
table's `colRenames`; `columnRenamesByTable` (already threaded in, used by the FK branch) is
ignored. Same churn when `lim` is table-renamed AND column-renamed in one diff.

**Gap B — owning-table seeded inverse lacks the scope resolver.** Rename `a.qty → cap` where the
referenced table `lim` ALSO has a column `cap`: declared `check (cap <= (select max(cap) from lim))`,
actual `check (qty <= (select max(cap) from lim))`. The differ calls
`renameColumnInCheckExpression` WITHOUT the `ResolveColumnInSource` hook the forward path passes,
so the inverse `cap→qty` falsely rewrites the INNER `cap` (which binds to `lim`) and reconciles to
`max(qty)` ≠ actual `max(cap)` → churn, despite the rename map being correct.

## Fix design

### Gap A: cross-table inverse loop (exact in-file precedents)

In `reconciledDeclaredBody` case `'check'`, AFTER the existing owning-table `colRenames` loop, add
a loop over `columnRenamesByTable` mirroring the view precedent (`inverseRenamedViewParts`,
schema-differ.ts ~1098-1104) and the index precedent (`declaredIndexCanonicalBody` ~1209-1214):

```ts
for (const [declaredTableName, renames] of columnRenamesByTable) {
	// Key is the DECLARED (new) table name; the qualifier pass above already
	// rewrote the clone's table references to OLD names, so map the seed back.
	const ownRename = tableRenames.find(r => r.newName.toLowerCase() === declaredTableName);
	const seedTableName = ownRename?.oldName ?? declaredTableName;
	if (seedTableName.toLowerCase() === tableName.toLowerCase()) continue; // owning table: seeded loop above
	for (const r of renames) {
		renameColumnInAst(clone.expr!, seedTableName, r.newName, r.oldName, schemaName);
	}
}
```

Forward-parity notes (load-bearing — the reconcile must predict exactly what
`rewriteTableForColumnRename` does):
- Non-owning tables forward-rewrite via plain `renameColumnInAst` (NO seed frame, NO resolver) —
  the inverse must use the same walker, NOT `renameColumnInCheckExpression`. An unqualified ref
  only rewrites when the renamed table sits in an enclosing FROM frame, which is exactly right for
  subquery references.
- `tableName` (the function's param) is the ACTUAL (old) owning-table name, so comparing
  `seedTableName` against it skips the owning entry correctly even when the owning table was
  itself renamed.
- ORDER MATTERS: owning-table seeded inverse FIRST, cross-table loop SECOND. With the reverse
  order, a compound diff (owning `qty→cap` + referenced `lim.cap→capacity`) has the cross loop
  turn the inner `capacity` back into `cap`, which the owning inverse then falsely captures.
  Owning-first leaves the inner ref spelled `capacity` (no match) until the cross loop fixes it.
  Current code already has the owning loop in place; just append the cross loop after it.

`renameColumnInAst` is already imported in schema-differ.ts (used by the view reconcile).

### Gap B: declared-side ResolveColumnInSource for the owning-table seeded calls

Build a resolver in `computeSchemaDiff` (where `declaredTables` and `tableRenames.renames` are in
scope) and thread it through `computeTableAlterDiff` into `reconciledDeclaredBody`, passing it as
the 6th arg of the owning-table `renameColumnInCheckExpression` calls:

```ts
const targetSchemaLower = targetSchemaName.toLowerCase();
const resolveDeclaredColumn: ResolveColumnInSource = (schema, table, column) => {
	if (schema !== targetSchemaLower) return false; // single-schema catalog; cross-schema stays conservative (benign churn)
	const declaredName = tableRenames.renames.find(r => r.oldName.toLowerCase() === table)?.newName.toLowerCase() ?? table;
	const dt = declaredTables.get(declaredName);
	return dt?.tableStmt.columns.some(c => c.name.toLowerCase() === column) ?? false;
};
```

Why DECLARED column sets (not the actual catalog): the walk's match target (`state.oldCol` in the
inverse direction) is the rename's **NEW** column name, and the question being answered is "in the
declared world, does this inner FROM source expose that name (so the unqualified ref binds there,
not to the owning seed)?". The walk's `realSources` carry OLD table names (the qualifier pass runs
first) and the resolver receives the resolved lowercase schema — hence the old→new table-name
mapping inside. The owning loop runs before the cross loop, so inner refs still spell declared
names when the resolver is consulted — consistent.

Parameter plumbing: `computeTableAlterDiff` / `reconciledDeclaredBody` already take 7 params; if
adding the resolver tips the signature into noise, bundling `tableRenames` / `schemaName` /
`columnRenamesByTable` / resolver into a small `ReconcileContext` object is a reasonable refactor
— implementer's call.

### Accepted limitations (document, don't chase)

- Pathological rename interleavings (e.g. another table's rename NEW name equal to the owning
  table's OLD name combined with correlated unqualified refs) may still churn benignly — the same
  scope-naïveté class the forward `renameColumnInAst` documents ("file a follow-up if it
  surfaces"). Churn fails safe to drop+recreate; convergence is unaffected.
- Cross-schema FROM sources: resolver returns false (catalog is single-schema) → possible benign
  churn where the forward path (live schemaManager lookup) would not rewrite. Note in the doc
  comment.
- Partial-index WHERE predicates: out of scope — backends reject cross-table references in index
  predicates at create time, and `declaredIndexCanonicalBody`'s seeded call cannot hit gap B (a
  collision needs a subquery FROM, which is likewise rejected).
- The view `insert defaults` reconcile (`inverseRenamedViewParts` ~1127) calls
  `renameColumnInCheckExpression` without the resolver while the forward
  `renameColumnInInsertDefaults` takes one — the same gap-B cousin. OPTIONAL stretch: thread the
  new resolver there too (2-line change); if skipped, mention it in the review handoff.

## TODO

- Add the cross-table inverse column-rename loop to `reconciledDeclaredBody` case `'check'`
  (after the owning-table loop), with a doc comment covering the new→old seed mapping, the
  owning-skip, the forward-parity rationale (plain `renameColumnInAst`, no resolver), and the
  ordering constraint; update the function's header comment (CHECK bullet).
- Build the declared-side `ResolveColumnInSource` in `computeSchemaDiff` and thread it to the
  owning-table `renameColumnInCheckExpression` calls in the CHECK branch; document the
  declared-column-set semantics and the cross-schema conservatism.
- Tests in `declarative-equivalence.spec.ts`, mirroring the cross-table TABLE-rename block
  (~3185-3328; same describe block — `diffOf` helper in scope), each asserting: no
  `constraintsToDrop`/`constraintsToAdd` churn (or churn, for the regression case), apply
  succeeds, stored CHECK body follows the rename(s), enforcement intact (accept + reject probes),
  idempotent re-diff:
  - pure cross-table column rename (`lim.cap → capacity`, CHECK on `a` follows)
  - cross-table TABLE rename + COLUMN rename on the referenced table in one diff
    (`lim → lim2` + `cap → capacity`)
  - scope: owning table has a like-named column (`a.cap` outer, `lim.cap → capacity` inner) —
    only the inner ref reconciles
  - gap B: owning rename whose NEW name collides with the referenced table's column
    (`a.qty → cap`, `lim.cap` referenced unqualified in the subquery) — no churn
  - compound ordering: owning rename + referenced-table column rename in one CHECK
    (`a.qty → cap` + `lim.cap → capacity`, declared `check (cap <= (select max(capacity) from lim))`)
  - REGRESSION: genuine body edit (`max` → `min`) layered on the cross-table column rename still
    drops+recreates and enforces the edited boundary
- Update `docs/schema.md` constraint body-change section (~564): the sentence "reuse the runtime
  `renameColumnInCheckExpression` rewriter seeded with the OLD (actual) table name" currently
  describes own-table-only column scope — extend to the owning-seeded-with-resolver +
  cross-table-`renameColumnInAst` shape, the ordering constraint, and the accepted limitations.
- `yarn lint` (packages/quereus), `tsc --noEmit`, full `yarn test` green.
