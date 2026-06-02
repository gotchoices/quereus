description: The lenient multi-side DELETE fan-out for two-table inner-join views hardcodes side order [0,1]. Over a mutual FK whose two edges have asymmetric ON DELETE actions this fixed order can abort with a raw FK error where a different ordering would succeed — or, for the restrict+cascade shape, abort no matter the order (genuinely unsatisfiable) while only surfacing a cryptic raw FK error. Make the fan-out ordering ON-DELETE-aware (delete the side whose removal clears the other's reference first) and, when no ordering can satisfy the mutual-FK edges, raise a structured `mutual-fk-restrict-delete` diagnostic instead of letting the raw transitive-FK error surface.
prereq: view-mutation-lenient-multiside-delete-fanout
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Context

The shipped lenient multi-side delete fan-out (ticket
`view-mutation-lenient-multiside-delete-fanout`) deletes the joined row's
contribution from **both** candidate sides when no single-direction FK is provable.
The two-side fan-out is reached **only** when `fkChildIndex(sides)` is `undefined`
(`chooseDeleteSides` returns a single side whenever a single-direction FK is
provable). `fkChildIndex` returns `undefined` in exactly two situations: **no FK
either way**, and a **mutual FK** (each side declares an FK onto the other). In both,
`orderSides` returns the as-is `[0, 1]` and `decomposeDelete` emits the two base
deletes in that fixed order:

```ts
// decomposeDelete (multi-source.ts ~L1102)
const order = orderSides(analysis.sides).filter(i => sides.includes(i));
```

## The problem (empirically characterized)

When a **mutual** FK pair has **asymmetric** `on delete` actions, the fixed `[0, 1]`
order is not order-independent. Quereus enforces FKs **immediately** and runs a
**transitive RESTRICT pre-walk** before a cascade (`runtime/foreign-key-actions.ts`
`assertTransitiveRestrictsForParentMutation` — pinned by
`test/runtime/fk-restrict-runtime.spec.ts` "fires transitively when CASCADE DELETE
would propagate into a RESTRICT child"): a cascade delete that would propagate into a
row bearing a RESTRICT child **aborts atomically before any deletion**.

A scratch experiment (mutual FK between `m_a a` / `m_b b`, view
`select a.aid, b.bid from m_a a join m_b b on b.aref = a.aid`, `delete … where aid = 1`;
edge `m_a.bref → m_b` governs *deleting m_b*, edge `m_b.aref → m_a` governs
*deleting m_a*) gives the ground truth. Let `inbound0` = the ON DELETE action of the
FK that references **side0** (`m_a`) — i.e. `m_b.aref → m_a`; `inbound1` = the action
referencing **side1** (`m_b`) — i.e. `m_a.bref → m_b`:

| inbound0 (del side0) | inbound1 (del side1) | current `[0,1]` result | satisfiable under SOME order? |
|---|---|---|---|
| cascade  | cascade  | SUCCESS (both rows gone)                     | yes — order-independent (`fo-b`) |
| restrict | cascade  | ERROR `… violates RESTRICT from 'm_a'`       | **no — both orders abort** |
| cascade  | restrict | ERROR `CHECK … _fk_m_b_aref …`               | **no — both orders abort** |
| restrict | restrict | ERROR `CHECK … _fk_m_b_aref …`               | **no** |
| restrict | setNull  | ERROR `CHECK … _fk_m_b_aref …`               | **yes — only `[1,0]`** |
| setNull  | restrict | SUCCESS                                      | yes — only `[0,1]` |

The ticket's original option-1 premise ("the reverse order would have cascaded and
succeeded" for restrict+cascade) is **false**: the transitive RESTRICT pre-walk aborts
the cascade-into-restrict, so the **restrict+cascade** mutual shape (rows 2–3 — the
ticket's headline) is genuinely unsatisfiable in *either* order, and **no** view tag
(`delete_via` / `target`) resolves it — a single-side delete is equally blocked
(one side direct-RESTRICT, the other cascade-into-RESTRICT). What reordering *does*
rescue is the **restrict + setNull/setDefault** shape (rows 5–6): deleting the
setNull/setDefault-inbound side first clears the other side's reference (without a
cascade into a RESTRICT), so the RESTRICT-inbound side's delete then no-ops.

## Feasibility model (derived; matches all six rows above)

Deleting side **X** first (then **Y**) does **not** abort iff:

- `inboundX` is **absent** (no FK references X), or
- `inboundX ∈ {setNull, setDefault}` (clears Y's reference; no cascade, no RESTRICT), or
- `inboundX == cascade` **and** `inboundY != restrict` (the cascade into Y does not hit
  a RESTRICT child — Y's only inbound child here is X (the root), referenced via the
  `inboundY` edge).

`inboundX == restrict` ⇒ X is **not** deletable-first (Y still references X).

The fan-out is **satisfiable** iff *either* side is deletable-first. Pick the first
deletable-first side as the order; if **neither** side is deletable-first, the fan-out
is **unsatisfiable** → raise the structured diagnostic. (No-FK fan-out: both inbound
actions absent ⇒ both feasible ⇒ `[0,1]`, unchanged. cascade/cascade ⇒ side0 feasible
⇒ `[0,1]`, unchanged — `fo-b` still passes.)

When more than one FK runs between the same ordered pair, aggregate conservatively for
`inbound`: **restrict** if any inbound FK from the other side is restrict; else
**cascade** if any is cascade; else setNull/setDefault; else absent (the most-blocking
action governs, matching immediate enforcement firing every referencing FK).

## Chosen behavior ("Both", with roles corrected by the data)

1. **ON-DELETE-aware fan-out ordering.** Replace the fan-out's `orderSides(...)` call
   with a delete-specific order computed from the feasibility model: emit the base
   deletes deleting a *deletable-first* side first. This is a strict improvement over
   the hardcoded `[0,1]` and rescues the satisfiable restrict+setNull/setDefault shape
   (row 5 — currently a latent runtime error). Single-direction-FK and no-FK paths are
   unaffected (the fan-out is only reached at `fkChildIndex === undefined`, and the
   single-side path keeps its trivial order).

2. **Structured diagnostic for the unsatisfiable mutual-FK fan-out.** When neither
   side is deletable-first (rows 2–4: restrict+restrict, restrict+cascade,
   cascade+restrict), detect it at **plan time** (both edges' `onDelete` are in the
   schema) and raise a new `mutual-fk-restrict-delete` diagnostic — honest that **no
   side ordering and no override** can satisfy the mutual RESTRICT under immediate
   enforcement, and that the resolution is to break the cycle (clear one side's FK
   reference first, or declare the constraint deferred). Do **not** suggest
   `delete_via`/`target` as resolvers here (they don't help — diverging from the
   original ticket's "name the override" phrasing, which assumed an override exists).

This keeps Quereus from emitting a plan whose only possible runtime outcome is a
cryptic raw FK abort, and turns the one truly order-sensitive shape into a success.

## Implementation sketch (multi-source.ts)

- Add a helper returning the aggregated inbound ON DELETE action for an ordered
  `(child, parent)` pair, mirroring the FK-match predicate already in `fkChildIndex`
  (same `referencedTable` / `referencedSchema` comparison):

  ```ts
  // The governing ON DELETE action of FK(s) declared on `child` referencing `parent`
  // (i.e. the action that fires when a `parent` row is deleted). restrict-dominant.
  function inboundDeleteAction(child: JoinSide, parent: JoinSide): ForeignKeyAction | undefined { … }
  ```

- Add a delete-fan-out order/feasibility function over `analysis.sides`:

  ```ts
  // Returns the feasible base-delete order for the two-side fan-out, or undefined
  // when the mutual FK is unsatisfiable in any order (caller → mutual-fk-restrict-delete).
  function orderDeleteFanout(sides: readonly [JoinSide, JoinSide]): readonly number[] | undefined { … }
  ```

  `deletableFirst(x, y)` encodes the three feasibility clauses above. Prefer `[0,1]`
  when side0 is feasible (preserves current behavior for cascade/cascade and no-FK).

- In `decomposeDelete`, when `sides.length === 2`, use `orderDeleteFanout`; on
  `undefined` raise the diagnostic. When `sides.length === 1`, keep the single side as
  the order (drop the `orderSides(...).filter(...)` for the fan-out path; the single-
  side path needs no FK ordering). Leave `orderSides` (used by UPDATE + INSERT) and the
  single-direction-FK delete path untouched — the INSERT/UPDATE FK-parent-first
  ordering must not change.

- Add `'mutual-fk-restrict-delete'` to `MutationDiagnosticReason` in
  `mutation-diagnostic.ts` with a doc comment. Raise via `raiseMutationDiagnostic`
  naming both base tables and (briefly) the offending edges, e.g.:
  `cannot delete through view '<v>': the joined row spans a mutual foreign key
  ('<a>'↔'<b>') whose ON DELETE actions cannot be satisfied in either order under
  immediate FK enforcement (deleting either side trips the other's RESTRICT, directly
  or transitively through a cascade); break the cycle (clear one side's reference first,
  or make the constraint deferred) before deleting through the view`.

## Tests — goldens in `93.4-view-mutation.sqllogic` (after `fo-b`)

Seed each mutual FK like `fo-b`: nullable FK columns + back-fill `update`s so the
mutual FK can be established under enforcement (`foreign_keys` defaults on). Use the
`-- error: <fragment>` convention (matches a substring of the raised message) for the
diagnostic cases; the harness already matches plan-time mutation diagnostics this way
(see `fo-f` `-- error: policy`).

- **(fo-g) restrict+cascade mutual FK → structured diagnostic (the headline).** Both
  orders abort at runtime today; the plan-time diagnostic replaces the raw FK error.
  Shape: edge `g_a.bref → g_b on delete cascade`, edge `g_b.aref → g_a on delete
  restrict` (so `inbound0 = restrict`, `inbound1 = cascade`). `delete from g_jv where
  aid = 1` → `-- error: mutual foreign key` (or whichever stable fragment the final
  message uses). Assert both base rows survive (the rejected delete is a no-op).

- **(fo-h) restrict/restrict mutual FK → same diagnostic.** Both edges `on delete
  restrict`. `delete … → -- error: mutual foreign key`. Both base rows survive.

- **(fo-i) restrict+setNull mutual FK → SUCCESS via reordering (the rescued case).**
  Edge `i_a.bref → i_b on delete restrict`, edge `i_b.aref → i_a on delete set null`
  (so `inbound0 = setNull`, `inbound1 = restrict` ⇒ side0 deletable-first ⇒ `[0,1]`),
  OR the mirror (`inbound0 = restrict`, `inbound1 = setNull` ⇒ `[1,0]`) — pick the
  mirror so the test exercises the **reordering** (the as-is `[0,1]` currently ERRORs;
  reordered `[1,0]` succeeds). After `delete … where aid = 1`, assert **both** base
  rows for the joined identity are gone (the setNull side cleared the reference, then
  the restrict side deleted cleanly). Add a short comment that this is the only
  asymmetric shape an ordering can satisfy.

- **(fo-b regression):** the existing symmetric cascade/cascade golden must still pass
  unchanged (side0 deletable-first ⇒ `[0,1]`).

Confirm the chosen `-- error:` fragment matches the final message text. Run:
`yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vm.log; tail -n 60 /tmp/vm.log`
(stream, don't silently redirect). Also `yarn workspace @quereus/quereus run lint`
(single-quoted globs on Windows) and `typecheck`.

## Docs — `docs/view-updateability.md` § Inner Join — Deletes

Update the shipped-fan-out block (~L405–430). The current text overclaims that "an FK
cascade — or a mutual-FK edge — that removes a row before its own side's predicate-
delete runs is a natural no-op": that holds **only** when both mutual edges cascade.
Replace/qualify with the ON-DELETE-aware behavior:

- The fan-out orders its two base deletes by ON DELETE action: the side whose removal
  clears the other's reference (setNull/setDefault, or a cascade that does not recurse
  into a RESTRICT) is deleted first; a both-cascade or no-FK pair keeps `[0,1]`.
- A mutual FK whose edges cannot be satisfied in any order under immediate enforcement
  (restrict+restrict, restrict+cascade) is rejected at plan time with
  `mutual-fk-restrict-delete` rather than surfacing the raw transitive-FK runtime error;
  no `delete_via`/`target` override resolves it (single-side is equally blocked).
- Note the dependence on immediate enforcement + the transitive RESTRICT pre-walk
  (`runtime/foreign-key-actions.ts`).

Add `mutual-fk-restrict-delete` to any diagnostics-union table in the doc if one is
maintained there (grep the doc for the other reason codes, e.g. `policy-strict-ambiguity`).

## TODO

- [ ] `inboundDeleteAction(child, parent)` helper (restrict-dominant aggregation) in `multi-source.ts`.
- [ ] `orderDeleteFanout(sides)` + `deletableFirst` feasibility (three clauses); returns order or `undefined`.
- [ ] Wire into `decomposeDelete`: 2-side fan-out uses `orderDeleteFanout`; `undefined` → raise diagnostic; 1-side keeps trivial order. Leave `orderSides`/single-FK path untouched.
- [ ] Add `'mutual-fk-restrict-delete'` reason + doc comment in `mutation-diagnostic.ts`; raise with both table names + edge hint.
- [ ] Goldens fo-g (restrict+cascade → error), fo-h (restrict/restrict → error), fo-i (restrict+setNull mirror → success via reorder); confirm fo-b still green.
- [ ] Verify the `-- error:` fragment matches the final message; run quereus tests + lint + typecheck (streamed).
- [ ] Update docs/view-updateability.md § Inner Join — Deletes (correct the no-op overclaim) + diagnostics union.
