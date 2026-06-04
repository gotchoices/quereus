description: Generalize the multi-source inner-join write-through substrate from the two-table / single-column-PK cap to n-way (>2) inner equi-join chains, composite-key sides, and self-joins. This is the substrate generalization the outer-join and cross-source-set tickets layer onto — do it once, here.
prereq:
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md
----

## Why

The model in `docs/view-updateability.md` (§ Inner Join, § Cycles/Self-Joins, § Multi-Base-Table Mutations) specifies n-way decomposition, composite-key sides, and per-alias self-join routing, but the multi-source substrate (`multi-source.ts`) is hard-capped at **two distinct base tables, single-column PK per side**. Every richer columnar split (≥3 members) and every composite-PK or self-referential body a user reaches for is a clean diagnostic but still a "no". This ticket lifts the cap so the generic two-table-join path becomes an n-side path; the outer-join and cross-source-set tickets then layer their semantics on the generalized collection rather than re-generalizing it.

This ticket is **inner-join only**. Outer joins (`view-write-outer-join-static`) and cross-source `set` values (`view-write-cross-source-set`) are separate, prereq'd on this.

## Where the two-table cap lives today

The substrate threads a fixed `[JoinSide, JoinSide]` pair end to end. The cap is realized in:

- `collectInnerJoinSources` (`multi-source.ts`) — rejects `out.length !== 2` and any self-join (`out[0].name === out[1].name`).
- `JoinViewAnalysis.sides: readonly [JoinSide, JoinSide]`, `OutColumn.sideIndex`, `applyTargetExclude([0,1], …)`, `decomposeUpdate`'s `perSide: [[],[]]` and `order = orderSides(...)`.
- `requireSingleColumnPk` — rejects `pk.length !== 1` (the composite-PK reject).
- `MS_UPDATE_KEYS_CTE` key columns `MS_UPDATE_KEY_COLUMNS = ['k0','k1']` (a fixed two-entry tuple), `buildCapturedKeySubquery(sideIndex)`, `buildMultiSourceKeyCapture(... sideIndices)` projecting `k<side>`, and the UPDATE RETURNING re-query's `(k0,k1)` EXISTS join (`buildMultiSourceUpdateReturning`).
- `extractJoinKeyColumns` (insert) — returns a single `[string, string]` from one `a.col = b.col` ON predicate.
- `anchorSideIndex`, `fkChildIndex`, `orderSides` — binary FK ordering. `orderDeleteFanout` / `joinCorrelatesMutualFk` — the two-side mutual-FK delete analysis.
- Side↔planned-`TableReferenceNode` matching in `analyzeJoinView`: `[...tableRefsById.values()].find(r => r.tableSchema.name === name)` — **breaks for self-joins** (two refs share one table name).
- `view-mutation-builder.ts`: `capturedSideIndices`, `buildIdentityCapture` (`sides = hasReturning ? [0,1] : …`), the `(k0,k1)` RETURNING wiring.
- `func/builtins/schema.ts` `isDecomposableJoinBody` shadow (already rejects >2 / self-join) — must widen in lock-step so `view_info` / `column_info` keep agreeing with the dynamic truth.

## Target architecture

Replace the `[JoinSide, JoinSide]` pair with an ordered `readonly JoinSide[]` (length ≥ 2). Each `JoinSide` keeps `{ table: TableReferenceNode, schema, alias }`; routing stays keyed by side **index**, but the index space is now `0..n-1`.

### Self-join: alias-keyed side mapping

