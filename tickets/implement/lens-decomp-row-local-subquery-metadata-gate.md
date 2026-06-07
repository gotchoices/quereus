description: Harden the lens decomposition per-op constraint gate against subquery-bearing row-local CHECKs. The `writeRowColumns` AST walker under-collects a correlated bare write-row ref that appears only *inside* a subquery (it assumes such refs resolve against the subquery's own FROM, an invariant the prover does not guarantee — `classifyCheckConstraint` classifies any scalar CHECK over reconstructible columns as `enforced-row-local`, subqueries included). Replace the walker for the row-local class with prover-supplied metadata: `collectLensRowLocalConstraints` enumerates the source CHECK's referenced logical columns, maps them to basis columns, and attaches them to the synthesized constraint as `referencedWriteRowColumns`. `constraintsForOp` prefers that metadata over the walk when present.
prereq:
files:
  - packages/quereus/src/schema/table.ts                              # RowConstraintSchema (~L436) — add optional referencedWriteRowColumns field
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # collectLensRowLocalConstraints (~L96) — attach metadata
  - packages/quereus/src/schema/lens-prover.ts                        # collectColumnRefNames (~L1421, private) — export for reuse
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # constraintsForOp (~L880) + writeRowColumns walker (~L917) — prefer metadata
  - packages/quereus/test/lens-put-fanout.spec.ts                     # surrogate-keyed decomposition fixtures (~L1429) — add the subquery-CHECK regression
  - docs/lens.md                                                      # § Enforcement by constraint class — note the metadata source for row-local gating
----

# Harden the lens decomposition constraint-gate against subquery-bearing row-local CHECKs

## Background

The per-op resolvability gate (`constraintsForOp` + the `writeRowColumns` AST walker, in
`view-mutation-builder.ts`) decides which lens-synthesized constraints ride which base op of a
decomposition fan-out. A constraint rides an op iff every **write-row** column it references resolves on
that op's target table; a constraint that resolves on no single member is deferred (silently not enforced,
matching the decomposition INSERT path), and one that resolves on exactly one member rides it.

`writeRowColumns` collects a constraint's write-row column refs as: (a) any `NEW.*` / `OLD.*`-qualified
column **anywhere** (including inside a subquery), plus (b) any **bare** (unqualified) column **not** inside
a subquery. Rule (b) deliberately ignores bare refs inside a subquery, on the stated assumption that they
resolve against the subquery's own FROM — and that the only class carrying bare write-row refs
(`enforced-row-local`) is **subquery-free** "by the prover's definition".

That invariant is **not** enforced by the prover. `classifyCheckConstraint` (`lens-prover.ts` ~L1062)
classifies *every* scalar CHECK over reconstructible (non-computed) columns as `enforced-row-local` — it
only errors on a computed-lineage column, never on a subquery. Quereus **supports** subqueries in CHECK
constraints (auto-deferred to commit). So a logical row-local CHECK such as

```sql
check (exists (select 1 from peer where peer.k = somecol))   -- somecol: a write-row column, bare, only inside the subquery
```

is classified `enforced-row-local`, enters `extraConstraints` via `collectLensRowLocalConstraints`, and on
a decomposition is gated by the walker. The walker, descending into the subquery with
`insideSubquery = true`, sees bare `somecol` and ignores it (rule b) — **under-collecting** the real
write-row dependency. The computed write-row set is then too small, so the gate keeps the constraint on a
member op whose target lacks `somecol`; `buildConstraintChecks` cannot resolve the correlated bare ref
there and throws `somecol isn't a column` at plan-build time — the exact original-bug class for this
(exotic, currently untested) shape. The failure is **loud** (a build-time `QuereusError`, never silent
data corruption) — which is why this is a hardening, not an emergency.

## Approach — prover-supplied metadata for the row-local class

Don't teach the AST walker which bare-in-subquery names are correlated (that needs the subquery's resolved
FROM columns — expensive, duplicative of the resolver). Carry the answer as **metadata** instead.

