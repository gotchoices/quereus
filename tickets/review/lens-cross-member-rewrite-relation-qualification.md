description: |
  Verify the fix that keeps a CHECK distinct when two storage tables (split from one
  logical table) happen to name their value columns the same — the rewrite now tags each
  column with the storage table that owns it instead of conflating the two.
prereq:
files:
  - packages/quereus/src/schema/table.ts                              # NEW: writeRowRelationCorrelation(schema, table) helper (~L581-599)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts         # makeLensRewriteScope / rewriteToBasisTerms / collectLensRowLocalConstraints now relation-qualify on multi-member decomposition
  - packages/quereus/src/planner/building/constraint-builder.ts       # per-op scope now also registers <corr(opSchema,opTable)>.<col> alongside new.<col> (~L95-125)
  - packages/quereus/test/lens-put-fanout.spec.ts                     # NEW unit test asserting relation-distinct rewrite (end of the colliding-fixture describe, ~L2937)
  - docs/lens.md                                                      # § Constraint Attachment — row-local CHECK + "Two consequences" notes now document relation-qualified rewrite
difficulty: medium
---

# Review: relation-qualify the lens logical→basis CHECK rewrite so colliding basis-column names stay distinct

## What this ticket fixed (the latent flaw)

On a **decomposition-backed** logical table whose two storage members give their value
columns the **same basis name** (e.g. `id`→`w_id.val`, `name`→`w_name.val`), a row-local
logical CHECK that mentions a column from each member — `check (id <> length(name))` —
used to rewrite **both** write-row terms to the structurally-identical `NEW.val`. The
`name`/`w_name.val` reference silently became `w_id.val`: the two columns (and their owning
members) collapsed into one.

It is **not a live bug today**: such a cross-member CHECK's `referencedWriteRowRelations`
span two members, so the per-op gate (`constraintsForOp`) rides it on **no** single member
op ⇒ it is deferred (never built, never evaluated) on a decomposition write. The collapsed
expression is therefore never executed. The trap is latent: if a future change ever
single-member-routed such a constraint, the collapsed `NEW.val`/`NEW.val` would silently
compute the wrong thing.

## What changed

The row-local CHECK rewrite is now **relation-qualified on a multi-member decomposition**:
each mapped write-row column is qualified by a **per-member synthetic correlation** instead
of bare `NEW`, so colliding basis-column names stay distinct.

1. **`writeRowRelationCorrelation(schema, table)`** (new, `schema/table.ts`) — returns
   `__lens_new__<schema>__<table>` (lowercased). The decomposition analogue of `NEW`;
   collision-proof (the `__lens_new__` prefix is not producible by a parsed user identifier,
   so a subquery FROM cannot shadow-capture it — which is exactly why the bare basis **table
   name** could NOT be used as the qualifier).

2. **Rewrite side** (`lens-enforcement.ts`): `makeLensRewriteScope` / `rewriteToBasisTerms`
   gained an `owningRelation` resolver + a `relationQualify` flag.
   `collectLensRowLocalConstraints` sets `relationQualify = members && members.length > 1`
   (multi-member decomposition only). For a mapped column on such a slot, `resolve` emits
   `{ name: basis, table: writeRowRelationCorrelation(rel.schema, rel.table) }`; otherwise it
   keeps the existing `table: 'NEW'`. The **authored-inverse forward** branch stays on `NEW`
   (its forwards are subquery-free single-source, never decomposition-ambiguous).
   **Single-source lenses are entirely unchanged** (no rewrite/behavior churn).

3. **Per-op scope side** (`constraint-builder.ts`): alongside `new.<col>`, the per-op
   constraint scope now also registers `<writeRowRelationCorrelation(opSchema, opTable)>.<col>`
   → the same `ColumnReferenceNode` (newAttrId), for the op's own target relation, whenever a
   NEW attribute exists (⇒ INSERT|UPDATE). This lets a **single-member** CHECK resolve its
   relation-qualified term on its owning op, while a **sibling/cross-member** term fails to
   resolve — a loud `Column not found` rather than a silent wrong answer (fail-safe).

