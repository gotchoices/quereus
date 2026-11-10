---
description: A window frame like "all rows within 10 of the current row's value" used to silently drop the "within 10" part when the ordering column held text (or anything non-numeric); it now raises an error instead, as PostgreSQL and SQLite do.
files:
  - packages/quereus/src/planner/building/select-window.ts
  - packages/quereus/src/runtime/emit/window.ts
  - packages/quereus/src/planner/rules/window/rule-monotonic-window.ts
  - packages/quereus/test/plan/window-one-sided-frames.spec.ts
  - packages/quereus/test/logic/07.5-window.sqllogic
  - docs/window-functions.md
repro: verified
---

# Reject a numeric RANGE frame offset over a non-numeric ORDER BY key

## What landed

- **Prepare-time check** (`validateRangeOffsetFrame`, `select-window.ts`), run once per window group from the only WindowNode build site. A `range` frame with an `n preceding` / `n following` bound requires exactly one ORDER BY key (`... requires exactly one ORDER BY key; got N`), and that key must be numeric, NULL-typed or ANY. Temporal keys raise an UNSUPPORTED "requires an interval offset" error; any other non-numeric type (TEXT, BLOB, BOOLEAN, JSON) raises `... requires a numeric ORDER BY key; got <TYPE>`. Errors carry the source location.
- **Runtime check** (`rangeOrdinal`, `runtime/emit/window.ts`): for an ANY key, a non-NULL value that is not a number or bigint raises the same error, naming the value's storage class. A numeric-looking string such as `'5'` is rejected too.
- The streaming rule's eligibility logic is unchanged. Its doc comment now names the two cases that must stay buffered: ANY keys, and offset-zero peer-group frames over non-numeric or multi-key ORDER BY.
- Docs: `docs/window-functions.md` (RANGE vs ROWS, Frame Specifications, the list of streaming-rule bails, test coverage).

## Review findings

Read the diff from `ticket(implement): bug-window-range-offset-ignored-on-text-key` before reading the handoff. I also ran a probe spec against the source and then deleted it.

- **Correctness, probed:** explicit `0 preceding and 0 following` over TEXT is rejected, matching PostgreSQL. BOOLEAN keys are rejected. A TEXT expression key (`k || ''`) is rejected, and `cast(k as integer)` is accepted. An ANY key with an index on it (so streaming could apply) computes correct frames for mixed integer and real values. A partitioned numeric RANGE frame works. `row_number()` over a TEXT key with an offset frame is rejected at prepare time (only an ANY key gets past the check with ranking functions, as the handoff says). Named windows (`window w as`) are not supported by the engine at all, so they are not a way around the check.
- **Coverage of build sites:** `buildWindowPhase` is the only place a WindowNode is built from SQL (`window-node.ts` only re-creates nodes from existing ones), so the check cannot be bypassed.
- **DRY, fixed:** the check `isNumeric === true || === ANY_TYPE || === NULL_TYPE` repeated `isNumericOrUnknownType` (`types/builtin-types.ts`) word for word. Replaced it with a call to that function. This also means the builder now shares that function's existing `NOTE:` about plugin-registered ANY/NULL types.
- **Separate defect found, filed:** RANGE offset frames ignore a DESC ORDER BY. For example, `order by n desc range between 1 preceding and 1 following` returns the whole partition, because `rangeOffsetStart` / `rangeOffsetEnd` assume an ascending key. This is reachable now, was there before this change, and lies outside this diff. Filed as `tickets/backlog/bug-window-range-offset-ignores-desc-order.md` (repro verified). Nothing open already claimed `rangeOffsetStart` / `rangeOffsetEnd`.
- **Second arm (the multi-key / no-ORDER-BY error):** kept. PostgreSQL and SQLite both reject this, and the buffered walk only reads key 0, so accepting it would silently give the wrong frame. It is the same defect as the one this ticket fixes.
- **Accepted gaps from the handoff, not acted on:**
  - ANY key with a ranking function does not raise. The frame has no effect on the result there, and the gap is documented.
  - The runtime error has no source location. Every other runtime value error in this emitter also lacks one.
  - Strict storage-class rejection of `'5'` in an ANY column was the recommended behaviour.
  - None of these needs a ticket or a tripwire.
- **Tests:** the rewritten plan-spec case pins the prepare error on both the streaming and the rule-disabled database, and pins the rows of the offset-zero frame. Each `range_types` sqllogic case covers one distinct branch of the check (TEXT, temporal, multi-key, no key, ANY numeric, ANY text, the unbounded/current-row positive case). Nothing restates the implementation, so nothing was cut. Added nothing: the DESC defect belongs to its own ticket.
- **Resource cleanup / performance:** the check runs once per window group at prepare time. The runtime check adds two `typeof` tests per value read in the bound scan, which costs nothing measurable next to the existing O(n) scan per row. No new resources are allocated.
- **Docs:** `docs/window-functions.md` matches the new behaviour. `docs/todo.md:120` ("RANGE BETWEEN" left unchecked) predates this ticket; I left it alone.
- **Validation:** `yarn workspace @quereus/quereus lint` is clean. `yarn workspace @quereus/quereus test`: 11139 passing, 26 pending, 0 failing. I did not run `test:store` because no store-specific path changed.