`collectLensRowLocalConstraints` (`lens-enforcement.ts` ~L96) already holds the logical→basis column `map`
(`logicalToBasisColumnMap(slot)`) and the source CHECK expr (`obligation.constraint.constraint.expr`, in
logical terms). It can enumerate the CHECK's referenced logical columns and map each to its basis column,
then attach the resulting **lowercased basis** column names to the synthesized `RowConstraintSchema`.
`constraintsForOp` then prefers that metadata over the AST walk when present.

### Why this is the right set of columns

For a row-local CHECK, every referenced **logical column of the table** is a write-row column (the CHECK is
evaluated on the projected write row). Enumerate refs with the prover's `collectColumnRefNames` (a
reflective AST walk that returns every `column` node's `.name`, qualifier-stripped) and keep only those
that `map.has(name.toLowerCase())` — i.e. the names that map to a basis column. That is exactly:
- the correlated bare write-row ref `somecol` → basis col → **included** (the bug the walker missed);
- a foreign ref like `peer.k` whose name is not a logical column of *this* table → `map.get` undefined →
  **excluded** (correct: it resolves against the subquery FROM, not the write row).

This matches the prover's own `classifyCheckConstraint`, which uses the same `collectColumnRefNames` +
logical-column-membership test to decide the obligation — so the gate's notion of "write-row column" stays
consistent with the prover's notion of "row-local".

### Type — a dedicated optional field, not `tags`

Add `referencedWriteRowColumns?: readonly string[]` to `RowConstraintSchema` (`schema/table.ts` ~L436).
`tags` is `Readonly<Record<string, SqlValue>>`; a string array is not cleanly an `SqlValue` (it would have
to be JSON-encoded and unsafely re-read — rejected as janky). A dedicated optional field is type-safe and
self-documenting. It is populated **only** on transiently-synthesized lens row-local constraints (never
persisted to the catalog, never seen by the declarative differ), so it adds no field to compare anywhere
else — confirm the differ / canonicalization path does not deep-equal it (it compares `expr` / `operations`
/ `name`, and lens-synthesized constraints never reach it).

### Gate wiring

In `constraintsForOp` (`view-mutation-builder.ts` ~L880):

```ts
const refs = c.referencedWriteRowColumns ?? writeRowColumns(c.expr);
```

`referencedWriteRowColumns` is lowercased basis names; `writeRowColumns` already returns a lowercased
`Set<string>`. Both are iterable — iterate and require every entry ∈ `opCols`. FK / set-level constraints
leave `referencedWriteRowColumns` undefined → fall back to the walk (their `NEW.*` / `OLD.*` qualifiers are
collected unambiguously by the walker anywhere, so the walk stays correct for them — keep it).

### Scope: row-local only

Only the row-local class gets metadata. The walker is correct for `NEW.*` / `OLD.*`-qualified refs (rule a
collects them inside subqueries too) and for the bare alias-qualified subquery-internal refs the FK / count
classes carry. Migrating the FK / set-level classes for uniformity is **out of scope** (keep the proven
walk; do not destabilize them). Add a code comment at the walker noting that the subquery-free assumption
now only ever applies to the FK / set-level classes — whose bare-in-subquery refs are genuinely
FROM-resolved — because the row-local class no longer reaches the walk.

## Edge cases & interactions

- **Subquery-bearing cross-member row-local CHECK (the headline fix).** A decomposition whose logical CHECK
  is `check (exists (select 1 from <other> where <other>.k = somecol))`, where `somecol` lives on a member
  op whose target the fan-out also writes. Pre-fix: under-collection → constraint threaded onto a member
  lacking `somecol` → `somecol isn't a column` build crash. Post-fix: metadata collects `somecol`'s basis
  name → gate threads it onto the member that owns `somecol` (single-member-resolvable → enforced) or
  defers it (cross-member → silently not enforced, matching INSERT). **Assert: no build crash**, and the
  correct enforce-vs-defer outcome.
