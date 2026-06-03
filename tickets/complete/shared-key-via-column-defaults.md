description: COMPLETE — Collapsed the bespoke SharedKeyGenerator surrogate mechanism into the engine's column-default + equivalence-class machinery, plus a new `mutation_ordinal()` per-row context primitive. The shared key in a multi-source/decomposition insert is now sourced from the anchor key column's declared DEFAULT, evaluated once per row at the envelope and EC-threaded into every member. The integer-auto/uuid7/callback generator type, per-row/per-statement cadence, and the generator/gencadence reserved tags are gone. Reviewed, validated, and shipped.
files: packages/quereus/src/func/builtins/mutation.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/src/runtime/types.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/index.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/lens-access-routing.spec.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/runtime/fork-contract.spec.ts, docs/view-updateability.md, docs/lens.md, docs/architecture.md

## What landed

The shared key for a multi-table write-through (two-table key-preserving inner-join
insert, n-way lens decomposition insert) is no longer a parallel re-encoding of column
defaults. There is now **one policy**: source the value from the **anchor key column's
declared `default`**, evaluate it **once per produced row at the envelope**, and thread
the single value into every member's key column via the **equivalence class** the join
establishes. The engine chooses no ID policy of its own.

New primitive: `mutation_ordinal()` — nullary, deterministic, INTEGER, non-null builtin
returning the 1-based ordinal of the row being produced in the current statement. The
column-`default`-position analogue of `row_number()`. Set per row by the INSERT DML
executor (`stampMutationOrdinal`) and the shared-surrogate envelope. The canonical
monotonic-integer migration recipe (reconstructs the retired `integer-auto` mint) is
`default (coalesce((select max(<key>) from <anchor>), 0) + mutation_ordinal())`.

Torn out: `SharedKeyGenerator` type + `SharedKey.generator`, the `integer-auto` mint
arithmetic + `ViewMutationNode.mint` (`MutationEnvelope.mint` → `keyDefault?: ScalarPlanNode`),
the `requireIntegerSurrogate` branches, the `quereus.lens.decomp.generator.<id>` /
`.gencadence.<id>` reserved tags + their closed value sets. `SharedKey.kind` was kept
(re-framed as a coverage fact, not a generation policy). Composite shared keys remain
deferred (`unsupported-decomposition-key`).

See the original implement handoff for the full torn-out / kept inventory.

## Review findings

Adversarial pass over commit `bd42a3c4`. Read the full diff across all 24 touched
files first, then scrutinized the scope-adjacent changes empirically.

### What was checked

- **Core mechanism** (anchor-default → evaluate-once-at-envelope → EC-thread) across
  `multi-source.ts`, `decomposition.ts`, `view-mutation-builder.ts`,
  `view-mutation-node.ts`, `emit/view-mutation.ts`. The `materializeEnvelope` rewrite
  evaluates `keyDefault` per row with `mutationOrdinal` set, against pre-mutation state
  (runs before `drainBaseOps`). Correct and monotonic. Save/restore of `mutationOrdinal`
  in both the envelope and `stampMutationOrdinal` is `finally`-guarded.
- **`mutation_ordinal()` builtin** — registration, custom-emitter dispatch (confirmed
  `emitScalarFunctionCall` routes to `customEmitter` before the default path),
  out-of-context error guard, determinism flag.
- **Constant-folding safety** — verified against `planner/analysis/const-pass.ts`:
  `physical.constant` is never inherited (only ValueNodes set it directly), and a
  functional node with **zero children** classifies `non-const` (the `childConstInfos.length > 0`
  guard). So a nullary `mutation_ordinal()` is never folded/hoisted. The handoff's claim holds.
- **Determinism re-validation coverage** — both the single-source insert expansion
  (`building/insert.ts:134`) and the envelope's `buildKeyDefault`
  (`view-mutation-builder.ts:525`) call `validateDeterministicDefault` (skipped only
  under `nondeterministic_schema`). No insert path skips the check; CREATE-time defers
  only on build failure that embeds a subquery, which is re-checked at insert.
- **Schema-manager guard relaxations** (`rejectIllegalReferences` subquery-depth tracking,
  `validateDefaultDeterminism` subquery-deferral) — read the code, confirmed the
  `traverseAst` `enter/exitNode` depth bookkeeping is correct (`select`/`subquery`/`exists`
  are the real AST node types), and **empirically probed** the behavioral envelope (below).
