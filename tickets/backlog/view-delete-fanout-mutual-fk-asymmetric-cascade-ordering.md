description: The lenient multi-side DELETE fan-out for two-table inner-join views hardcodes side order [0,1]. Over a mutual FK whose two edges have asymmetric ON DELETE actions (one CASCADE, one RESTRICT), this fixed order can RESTRICT-block where the reverse order would have cascaded and succeeded — and the user only sees a raw "FOREIGN KEY constraint failed … RESTRICT" error with no hint that a side override would fix it.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Context

The shipped lenient multi-side delete fan-out (ticket
`view-mutation-lenient-multiside-delete-fanout`) deletes the joined row's
contribution from **both** candidate sides when no single-direction FK is provable.
The fan-out is reached only when `fkChildIndex` is `undefined`, which includes the
**mutual-FK** case (each side declares an FK onto the other). Because no parent/child
direction is provable, `orderSides` returns the as-is `[0, 1]` and `decomposeDelete`
emits the two base deletes in that fixed order.

## The problem

When a mutual FK pair has **asymmetric** `on delete` actions, the fixed `[0, 1]`
order is not order-independent:

- edge `side0.col → side1`  `on delete restrict`
- edge `side1.col → side0`  `on delete cascade`

Deleting **side0 first** is RESTRICT-blocked: `side1` still references `side0`
through the RESTRICT edge, so the base delete fails with a raw
`FOREIGN KEY constraint failed … violates RESTRICT`.

The **reverse** order (`[1, 0]`) would have succeeded: deleting `side1` first
cascades the deletion to `side0` (the CASCADE edge), and the fan-out's own `side0`
delete then no-ops (predicate-scan over the now-empty match).

So the fan-out's hardcoded order can *fail a delete that a different ordering would
have completed*. The (fo-b) golden in `93.4-view-mutation.sqllogic` only covers the
**symmetric** case (both edges CASCADE), where order doesn't matter; the asymmetric
case is unpinned and currently surfaces only the cryptic raw FK error.

This is **standard FK semantics** (the same trap exists for any cascade through a
mutual FK), not data corruption — the delete correctly errors rather than producing
a wrong result. But the diagnostic is poor and the order choice is arbitrary.

## Possible directions (decide during plan)

- **Cascade-aware ordering**: when the fan-out spans a mutual FK, prefer deleting the
  side whose inbound edge is CASCADE first (so the other side's row is cascaded away
  before its own RESTRICT edge can block). Falls back to `[0,1]` when both edges are
  RESTRICT (genuinely unsatisfiable) or both CASCADE (order-independent).
- **Clearer diagnostic**: detect the asymmetric-mutual-FK fan-out at plan time and
  raise a structured mutation diagnostic pointing the user at `delete_via` / `target`
  to pin the satisfiable side, instead of letting the raw runtime FK error surface.
- **Both**: order heuristically, and only diagnose when no order can satisfy the
  RESTRICT edges.

## Acceptance

- A golden (or property) case pinning the asymmetric mutual-FK shape: one edge
  RESTRICT, one CASCADE, fan-out delete — currently errors regardless of which side
  the user "meant".
- Either the delete succeeds under a defensible ordering, or it fails with a
  structured diagnostic naming the override that resolves it (not the raw FK error).
- Doc update in `docs/view-updateability.md` § Inner Join — Deletes to replace the
  current "a reviewer should decide" note with the chosen behavior.