- **Name collision (over-collection is safe).** A subquery ref qualified to another table whose column name
  *equals* a logical column of the write table (`peer.title` where `title` is also logical) is
  qualifier-stripped by `collectColumnRefNames` and falsely mapped → an extra basis name in the set. This
  **over-collects**, which only ever makes the gate *defer* a constraint it might have threaded — the safe
  direction (the gate's existing bias is toward defer/conservative; under-collection was the bug). Document
  this in a comment; it trades the old loud crash for a conservative deferral in a pathological corner. No
  separate test required, but the subquery regression above implicitly exercises a qualified inner ref.
- **Non-subquery row-local CHECK (the common path).** `check (title <> note)`, `check (length(title) < N)`,
  etc. — `collectColumnRefNames` returns the bare logical names, all map to basis cols, so the metadata set
  equals what the walker's rule (b) produced. **Behavior is byte-identical**; existing decomposition and
  single-source CHECK tests must still pass unchanged.
- **Single-source spine.** Exactly one base op carries all basis columns → every referenced col resolves →
  the constraint rides it (metadata or walk, same result). Unchanged.
- **Constant / column-free CHECK (`check (1=1)`).** `collectColumnRefNames` yields no mapped names →
  `referencedWriteRowColumns = []` → resolvable on every op (rides all), matching the walker's empty-set
  behavior. Harmless (fires identically on every member).
- **Computed-lineage column.** The prover errors at deploy (`lens.unrealizable-constraint`) before any
  write reaches the gate — not reachable here.
- **DELETE.** Row-local CHECKs are excluded from a DELETE's `extraConstraints` (delete only threads the
  parent-side FK), so the metadata path is never hit on delete. No interaction.
- **`collectColumnRefNames` export.** It is currently a private duplicate in both `lens-prover.ts` and
  `lens-compiler.ts`. Export the `lens-prover.ts` copy and import it into `lens-enforcement.ts`
  (which already imports `resolveSlotBasisSource` from there). Consolidating the `lens-compiler.ts`
  duplicate into the same export is **optional** DRY cleanup — do it only if it stays a trivial diff;
  otherwise leave it and note the duplication.
- **`rewriteToBasisTerms` is unchanged.** This ticket only changes *which columns the gate believes the
  constraint depends on*, not how the CHECK is rewritten. The qualifier-strip behavior of
  `rewriteToBasisTerms` on subquery-internal refs is a separate (untouched) concern — do not modify it.

## TODO

- Add `referencedWriteRowColumns?: readonly string[]` to `RowConstraintSchema` in `schema/table.ts`, with a
  doc comment scoping it to lens-synthesized row-local constraints (transient, never persisted).
- Export `collectColumnRefNames` from `schema/lens-prover.ts`.
- In `collectLensRowLocalConstraints` (`lens-enforcement.ts`), after `rewriteToBasisTerms`, compute the
  lowercased basis names by mapping `collectColumnRefNames(source.expr)` through the slot's
  `logicalToBasisColumnMap` (keep only mapped names) and set `referencedWriteRowColumns` on the pushed
  constraint.
- In `constraintsForOp` (`view-mutation-builder.ts`), prefer `c.referencedWriteRowColumns` over
  `writeRowColumns(c.expr)`. Update the `writeRowColumns` / `collectWriteRowColumns` doc comments to record
  that the row-local class is now metadata-gated and the subquery-free assumption only covers the FK /
  set-level classes.
- Add a regression in `test/lens-put-fanout.spec.ts`: a decomposition with a subquery-bearing logical CHECK
  whose correlated write-row column lives on a single member — assert the UPDATE **builds and runs** (no
  `isn't a column` crash) and enforces; plus a cross-member variant asserting deferral (no crash). Use the
  surrogate-keyed `Doc_core` / `Doc_body` / `Doc_meta` decomposition shape (~L1429) as the base.
- Update `docs/lens.md` § Enforcement by constraint class: note that row-local gating reads prover-supplied
  referenced-basis-column metadata (so a subquery-bearing row-local CHECK gates correctly), while the
  FK / set-level classes gate by the `NEW.*` / `OLD.*` walk.
- `yarn workspace @quereus/quereus build`, then `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log`, and `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