- **Removed-symbol sweep** — grepped `src` + `test` for `SharedKeyGenerator`, `.generator`,
  `DECOMP_GENERATOR_VALUES`, `DECOMP_CADENCE_VALUES`, `gencadence`, `requireIntegerSurrogate`,
  `.mint`, `seedTable`, `perStatementMint`. One dangling reference found (below).
- **Test quality** — confirmed `-- error:` directives in `.sqllogic` are real assertions
  (`logic.spec.ts:595-603`: requires a throw AND a message-substring match), so the
  rejection cases (e/f/g/h) genuinely exercise the reject paths. 93.4 Phase 2b spans
  happy path, allocate-above-existing, multi-row distinct, FK-parent-first ordering,
  non-deterministic capture-once-and-thread, supplied key, not-null reject, no-default
  surrogate reject, non-invertible, over-specified, and the plain single-source ordinal.
- **Fork policy** — `mutationOrdinal` declared `shared-frozen` in `parallel-driver.ts`
  `fork()`, with the fork-contract spec updated in lockstep.
- **Lint + full memory test suite** — re-ran after my inline fixes: `yarn lint` clean;
  `yarn workspace @quereus/quereus test` → **4447 passing, 0 failing, 9 pending**.

### Empirical adversarial probes (built dist/src, committed implementation)

1. `default (coalesce((select max(rid) from t),0) + mutation_ordinal())` on a **plain**
   table, 3-row insert → `[1, 3, 6]` (NOT `[1,2,3]`). This is the **documented** gotcha:
   a plain insert writes incrementally so `max()` already sees prior rows of the same
   statement, double-counting with the ordinal. The recipe is contiguous ONLY at the
   envelope (frozen pre-mutation snapshot). 93.4 case (i) correctly isolates
   `mutation_ordinal()` alone for the plain path, and the docs note the distinction.
   Confirmed behavior matches the documented contract — not a bug, but a sharp edge.
2. **Correlated subquery default referencing a sibling row column** (the chief risk of
   the `rejectIllegalReferences` relaxation): `b integer default ((select v from u where u.k = a))`
   → CREATE TABLE accepted, but the INSERT **errors loudly**: "Column not found: a".
   *No silent wrong results.* This was my main concern with the guard loosening; it is
   resolved — the relaxation only opens self-contained subqueries; illegal sibling/
   correlated refs still fail at insert.
3. Parameter nested in a subquery default → still rejected at CREATE ("may not reference
   bind parameters"). Top-level column ref in a default → still rejected ("may not
   reference columns"). Both guards intact at depth 0 / any depth respectively.

### What was found and done

- **Minor (fixed inline):** the `unknownReservedTag` "Recognized keys:" suggestion in
  `schema/reserved-tags.ts` still advertised the removed `generator,gencadence` tags —
  a user passing one would get "unknown reserved tag" *while the suggestion listed it*.
  Removed them from the suggestion string.
- **Minor (fixed inline):** two stale-terminology test artifacts — a `property.spec.ts`
  comment referencing the removed "`per-row` cadence mints afresh", and a
  `lens-put-fanout.spec.ts` test name "(no generator)". Reworded to the default-sourced
  reality. No behavior change; suite re-run green.
- **Major:** none. No new tickets filed.

### Residual risks (noted, not blocking — intentional/documented or no path exists today)

- `max()+mutation_ordinal()` yields non-contiguous keys on a **plain** table (probe 1).
  Documented, but a foreseeable footgun if the surrogate recipe is copied onto a plain
  table. Acceptable: docs + 93.4 case (i) call out the envelope-vs-plain distinction.
- `stampMutationOrdinal` assumes pull-driven, non-prefetched, 1:1 in-order source
  iteration. Correct for VALUES/SELECT inserts; an interposed prefetch/reordering node
  could decouple it — no such path exists today.
- No test exercises a **UDF-allocator** default (e.g. a registered `next_rid()`); the
  mechanism is generator-agnostic (it's an ordinary column default) but unproven by tests.
- No dedicated **statement-replay** byte-identical assertion; the change rides the
  pre-existing mutation-context capture infra (untouched here), exercised indirectly as
  "members agree on the captured value".
- **Composite shared keys** remain deferred (`unsupported-decomposition-key`) — the
  envelope threads a single appended `__shared_key` column; not in scope.
