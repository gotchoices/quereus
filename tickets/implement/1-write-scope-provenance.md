description: Classify, for every column a write statement produces, where the value comes from (a literal, a statement input, a fresh unique-per-call function, a clock or random source, the row's own previous values, or other rows), and let a module register its own function as a fresh source — the groundwork for telling a host which queued writes another writer could make fail.
architecture: docs/change-scope.md
files: packages/quereus/src/planner/analysis/value-provenance.ts (new), packages/quereus/src/planner/analysis/non-det-functions.ts (new), packages/quereus/src/common/constants.ts, packages/quereus/src/func/registration.ts, packages/quereus/src/func/builtins/scalar.ts, packages/quereus/src/planner/nodes/insert-node.ts, packages/quereus/src/planner/nodes/update-node.ts, packages/quereus/src/planner/nodes/dml-executor-node.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/test/optimizer/value-provenance.spec.ts (new), docs (wherever the scalar-function registration options `deterministic` / `replicable` are documented)
difficulty: medium
----

This is the first of three tickets that together give a host and a virtual-table module a description of a write statement. The second (`write-scope-analyzer`) builds the statement-level `WriteScope` and `Statement.getWriteScope()`; the third (`write-scope-module-hook`) hands that description to the module through `UpdateArgs`. This ticket ships an internal analysis module only — no public API — so nothing here needs a placeholder.

## What "provenance" means

A write statement produces a value for every column of the row it writes (INSERT: every table column, including defaults and generated columns; UPDATE: every assigned column, including generated recomputes). The provenance of such a value answers one question for a conflict predictor: *could a second writer, acting on newer state, make this value collide or go stale?* The classes, from most to least benign:

```ts
// packages/quereus/src/planner/analysis/value-provenance.ts
export type ValueProvenance =
	/** A constant. `value` is present when the expression is a single literal; absent when several literals were joined (multi-row VALUES) or the constant is computed from literals. */
	| { readonly kind: 'literal'; readonly value?: SqlValue }
	/** A deterministic function of statement inputs and literals: bound parameters and/or mutation-context variables (`with context`). */
	| { readonly kind: 'input'; readonly parameters: ReadonlyArray<number | string>; readonly contexts: ReadonlyArray<string> }
	/** Unique per call with at least 128 bits of entropy — a call to a function flagged FRESH, or an injective wrapper over exactly one such call (see the join rule). `function` is the lowercased name of the fresh call. */
	| { readonly kind: 'fresh'; readonly function: string }
	/** Depends on a clock, a non-fresh random source, or a volatile UDF — plus possibly inputs and literals. Not unique per call. */
	| { readonly kind: 'volatile'; readonly sources: ReadonlyArray<NonDetSource> }
	/** Depends on the target row's own previous values (`set n = n + 1`, an upsert arm reading the existing row) — plus possibly anything above. `columns` lists the previous-value columns read. */
	| { readonly kind: 'self'; readonly columns: ReadonlyArray<string> }
	/** Depends on other rows (a subquery, an INSERT … SELECT source column, a join), or anything the classifier cannot describe. The conservative fallback. */
	| { readonly kind: 'other' };

export interface WrittenColumn {
	readonly column: string;        // lowercased table column name
	readonly provenance: ValueProvenance;
}
```

`NonDetSource` is the existing type from `change-scope.ts`; reuse it. Move the `KNOWN_TIME_FUNCS` / `KNOWN_RANDOM_FUNCS` mapping out of `change-scope.ts` into a small new file `planner/analysis/non-det-functions.ts` exporting `classifyNonDetFunction(name: string): NonDetSource`, and import it from both analyzers so they never disagree on which builtin is a clock. (`change-scope.ts` is already 1,136 lines and `tickets/backlog/debt-oversized-source-files.md` tracks the theme; do not grow it.)

## The fresh flag

Add `FunctionFlags.FRESH = 0x000400000` (the next free bit; existing bits are `0x800`, `0x80000`, `0x200000`). Meaning: *every call returns a value that is unique with at least 128 bits of entropy, regardless of arguments.* It is a promise the registrant makes; the engine does not verify it.

Registration: the scalar-function option objects in `func/registration.ts` (`ScalarFuncOptions` and the sibling option interfaces that also carry `deterministic`) gain `fresh?: boolean`. `fresh: true` sets `FunctionFlags.FRESH` and clears `DETERMINISTIC` (a fresh function is non-deterministic by definition). `fresh: true` together with `deterministic: true` is a contradiction — throw `MisuseError` at registration. Document the option where `deterministic` and `replicable` are documented.

Builtins: none is flagged FRESH. `randomblob(n)` is fresh only when `n ≥ 16`, which depends on the argument, so it does not meet the flag's "regardless of arguments" bar. The classifier instead carries one named builtin rule: a `randomblob` call whose single argument is a literal integer ≥ 16 classifies as `fresh`; with a smaller or non-literal argument it classifies as `volatile` with source `{kind:'random'}`. State this rule in the doc. `random()` (64-bit) is `volatile`, never fresh.

## Join rule (bottom-up over a scalar expression)

Leaves:

- `LiteralNode` → `literal` with its value.
- `ParameterReferenceNode` → `input` with that parameter.
- A `ColumnReferenceNode` whose attribute is a mutation-context attribute (`contextAttributes` / `contextDescriptor` on the DML node) → `input` with that context name.
- A `ColumnReferenceNode` to the target row's previous values (UPDATE: the `source` relation's attributes, which is what SET and WHERE expressions bind to — see `buildUpdateStmt`'s `tableColumnScope`; upsert DO UPDATE: `existingRowDescriptor`) → `self` with that column.
- A `ColumnReferenceNode` to a NEW-row attribute of the same write (INSERT generated columns and defaults read earlier projections; upsert DO UPDATE reads `newRowDescriptor`) → the provenance already computed for that column (resolve through the environment; a cycle, which the builder's topological ordering should make impossible, resolves to `other`).
- Any other `ColumnReferenceNode` (an INSERT … SELECT source column, a join side) → `other`.
- `ScalarSubqueryNode`, `InNode`, `ExistsNode` → `other`.
- `ScalarFunctionCallNode`: FRESH flag set (or the `randomblob` rule) → `fresh`; else DETERMINISTIC not set → `volatile` with the function's `NonDetSource`; else a deterministic function → combine its arguments as an operator (below).

Operators (`BinaryOpNode`, `UnaryOpNode`, `CaseExprNode`, `CastNode`, `WriteCoercionNode`, `CollateNode`, `BetweenNode`, deterministic function calls): combine the operand provenances by rank, `literal < input < fresh < volatile < self < other`, taking the highest rank present and unioning the detail arrays (`parameters`, `contexts`, `sources`, `columns`) of every operand that carries them. One exception keeps `fresh` sound: a `fresh` operand survives an operator only when the operator is an **injective wrapper** — `hex`, `lower`, `upper`, `CastNode`, `WriteCoercionNode`, `CollateNode`, or `||` with the other operand a `literal` — and the fresh operand is the operator's only non-literal operand. Any other operator over a fresh operand (`substr(randomblob(16), 1, 4)`, `randomblob(16) || :p`, `abs(StampId())`) yields `other`, because a non-injective function of a unique value is not unique. `fresh + volatile` and `fresh + self` therefore never arise: the fresh operand is demoted to `other` first.

Record the allowlist as a single exported constant with a `NOTE:` naming the revisit condition (a module that needs another wrapper recognised).

## Where the column expressions come from

Expose three entry points; the analyzer ticket calls them.

- `classifyInsertColumns(node: InsertNode): WrittenColumn[]` — one entry per table column in schema order. The NEW row is `node.source`'s output; walk the `ProjectNode` chain the insert builder stacks over the `ValuesNode` (or the SELECT) to find the expression defining each output attribute: user-supplied values, `expressionDefaultCols` defaults, and generated-column projections are all ordinary projections. A reference that resolves to a `ValuesNode` attribute classifies every row's cell for that column and joins them (two different literals join to `literal` without `value`). A reference that bottoms out in any other relational node is `other`.
- `classifyUpdateColumns(node: UpdateNode): WrittenColumn[]` — one entry per assignment, in assignment order. For an `isGenerated` assignment, a column reference to a source attribute of column `c` resolves to the provenance of `c`'s own non-generated assignment when one exists (the runtime evaluates generated recomputes against the post-assignment row), else to `self`.
- `classifyUpsertUpdateColumns(clause: UpsertClausePlan, insertColumns: ReadonlyArray<WrittenColumn>): WrittenColumn[]` — the DO UPDATE arm's assignments; `newRowDescriptor` references resolve to `insertColumns`, `existingRowDescriptor` references to `self`.

`classifyExpression(expr, env)` is the shared core; `env` maps attribute ids to one of `self(column)`, `new(column)`, `context(name)`.

## Edge cases & interactions

- **Multi-row VALUES with mixed provenance per column** (`values (1), (:p)`) — join across rows: `input` here. Spec case.
- **Default expression on an omitted column** (`id blob default (randomblob(16))`) — must classify `fresh`; this is the shape an offline-first app uses for its ids. Spec case.
- **Generated column over a parameter column** (`total generated always as (qty * price)`, `qty` from `:q`) — `input`. Spec case.
- **Context variable** (`insert … with context now = datetime('now') values (…, now)`) — `input` with `contexts: ['now']`, not `volatile`: the context value is evaluated once per statement, and the classifier reports the variable, not its definition. Spec case. Note in the doc that the host can classify the context definition itself from the statement text if it needs to.
- **`set n = n + 1`** — `self` with `columns: ['n']`. **`set x = :p`** — `input`. **`set x = (select max(x) from t)`** — `other`. Spec cases for the three.
- **INSERT … SELECT** — columns that are projected literals/parameters classify as such; source column references are `other`. Spec case with one of each.
- **Fresh wrapper allowlist** — `hex(randomblob(16))` → `fresh`; `substr(randomblob(16), 1, 4)` → `other`; `randomblob(8)` → `volatile`. Spec cases. A module-registered `fresh: true` function (register one in the spec) → `fresh`; registering `fresh: true, deterministic: true` throws. Spec case for the throw: it pins a contract on real branching.
- **Cast inserted by the planner** — the insert builder wraps every value in `WriteCoercionNode`; the classifier must look through it (it is in the injective allowlist). Verified by every insert case implicitly; name it in a comment.
- **Reference into a CTE or a sunk data-modifying CTE** — `other`. By inspection.
- **Attribute-id resolution** — the classifier is called on the logical plan the builder produced (the analyzer ticket captures it before optimization), so attribute ids are the builder's. Assert at the seam: an attribute id that is neither in the environment nor defined by any walked projection classifies `other` (never throw).

## Tests

One spec, `test/optimizer/value-provenance.spec.ts`, building plans the way `test/optimizer/change-scope-analyzer.spec.ts` does (parse → `buildBlock`; `optimizeForAnalysis` is not needed — walk the built `BlockNode` to the `InsertNode` / `UpdateNode` and call the classifier directly). Table-driven: each row of the table is one of the cases named above with its expected `ValueProvenance`. That is one test per behaviour at the lowest layer that exercises it.

## TODO

- Add `FunctionFlags.FRESH`; add `fresh?: boolean` to the scalar registration options; set/clear flags; `MisuseError` on `fresh` + `deterministic`; document the option.
- Extract `classifyNonDetFunction` into `planner/analysis/non-det-functions.ts`; make `change-scope.ts` use it.
- Write `planner/analysis/value-provenance.ts`: types, environment, `classifyExpression`, the join rule with the injective allowlist constant, the `randomblob` rule, and the three entry points.
- Write the spec; run `yarn workspace @quereus/quereus test` and `yarn lint` from `packages/quereus`.
