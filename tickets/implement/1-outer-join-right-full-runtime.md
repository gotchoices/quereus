description: Implement runtime execution of RIGHT and FULL outer joins in the nested-loop join emitter (read path only); flip 90.5 expectations to real rows and add read-path coverage. View write-through re-admission is the separate dependent ticket.
files: packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/runtime/emit/join-output.ts, packages/quereus/test/logic/90.5-unsupported-join-types.sqllogic, docs/view-updateability.md, docs/sql.md
----

## Why

`runtime/emit/join.ts` is the **only** place in the pipeline that cannot handle
`joinType === 'right' | 'full'` — it throws `RIGHT/FULL JOIN is not supported yet`
at run time (pinned by `test/logic/90.5-unsupported-join-types.sqllogic`). Everything
upstream already tolerates a RIGHT/FULL `JoinNode`:

- The parser produces `joinType: 'right' | 'full'` (`parser.ts` ~line 1089).
- `buildJoin` (`planner/building/select.ts`) builds the `JoinNode` unchanged.
- `buildJoinAttributes` / `buildJoinRelationType` (`planner/nodes/join-utils.ts`)
  already mark the correct side nullable for `right` (left side nullable) and `full`
  (both sides nullable).
- `rule-join-physical-selection` returns `null` for any join that is not
  `inner|left|semi|anti`, so a RIGHT/FULL join is **never** converted to Bloom/Merge —
  the logical nested-loop `JoinNode` is what reaches emit.
- `rule-quickpick-enumeration` bails on non-`inner|cross`; `rule-join-elimination`
  already carries a `case 'right'`.

So the entire plan forms and optimizes today; the run simply throws at the last step.
**This ticket adds RIGHT/FULL execution to the nested-loop emitter only** — the smallest
change that makes `select … right/full join …` actually return rows. It is the runtime
prerequisite that unblocks the dependent write-through re-admission ticket
(`view-write-right-join-readmit`).

We deliberately do **not** take the planner-normalization path (RIGHT→`B left join A`,
FULL→`LEFT ∪ anti`) the original plan floated as an alternative: a child-swap reorders
`select *` output columns (Quereus/SQLite return `A.*, B.*` for `a right join b`) and would
need a compensating reorder projection, and FULL→union is a substantially larger rewrite.
The nested-loop emit path touches one file, preserves output column order by construction,
and leaves the raw AST (`'right'`/`'full'`) intact for the write-through surfaces that read it.

## Design

### Output row order is invariant

Whatever the scan order, the emitted row stays `[...leftRow, ...rightRow (, ...flags)]` —
the `JoinNode`'s attribute order (left attrs, then right attrs, then existence flags). The
condition is evaluated against the runtime context after **both** slots are set, so iteration
order does not affect predicate evaluation. This is what lets us drive the loop from whichever
side we choose without disturbing column identity/order.

### RIGHT join — buffer left, drive from right

The current loop streams the one-shot `leftSource` as the outer and re-scans the restartable
`rightCallback` as the inner. RIGHT join needs *every right row* to appear, so invert: **buffer
the left side once** into an array, then iterate the right side **once** as the outer driver and
scan the buffered left array as the inner.

```
const leftRows: Row[] = [];
for await (const r of leftSource) leftRows.push(r);

for await (const rightRow of rightCallback(rctx)) {
  rightSlot.set(rightRow);
  let rightMatched = false;
  for (const leftRow of leftRows) {
    leftSlot.set(leftRow);
    if (conditionMet(leftRow, rightRow)) {       // conditionCallback / USING / cross
      rightMatched = true;
      yield [...leftRow, ...rightRow, ...(matchedFlags ?? [])];
    }
  }
  if (!rightMatched) {
    const nullLeft = new Array(leftAttributes.length).fill(null);
    leftSlot.set(nullLeft);                        // null-pad the dropped (left) side
    yield [...nullLeft, ...rightRow, ...(flagsForDroppedSide('left') ?? [])];
  }
}
```

`rightCallback` is iterated exactly once (no restart needed); `leftSource` is consumed once
into a buffer — so RIGHT has *weaker* restartability requirements than INNER/LEFT, not stronger.

