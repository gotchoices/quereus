description: Reviewed & completed the `cross` per-branch mode on FanOutLookupJoinNode + emitter — a cross branch contributes the full Cartesian product per outer row (1:n lookups) while preserving the concurrent fan-out drive. Node + runtime only; no rule constructs a cross node yet (sibling `parallel-fanout-lookup-join-cross-rule`).
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, packages/quereus/src/planner/scopes/param.ts, packages/quereus/test/logic/02.1-bind-parameters.sqllogic, docs/runtime.md
----

## What landed

`'cross'` is a third `FanOutBranchMode`. A `cross` branch yields *n* rows per
outer row; the node emits the n-ary Cartesian product `(outer, b0_row, b1_row, …)`
with identical column/row order to the inner nested-loop chain it replaces.
Existing plans are byte-for-byte unchanged — no rule constructs a `cross` node
yet (recognition is the sibling `parallel-fanout-lookup-join-cross-rule` ticket).

### Node (`fanout-lookup-join-node.ts`)
- `'cross'` added to the `FanOutBranchMode` union; doc comments updated.
- Nullability/FD fold route `cross` through the existing `'inner'` (non-widening,
  empty-equi-pair) paths — verified by test.
- `computeEstimatedRows()` multiplies the outer estimate by each `cross` branch's
  `child.estimatedRows` (at-most-one branches ×1); a cross child with no estimate
  ⇒ ×1 for that branch, `undefined` outer ⇒ `undefined` overall.

### Emitter (`fanout-lookup-join.ts`)
- `composeOuterRow` + `DROP` sentinel replaced with `composeOuterRows(...) : Row[]`
  building per-branch factor lists and emitting the Cartesian product via an
  iterative odometer (right-most branch varies fastest = nested-loop order).
- `cross`/`atMostOne-inner` empty buffer ⇒ inner-drop (`[]`); `atMostOne-left`
  empty ⇒ single NULL-pad factor.
- `assertAtMostOne(...)` enforces the ≤1 invariant scoped to `atMostOne-*` only
  (`cross` exempt); used by both serial and batched drivers.
- Batched reorder buffer changed from `seq -> Row | DROP` to `seq -> Row[]`;
  window/backpressure accounting still advances per `seq`, independent of product
  fan-out.

## Review findings

**What was checked:** the full implement diff (read first, before the handoff);
node nullability / FD / estimate paths; the odometer composer (incl. zero-factor
and empty-buffer edge cases); both drivers' invariant scoping and reorder/window
accounting; the test suite (happy path, empty-drop, mixed-mode, >1-row,
concurrency, batched ordering, contiguous-emit, node-level estimate/nullability);
lint; full quereus test suite; and every doc/file the change touched plus the ones
it *should* have.

**Major (filed as new ticket): none.** No correctness defect found in the
cross-mode node or emitter. The composer, drivers, estimate and nullability logic
are correct; the test coverage is genuinely comprehensive (serial + batched +
node-level, including the load-bearing product-order and inner-drop cases).

**Minor (fixed in this pass):**
- *Doc staleness — `docs/runtime.md` § FanOutLookupJoinNode.* The branch-mode list
  omitted `cross`, still called it "deferred", and claimed "both modes share an
  `atMostOne` invariant" (now scoped to `atMostOne-*`; `cross` is exempt). The
  batched-driver bullet referenced the removed `DROP` sentinel, and the closing
  line referenced the renamed `composeOuterRow(...) → Row | DROP`. Updated all
  four to the new reality (cross mode added; invariant scoped; `composeOuterRows
  (...) → Row[]` with empty-array = drop).

**Notable — undisclosed scope creep (verified correct, intentionally NOT
reverted):** the implement commit also changed `planner/scopes/param.ts` plus
`test/logic/02.1-bind-parameters.sqllogic` — a positional-`?` binding-order fix
entirely unrelated to the cross-node feature and unmentioned in the handoff. It
makes positional `?` bind in **source-text order** (`parameterExpression.index`,
the parser's 1-based `parameterPosition++`) instead of plan-resolution order
(FROM/WHERE resolve before SELECT projection). I verified against the parser that
the new behavior is correct and that downstream keying (`boundArgs[index+1]`,
core/param type hints) agrees; it ships with three new sqllogic cases that pin the
text-order contract, and the full suite is green. Because the fix is correct and
tested, reverting it would re-introduce a real bug — so it stays. Flagged here only
because bundling an unrelated behavior-change into a feature commit is a process
smell; future implementers should split such fixes into their own ticket. (One
pre-existing latent edge, not worth a ticket: if a query mixes parser-stamped `?`
with index-less *synthetic* `?` nodes, the `?? this._nextAnonymousIndex` fallback
counter could collide with a parser index. Synthetic positional params are not a
real code path today.)

**Known gaps carried forward from implement (acceptable for a node-only ticket,
all to be addressed at recognition):**
- No rule constructs a `cross` node yet, so there is no end-to-end SQL coverage —
  only direct unit drives. Arrives with `parallel-fanout-lookup-join-cross-rule`.
- No runtime product-size guard: a large product materializes per outer row (and,
  in batched mode, peak ≈ readAhead × product-size in the reorder buffer) with no
  spill. By design — memory safety is a recognition-time concern; confirm the
  sibling rule's row/product guards before any rule emits `cross`.
- Per-outer-row CacheNode-reset refinement (the literal "hold no buffer"
  composition) is deferred; needs an emit-scoped reset hook that does not exist
  today. A clean future refinement, not a correctness prerequisite.
- FD precision unchanged (cross folds through `propagateJoinFds` with empty
  equi-pair lists, same conservative v1 behavior as at-most-one).
- Odometer allocates a fresh `Row` per product row; fine for bounded products,
  not optimized for very wide fan-outs.

## Build / test status (re-run during review)
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run build` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — 3509 passing, 10 pending (the
  documented strict-fork cases requiring `QUEREUS_FORK_STRICT=1`), 0 failing.
- `test:store` not run (no store-specific code path touched).
