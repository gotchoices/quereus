description: Review the generalization of the differ-side inverse table-rename reconcile (CHECK bodies and partial-index WHERE) from owning-table-only to ALL in-diff table renames, plus the 3 new equivalence tests.
files:
  - packages/quereus/src/schema/schema-differ.ts          # reconciledDeclaredBody case 'check' (~1080); declaredIndexCanonicalBody (~880) + call site (~487); doc comments at all three
  - packages/quereus/test/declarative-equivalence.spec.ts # 3 new tests after the "UNQUALIFIED ref under a pure table rename" guard (~line 2977)
  - packages/quereus/src/runtime/emit/alter-table.ts      # reference only: rewriteTableForTableRename — the forward all-tables loop this mirrors
----

# Review: cross-table rename reconcile in CHECK / index-predicate bodies (diff side)

## What was the bug

A CHECK (or partial-index WHERE) whose body references ANOTHER table — e.g. `check (qty <= (select max(cap) from lim))` — churned a benign drop+recreate when that other table was renamed in the diff, because `reconciledDeclaredBody` case `'check'` inverse-applied only the OWNING table's own rename, and `declaredIndexCanonicalBody` was threaded only the index's own table rename. The forward migration path (`rewriteTableForTableRename`) walks ALL tables, so the diff-side inverse must mirror that scope.

## What changed

1. **CHECK** (`reconciledDeclaredBody` case `'check'`, schema-differ.ts ~1086): the single `selfRename` find/if was replaced with a loop applying the inverse of EVERY in-diff rename (`renameTableInAst(clone.expr, r.newName, r.oldName, schemaName)` for each). The OLD-seeded column-rename loop below is unchanged — cross-table renames never alter the seed (`tableName` is already the owning table's actual/OLD name).
2. **Index** (`declaredIndexCanonicalBody` ~880): parameter changed from `tableRename: RenameOp | undefined` to `tableRenames: ReadonlyArray<RenameOp>`; the WHERE clone now loops all renames; the index's OWN rename lookup (for the column-rewrite seed) moved from the call site into the function (matched by `r.newName === indexStmt.table.name`, case-insensitive); clone guard is now `colRenames.length > 0 || tableRenames.length > 0`. Call site (~487) passes `tableRenames.renames` directly.
3. **Doc comments** updated at `reconciledDeclaredBody`, `declaredIndexCanonicalBody`, and the index-loop call site: all-renames scope, the sequential-application safety rationale (see below), and the index cross-table unreachability note.

## Safety argument worth re-verifying

Sequential in-place application of multiple inverse renames over one clone is order-independent because `resolveRenames` (schema-differ.ts ~661) makes rename chains and swaps unrepresentable: every rename's `newName` is absent from the actual catalog while every `oldName` is present, so no inverse output (`oldName`) can ever match another inverse input (`newName`). This argument is stated in the doc comments — confirm it holds against `resolveRenames`' actual conflict rules.

## Tests added (declarative-equivalence.spec.ts, after ~line 2977)

- **`a CHECK whose subquery references ANOTHER renamed table emits ONLY the rename`** — pure cross-table rename: no constraint churn, forward propagation rewrites the stored body to `lim2`, enforcement still works, re-diff empty.
- **`a CHECK referencing the OWNING and ANOTHER table, both renamed in one diff`** — both halves at once (`a.qty` self-qualifier + `from lim` subquery): no churn, both stored references follow, converges.
- **`REGRESSION: a genuine CHECK edit layered on a CROSS-table rename still drops+recreates`** — `max(cap)` → `min(cap)` layered on the rename: `chk` drops+recreates, edited boundary enforces (min=3: 3 passes, 5 rejects), converges.

## Validation run

- Full `yarn test` at repo root green (quereus core 5577 passing; declarative-equivalence 108 passing = 105 prior + 3 new); `yarn lint` in packages/quereus clean; `tsc --noEmit` clean.

## Known gaps / honest flags for the reviewer

- **No test covers the index path's cross-table generalization.** The ticket documented (and I confirmed in the doc comment) that the memory backend rejects subqueries — and any cross-table ref — in partial-index predicates at create time (`src/vtab/memory/utils/predicate.ts:66`), so a cross-table name cannot exist in an actual catalog index and no end-to-end repro is constructible. The ticket offered an optional differ-level test feeding `computeSchemaDiff` a hand-built `SchemaCatalog`; I took the explicitly-allowed alternative of skipping it and noting the unreachability in the doc comment. The index change is exercised indirectly: every existing partial-index rename test now flows through the new all-renames loop (own rename is just one iteration), and those all pass. A reviewer who wants belt-and-braces could add the hand-built-catalog test.
- **Accepted scope-naïveté** (pre-existing, now per-rename): `renameTableInAst` is scope-naive about a subquery alias equal to a renamed table's NEW name — worst case a spurious but valid recreate. Symmetric with the forward path; documented.
- The new tests assert on `chk.definition` regexes (`/from lim2/i` etc.) — stable against the canonical stringifier, but worth a glance if the renderer ever changes spacing.