Net effect: the rewrite is relation-distinct; single-member CHECKs still ride and enforce
exactly as before (now via the relation correlation instead of `NEW`, resolving
identically); cross-member CHECKs stay deferred by the gate, and if ever routed produce a
loud error rather than a silent wrong answer. **The cross-member deferral is now a
timing/perf choice, not a correctness necessity.**

## Validation performed

- `yarn workspace @quereus/quereus test` → **6376 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json --noEmit`) →
  **exit 0** (clean).
- Targeted `lens-put-fanout.spec.ts` + `lens-enforcement.spec.ts` → 273 passing, including:
  - **NEW unit (primary):** `a cross-member row-local CHECK rewrites to relation-distinct
    write-row terms (no NEW.val collapse)` — reuses the colliding `perColumnAd`/`setupPerColumn`
    fixture with `check (id <> length(name))`, asserts via `astToString` that the `id` term
    carries `__lens_new__main__w_id.val`, the `name` term carries `__lens_new__main__w_name.val`,
    and the result is NOT collapsed onto `new.val`.
  - **Behavioral regression (stayed green):** `a single-member row-local CHECK rides only its
    owning member` (`length(name) < 5`) still ABORTs a violating UPDATE on the `w_name` op and
    a key-only `set id` UPDATE still does NOT carry the name CHECK — proving the
    relation-qualified term resolves and fires on its owning op.
  - **Deferral (unchanged):** `defers a cross-member CHECK (title <> note)` still green.

## What the reviewer should scrutinize (honest gaps / risk areas)

- **Scope is row-local CHECK only.** The FK / set-level synthesizers
  (`collectLensForeignKeyConstraints` / `collectLensSetLevelConstraints`) still emit their
  write-row side as bare `NEW.*` (they build it directly, not via `rewriteToBasisTerms`).
  This matches the ticket scope (the originating fix research found the collapse is a
  row-local-CHECK-rewrite concern), and a cross-member FK/set-level key is itself deferred —
  but a reviewer may want to confirm there is no analogous latent collapse for a hypothetical
  cross-member FK/set-level expression that a future change could route. Making cross-member
  row-local CHECKs *fully evaluable* (over the joined logical row) remains **out of scope**;
  deferral stays the contract.

- **Partial-attribution edge.** On a multi-member decomposition where `owningRelation` cannot
  attribute *some* column (an EAV-pivot / opaque column), `relationQualify` is still true:
  the rewrite emits `<corr>.<basis>` for resolvable columns and `NEW.<basis>` for the
  unresolvable one, and `buildWriteRowRelations` returns `undefined` ⇒ the gate falls back to
  the bare-name `referencedWriteRowColumns` path. Verified by reasoning (the AST-walk
  `writeRowColumns` fallback is never reached for row-local, which always supplies
  `referencedWriteRowColumns`); no dedicated test exercises a partial-attribution decomposition.
  A reviewer could add one if they consider it load-bearing.

- **`relationQualify` gate is `members.length > 1`.** A degenerate single-member decomposition
  keeps `NEW` (no collision possible). Confirm this matches intent (no test covers a
  single-member decomposition CHECK explicitly).

- **Capture-safety.** Verified the synthetic correlation survives `resolve.ts`'s `table.column`
  path (`unqualifiedKey = <corr>.<col>`, lowercased) and `RegisteredScope`'s lowercased
  lookup, and that `astToString` renders `<corr>.<col>` unquoted (the name matches
  `/^[a-zA-Z_][a-zA-Z0-9_]*$/`). The existing single-source subquery-correlation tests cover
  the `NEW.` capture path; a **decomposition** subquery-correlation analogue was judged not
  cheap enough to add (the cross-member subquery CHECK is deferred anyway) — a reviewer may
  want one if they want belt-and-suspenders on capture-safety under decomposition.

## Docs

`docs/lens.md` § Constraint Attachment updated in two places: the row-local CHECK bullet now
documents the per-member synthetic correlation (and why the bare basis table name could not
be used), and the "Two consequences follow" paragraph notes the cross-member deferral is now
a timing/perf choice rather than a correctness necessity.