A self-join references one base table under two (or more) distinct aliases, so the by-table-**name** side match is ambiguous. The planned body resolves alias-qualified columns through the join's combined scope (`ctx.outputScopes.get(joinNode)` — a recursive `MultiScope` over every source). Map each AST source's **alias** to its planned `TableReferenceNode` by resolving the alias-qualified rowid/PK column through that scope to its producing attribute → `TableReferenceNode` (the same scope the body's own projections resolved against), rather than matching on `tableSchema.name`. Keep a `sideByAlias` map alongside `sideByTableId`; a column's owning side is decided by its lineage's producing `TableReferenceNode` **id** (unambiguous post-plan, since each alias is a distinct scan node), so `OutColumn.sideIndex` routing is already id-driven and survives — only the *source enumeration* (alias→side) needs the fix. Serialize per-alias ops in **alias-declaration order** (§ Cycles, Self-Joins) — the AST source order the collection walks.

### Composite keys: per-side key tuples

Generalize `requireSingleColumnPk(side): string` → `requireKeyColumns(side): string[]` (the side's `primaryKeyDefinition` columns, ≥1). The identity capture projects one capture column **per side per PK column**: name them `k<side>_<j>` (`MS_UPDATE_KEY_COLUMNS` becomes a generator, not a constant). The per-side identifying predicate changes from `pk in (select k<side> from __vmupd_keys)` to a correlated **EXISTS** over the capture matching all PK columns:

```
exists (select 1 from __vmupd_keys k
        where k.k<side>_0 = <side>.<pk0> and k.k<side>_1 = <side>.<pk1> [and …])
```

(A row-value `IN` would also work but EXISTS reuses the existing `buildMultiSourceUpdateReturning` correlation shape — keep one pattern.) The capture relation's `keyColumns` shape, `makeMultiSourceKeyRef`, and the `InternalRecursiveCTERefNode` key attrs all widen to the flattened per-side-per-column list.

### n-way fan-out ordering

Generalize `orderSides` to a topological order over the n sides by declared FK edges (FK-parent before FK-child), falling back to source order within an FK-equivalence class (§ Multi-Base-Table Mutations rule 1–2). `fkChildIndex` (binary) becomes a per-edge FK lookup feeding the topo sort. **Delete-ordering analysis stays two-side** per the ticket's out-of-scope note: an n-way delete uses the FK topo order plus the existing runtime RESTRICT pre-check; the plan-time `mutual-fk-restrict-delete` / `orderDeleteFanout` / `joinCorrelatesMutualFk` analysis is only invoked for the two-side fan-out and is **not** generalized here (a >2-table delete that would trip a mutual-FK cycle defers to the runtime pre-check). Document this boundary in the delete code.

### Multi-equi-join INSERT key extraction

`extractJoinKeyColumns` must walk **all** ON conjunctions across the nested `JoinNode`s (and handle `JoinNode.usingColumns` / natural-join desugaring — `buildJoin` stores `usingColumns` and leaves `condition` undefined, converting USING to equalities only conceptually) to recover each member's shared-key column(s). For the insert envelope, the shared key threads through the equivalence class exactly as today (the EC is what `analyzeMultiSourceInsert` relies on); the generalization is recognizing the key columns across >2 members and composite keys. **Composite shared keys for the insert envelope remain deferred** (`unsupported-decomposition-key` parity — the envelope threads a single shared-key value; see § Current limitations "Composite shared keys"). So: composite-PK **identification** (update/delete capture) is admitted here; composite **shared-key insert** stays rejected. Keep that split explicit.

### Static surfaces

Widen `isDecomposableJoinBody` (`func/builtins/schema.ts`, the boolean shadow) to accept ≥2 distinct inner-join tables, composite PK, and self-joins (alias-distinct same-table) so `view_info` / `column_info` agree with the now-wider acceptance. The outer-join body-level all-`NO` gate is untouched here (it relaxes in `view-write-outer-join-static`).

## Out of scope (defer / keep rejecting)

- Outer joins — `view-write-outer-join-static`.
- Cross-source `set` values — `view-write-cross-source-set`.
- Composite **shared-key insert** envelope (multi-column surrogate) — stays `unsupported-decomposition-key`.
- n-way mutual-FK delete-cycle plan-time analysis beyond the existing two-side rule — defers to runtime RESTRICT pre-check.

## Tests (acceptance gate: `test/property.spec.ts` § View Round-Trip Laws → `describe('multi-source inner join')`)

Add to the multi-source family, each with PutGet / GetPut / forward-backward lineage agreement over a planned tree that surfaces the shape:

- **Composite-PK inner join.** Two tables each with a 2-column PK joined on the shared key; an update keyed on the composite PK binds the correct base rows; round-trip green. Flip the current `rj_comp` negative (`expectMutationReject('update rj_comp …','unsupported-join')`, property.spec ~L3461) to an accept + round-trip.
- **n-way (≥3) inner join.** A 3-table columnar split (anchor + two members) written through one update touching each member; FK-ordered base ops; round-trip green.
- **Self-join.** `t` aliased twice (`create view v as select a.x, b.y from t a join t b on b.k = a.fk`); update routes per alias, serialized in alias-declaration order, each observing the prior; round-trip green. Flip the current `rj_self` negative (property.spec ~L3459).
- **Negative self-test** still red on an injected violation (a key the forward walk claims that the backward identifying predicate cannot reconstruct).
- Shapes still deferred after this ticket continue to **reject** with their precise diagnostic: outer-join body (`unsupported-join` until the outer ticket lands), composite shared-key **insert** (`unsupported-decomposition-key`), cross-source `set` (`cross-source-assignment`).

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log` and `yarn workspace @quereus/quereus lint`.

## TODO

- Replace `[JoinSide, JoinSide]` with `readonly JoinSide[]` through `JoinViewAnalysis`, `decomposeUpdate`, `decomposeDelete`, `analyzeMultiSourceInsert`, and the builder; route by side index over `0..n-1`.
- Fix self-join source enumeration: map AST source alias → planned `TableReferenceNode` via the join's combined scope (not by table name); keep id-driven column routing.
- `requireSingleColumnPk` → `requireKeyColumns` (composite); generate per-side-per-column capture columns `k<side>_<j>`; switch the per-side identifying predicate to a correlated EXISTS over `__vmupd_keys`.
- Generalize `makeMultiSourceKeyRef` / capture `keyColumns` / `buildMultiSourceKeyCapture` / `buildCapturedKeySubquery` and the UPDATE RETURNING `(k0,k1)` EXISTS to the flattened per-side composite key shape.
- Generalize `orderSides` / `fkChildIndex` to an n-way FK topo sort; keep the two-side mutual-FK delete analysis two-side and document the boundary.
- Generalize `collectInnerJoinSources` to accept ≥2 inner tables and self-joins (alias-distinct); update `extractJoinKeyColumns` to walk all ON conjunctions / `usingColumns`; keep composite shared-key **insert** rejecting.
- Update `view-mutation-builder.ts` `capturedSideIndices` / `buildIdentityCapture` / RETURNING wiring for n sides + composite keys.
- Widen `isDecomposableJoinBody` (`func/builtins/schema.ts`) in lock-step; verify `view_info` / `column_info` agree.
- Add the property-spec shapes above; flip `rj_comp` / `rj_self` negatives to accepts; keep all other negatives red.
- Update `docs/view-updateability.md` § Inner Join / § Current limitations to reflect the new acceptance (composite-PK identification, n-way, self-join) and the residual deferrals (composite shared-key insert).