### FULL join — buffer left + matched bitset, then a trailing left pass

FULL is RIGHT plus a final pass that emits left rows that never matched any right row:

```
const leftRows: Row[] = [];
for await (const r of leftSource) leftRows.push(r);
const leftMatched = new Array<boolean>(leftRows.length).fill(false);

for await (const rightRow of rightCallback(rctx)) {
  rightSlot.set(rightRow);
  let rightMatched = false;
  for (let i = 0; i < leftRows.length; i++) {
    leftSlot.set(leftRows[i]);
    if (conditionMet(leftRows[i], rightRow)) {
      rightMatched = true; leftMatched[i] = true;
      yield [...leftRows[i], ...rightRow, ...(matchedFlags ?? [])];
    }
  }
  if (!rightMatched) {
    const nullLeft = new Array(leftAttributes.length).fill(null);
    yield [...nullLeft, ...rightRow, ...(flagsForDroppedSide('left') ?? [])];
  }
}
// trailing pass: left rows with no right match (right side null-extended)
const nullRight = new Array(rightAttributes.length).fill(null);
for (let i = 0; i < leftRows.length; i++) {
  if (!leftMatched[i]) {
    rightSlot.set(nullRight);
    yield [...leftRows[i], ...nullRight, ...(flagsForDroppedSide('right') ?? [])];
  }
}
```

### Refactor, don't fork

