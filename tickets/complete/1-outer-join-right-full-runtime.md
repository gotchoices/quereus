description: RIGHT/FULL outer-join runtime execution (read path) added to the nested-loop join emitter. Reviewed, hardened, and validated.
files: packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/join-output.ts, packages/quereus/src/runtime/context-helpers.ts, packages/quereus/test/logic/90.5-unsupported-join-types.sqllogic, packages/quereus/test/logic/90.5.1-right-full-join-read.sqllogic, packages/quereus/test/logic/11-joins.sqllogic, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/rules/join/rule-semijoin-existence-recovery.ts, docs/view-updateability.md
----

## What shipped

RIGHT and FULL outer joins now **execute** on the read path in the nested-loop
emitter (`runtime/emit/join.ts`). The emitter keeps the pre-existing left-driven
loop (`driveFromLeft`: inner/left/cross/semi/anti) byte-equivalent and adds a
right-driven loop (`driveFromRight`: right/full) that buffers the left side once,
iterates the right side as the outer driver, and — for FULL — runs a trailing
pass over unmatched left rows. The existence-flag rule was generalized from the
LEFT-only `spec.side === 'left'` to `flagsForDroppedSide(dropped)`, so the
`exists … as` flags fall out correctly for either null-extended side. Output row
order is invariant (`[...left, ...right (, ...flags)]`), so `select *` column
identity is preserved regardless of which side drives.

Write-through is deliberately untouched: RIGHT/FULL views stay read-only; the
downstream `view-write-right-join-readmit` ticket (already in `implement/`,
prereq = this) handles re-admission.

## Review findings

### Scope of the adversarial pass

Read the implement diff (`5c25c678`) fresh before the handoff. Scrutinized the
two loop shapes, the generalized flag rule, the runtime context/slot interaction,
USING semantics, the optimizer bail-outs (physical-selection / merge / bloom all
correctly skip right/full and existence joins), and every comment/doc the change
touched. Ran build, lint, the full memory suite, and a store-mode spot-check.

### Major findings → new tickets

**None.** The one genuine follow-on (write-through re-admission) was already
filed as `implement/2-view-write-right-join-readmit` with a prereq on this
ticket; no new ticket needed.

### Minor findings → fixed in this pass

1. **Slot-shadow fragility in `driveFromRight` (context-map correctness).**
   `slot.set()` updates only the slot's boxed row, **not** the `attributeIndex`
   (last-`context.set`-wins). Downstream operators (e.g. `emitProject`'s
   `sourceSlot` over the join's output attrs) resolve the join's left/right
   columns *through the context map*, which can still point at a buffered child's
   slot. Because `driveFromRight` fully drains the left child (and, for the FULL
   trailing pass, the right child) and then sets its own slot to other rows /
   null padding, correctness silently depended on those children **closing their
   slots on exhaustion** to trigger the `attributeIndex` rebuild back to the
   join's slot. Generator-based scans do close (hence the green suite), but this
   is the exact *child-shadows-operator* hazard that `emit/asof-scan.ts` already
   resolves with `RowSlot.reactivate()` (and locks with a regression test that
   produces wrong rows without it). Hardened `driveFromRight` to call
   `leftSlot.reactivate()` after buffering the left side and `rightSlot.reactivate()`
   before the FULL trailing pass, removing the implicit dependency. The fix is
   idempotent for the closing-child case (re-sets the same map entry) and
   matches the documented "source-attr contexts and child pulls" invariant
   (`docs/runtime.md`).

2. **Row aliasing when buffering the left side.** `driveFromRight` retained
   source row references (`leftRows.push(r)`) — it is the only driver that holds
   source rows beyond a single iteration. A source that reuses its row array
   across yields would alias every buffered entry; `driveFromLeft` is immune
   because it spreads each row immediately. The shared cache deep-copies for
   exactly this reason (`cache.push([...row])`, "deep copy to avoid reference
   issues"). Changed the buffer to copy on push (`leftRows.push([...r] as Row)`)
   for parity; cost is negligible against the already-O(L·R) nested loop.

   *Note:* both #1 and #2 are defensive hardening — no in-tree SQL source
   currently reuses arrays or leaves a slot installed after a clean drain, so
   neither is reproducible as a failing test through SQL today (the same reason
   the implementer flagged them as "belt-and-suspenders"). They were promoted
   from "defensive" to "applied" because each removes a load-bearing implicit
   dependency on child behavior and aligns with an existing, regression-tested
   precedent (asof-scan / shared-cache). The existing `90.5.1` cases already
   exercise the null-extension → downstream-projection resolution path and stay
   green.

### Handoff "gaps" investigated and dispositioned

- **MV materialization over RIGHT/FULL — non-issue (no path exists).** A
  materialized view over *any* outer join is rejected at create time
  (`materialized view … cannot be materialized: its body uses an outer join
  (only an inner/cross 1:1 join is row-time maintainable in v1)`). So there is
  no RIGHT/FULL MV refresh path to test; `collectBodyRows` is never reached for
  such a body. The `proveUnmaterialized` stub in `covering-structure.spec.ts` is
  therefore correctly scoped — it proves the coverage *prover's* `'right'` branch
  against the parsed AST, which is the only way that branch is reachable. Plain
  `create view` over a right join (live re-evaluation) **is** covered by
  `06.3.4-view-info.sqllogic`. Verified empirically with a throwaway probe
  (create-MV-over-right-join → rejection), then removed the probe.

- **`select *` column-order assertions.** Adequately pinned. The distinct-name
  cases in `90.5.1` are order-independent under deep-equal, but `11-joins`
  asserts the same shape with `:N` positional disambiguation (`id`, `id:1`),
  which *does* pin left-before-right column order. No additional assertion needed.

- **USING coalescing direction.** Not applicable — this engine does **not**
  coalesce USING join columns into one (`buildJoin` keeps both columns; see
  `building/select.ts`), so there is no coalesce-direction to get wrong on a
  null-extended right row. Behavior is consistent with the existing left/inner
  USING path.

- **Write-through untouched.** Confirmed: `multi-source.ts` still excludes RIGHT
  from recognition and FULL self-conservatizes; the static surfaces report
  RIGHT/FULL views all-`NO` and writes reject `cannot write through view`
  (`06.3.4-view-info.sqllogic`). The updated comments and `docs/view-updateability.md`
  accurately describe the new "read runs, write-through deferred" reality.

- **Stale-comment cleanups.** Reviewed each (semijoin-existence-recovery header,
  the two `multi-source.ts` rationale comments, the view-info test comments).
  All now correctly state that RIGHT/FULL *read* but write-through is deferred,
  and the semijoin rule's abstention-is-sound reasoning for right/full origins
  is accurate.

### Tests / edge cases checked

- Happy path + edges: column order, empty-side matrix (left-empty/right-empty/
  both-empty across RIGHT and FULL), no-match, many-to-many fan-out, USING,
  `exists … as` on RIGHT (single side) and FULL (both sides) — all in `90.5.1`,
  plus the basic RIGHT/RIGHT-OUTER/FULL-OUTER/FULL rows in `90.5` and the `:N`
  positional FULL/RIGHT cases in `11-joins`. NATURAL stays an error (unparsed,
  out of scope).
- Optimizer interactions: `rule-join-elimination` (un-eliminated RIGHT now
  executes), `parallel-async-gather-zip-by-key` (declined-fold FULL runs via
  nested loop, including a correlated subquery over the null-extended side).
- Physical-selection / merge / bloom rules correctly leave right/full and
  existence joins as the logical nested-loop `JoinNode`.

### Pre-existing / unrelated

- `covering-structure.spec.ts` carries a `db.watch`-callback TS nit noted in the
  handoff. `tsc` (build) and `eslint` (lint) both pass clean at this SHA, so it
  is non-blocking and untouched by this ticket — no `.pre-existing-error.md`
  warranted.

## Validation

- `yarn build` — clean (exit 0)
- `yarn lint` — clean (exit 0)
- Full memory suite (`node test-runner.mjs`) — **5115 passing / 9 pending / 0 failing**
- Store-mode spot-check (`--store --grep "90.5|11-joins"`) — 3 passing