The existing left/inner/cross/semi/anti loop and the new right/full loop share the slot setup,
condition evaluation (`conditionCallback` / `evaluateUsingCondition` / cross), and flag spreads.
Factor the **condition-met** decision into a small local helper (`(leftRow, rightRow) => boolean`)
so both loop shapes call the same predicate code; branch on
`joinType === 'right' || joinType === 'full'` to choose the driver. Keep `joinOutputRow`
(`join-output.ts`) for the left/semi/anti path; the right/full null-padding is inline (it pads
the *left* / *right* side respectively, the mirror of `joinOutputRow`'s right-padding) — or
generalize `joinOutputRow` to take the padded side. Prefer the minimal change that keeps the
left/semi/anti behavior byte-identical.

Delete the `if (joinType === 'right' || joinType === 'full') throw …` block.

### Existence (`exists … as`) flag rows

Today: `matchedFlags = existence.map(() => true)` and
`unmatchedFlags = existence.map(spec => spec.side === 'left')`. The unmatched-flag rule is
"a flag is true iff its side is still present after null-extension." Generalize it to the
**dropped side**:

```
const flagsForDroppedSide = (dropped: 'left' | 'right'): Row | undefined =>
  existence ? existence.map(spec => spec.side !== dropped) as Row : undefined;
```

- LEFT unmatched drops `right` → `spec.side !== 'right'` ≡ today's `spec.side === 'left'`. ✓
- RIGHT unmatched drops `left` → `spec.side !== 'left'`.
- FULL right-row-unmatched drops `left`; FULL left-row-unmatched drops `right`.

Keep the existing `unmatchedFlags` for the left path (or replace it with
`flagsForDroppedSide('right')` — same value) so the LEFT existence behavior is unchanged.

## Edge cases & interactions

- **Output column order** — `select * from a right/full join b` must return `a.*` then `b.*`
  (left attrs first), exactly as the attribute order dictates. Add a `select *` read case to
  90.5 (or the new read file) asserting column order, not just values.
- **Empty sides** — left empty + RIGHT: every right row appears null-extended on the left.
  Right empty + RIGHT: no rows. Both empty + FULL: no rows. Left non-empty + right empty +
  FULL: every left row appears null-extended on the right (trailing pass only). Cover all four.
- **No match at all** — RIGHT/FULL with a predicate that matches nothing: RIGHT yields all
  right rows null-left; FULL yields all right rows null-left **and** all left rows null-right.
- **Many-to-many** — a right row matching multiple left rows (and vice-versa for FULL) must
  emit one row per match and must NOT also emit a null-extended row for that right/left row.
  The `rightMatched` / `leftMatched[i]` flags gate this; test with duplicate join keys.
- **Row buffering aliasing** — the left buffer holds references to rows yielded by the scan.
  Memory- and store-vtab scans yield a **distinct** array per row (confirmed by
  `test/vtab/concurrent-scan.spec.ts`, which collects every row into arrays and asserts them),
  so buffering references is safe; do not assume a reused per-iteration buffer. A multi-row
  correctness test (above) catches any aliasing regression.
- **USING joins** — `evaluateUsingCondition(leftRow, rightRow, resolved)` is order-agnostic;
  add a `right join … using (id)` read case.
- **Existence flags on RIGHT** — `a right join b … exists left as f` / `exists right as f`:
  a matched row sets all flags true; a left-null-extended row sets `exists left` false,
  `exists right` true. Add a RIGHT + existence read case. (Existence on FULL may be ambiguous
  upstream — if the builder/parser accepts it, the `flagsForDroppedSide` helper already yields
  the correct per-pass values; if it rejects it, leave that rejection as-is and note it.)
- **Side effects in the left subtree** — buffering drains `leftSource` fully before yielding.
  This is the only correct order for right/full (you must see all left rows to know the
  unmatched ones) and mirrors how the inner side is already materialized via cache for
  left/inner. Outer joins over a side-effecting source are exotic; no special handling beyond
  preserving deterministic drain order.
- **Optimizer interactions already live** — `rule-join-elimination`'s `case 'right'` and the
  `right`/`full` nullability in `join-utils` were dormant (plan formed, never executed). Once
  emit runs them, a RIGHT join whose left side is unreferenced and FK-covered may be eliminated
  to its preserved (right) side. That is the rule's intended behavior; add a read test of a
  plain RIGHT join whose left side IS referenced to pin the non-eliminated path.
- **`test:store` parity** — the change is pure runtime emit; run the 90.5 + new read file under
  both the default memory vtab and (spot-check) the store path is unaffected (no store code touched).

## Tests

- **`test/logic/90.5-unsupported-join-types.sqllogic`** — flip the four RIGHT/RIGHT OUTER/
  FULL OUTER/FULL `-- error:` expectations to real result rows. Seed is already present
  (`uj_l (1,L1),(2,L2)` / `uj_r (1,R1),(3,R3)`). Expected for
  `select uj_l.id, uj_r.id from uj_l right join uj_r on uj_l.id = uj_r.id`:
  rows `(1,1)` and `(NULL,3)` (right row id=3 has no left match). For
  `full join`: `(1,1)`, `(2,NULL)` (left id=2 unmatched), `(NULL,3)` (right id=3 unmatched).
  Keep the NATURAL JOIN cases as `-- error` (out of scope). Mind result ordering — add an
  `order by` if the harness compares ordered.
- **New read-path coverage** (extend 90.5 or a sibling `90.5.x` file): `select *` column-order
  case; empty-side matrix (4 cases); no-match case; many-to-many (duplicate keys) case;
  `right join … using (id)`; RIGHT + `exists left/right as` flags.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log`.

## Docs

- `docs/view-updateability.md` § Outer Joins — the "RIGHT / FULL — not yet, gated by the
  runtime" callout (~line 192): update the **read** half — the runtime now executes RIGHT and
  FULL `select`s. Leave the **write-through** half (RIGHT excluded from recognition; FULL
  conservative) for the dependent ticket to finish, and point the callout at it.
- `docs/sql.md` — if it lists supported join types, add RIGHT/FULL.

## TODO

- Factor a local condition-met helper in `emitLoopJoin` shared by both loop shapes.
- Add `flagsForDroppedSide(dropped)` and wire LEFT path to it (value-equivalent to today).
- Implement the RIGHT driver (buffer left, iterate right once, inline null-left pad).
- Implement the FULL driver (RIGHT + `leftMatched` bitset + trailing null-right pass).
- Remove the `RIGHT/FULL JOIN is not supported yet` throw.
- Flip 90.5 RIGHT/FULL expectations to rows; keep NATURAL as error.
- Add the read-path edge-case cases (select-*, empty matrix, no-match, m:n, USING, existence).
- Update `docs/view-updateability.md` read half + `docs/sql.md`; run the full quereus test suite.
