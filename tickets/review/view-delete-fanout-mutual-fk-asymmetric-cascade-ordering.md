description: Make the lenient two-side DELETE fan-out for inner-join views ON-DELETE-aware. Over a mutual FK with asymmetric ON DELETE actions the former fixed `[0,1]` order could abort with a raw FK error where reordering would succeed, or abort no matter the order (genuinely unsatisfiable) while only surfacing a cryptic raw FK error. The fan-out now orders its two base deletes by ON DELETE action (delete the side whose removal clears the other's reference first), and raises a structured `mutual-fk-restrict-delete` diagnostic at plan time when no ordering can satisfy the mutual-FK edges under immediate enforcement.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What shipped

The two-side fan-out is reached **only** at `fkChildIndex(sides) === undefined`
(`chooseDeleteSides` returns a single side whenever a single-direction FK is provable),
which is exactly two situations: **no FK either way**, and a **mutual FK** (each side
declares an FK onto the other). Previously `decomposeDelete` emitted the two base
deletes in the fixed AST order `[0, 1]`. That order is not order-independent over a
mutual FK with **asymmetric** `on delete` actions: under immediate FK enforcement +
the transitive RESTRICT pre-walk (`runtime/foreign-key-actions.ts`
`assertTransitiveRestrictsForParentMutation`), a cascade that would propagate into a
RESTRICT child aborts atomically before any deletion.

Three pieces landed in `multi-source.ts`:

- **`inboundDeleteAction(child, parent)`** — the governing ON DELETE action of FK(s)
  declared on `child` referencing `parent` (the action that fires when a `parent` row
  is deleted). Restrict-dominant aggregation across multiple matching FKs: `restrict`
  > `cascade` > `setNull`/`setDefault` > absent (`undefined`). Mirrors the FK-match
  predicate in `fkChildIndex` (same `referencedTable` / `referencedSchema` comparison).

- **`deletableFirst(inboundX, inboundY)`** — the feasibility predicate. Deleting side X
  first does not abort iff: `inboundX` absent, OR `inboundX ∈ {setNull, setDefault}`,
  OR (`inboundX === cascade` AND `inboundY !== restrict`). `inboundX === restrict` ⇒
  not deletable-first.

- **`orderDeleteFanout(sides)`** — returns `[0, 1]` if side0 is deletable-first (so
  no-FK and both-cascade keep their order), else `[1, 0]` if side1 is, else `undefined`
  (unsatisfiable in any order).

`decomposeDelete` now branches: a 2-side fan-out calls `orderDeleteFanout`; on
`undefined` it raises the new `mutual-fk-restrict-delete` diagnostic naming both base
tables and the cycle remedy. A single-side delete keeps its trivial order
(`order = sides`). `orderSides` (used by UPDATE + INSERT) and the single-direction-FK
delete path are untouched.

`mutual-fk-restrict-delete` was added to `MutationDiagnosticReason` and to the
diagnostics union in `docs/view-updateability.md`; the § Inner Join — Deletes shipped
block was corrected (the prior "a cascade — or a mutual-FK edge — that removes a row …
is a natural no-op" overclaim held only for both-cascade) to describe the
ON-DELETE-aware ordering and the plan-time reject.

## Feasibility model (the ground truth being implemented)

`inbound0` = ON DELETE action of the FK referencing side0 (governs deleting side0);
`inbound1` = the action referencing side1. Matches all six empirical rows from the
implement ticket:

| inbound0 | inbound1 | result | order |
|---|---|---|---|
| cascade  | cascade  | SUCCESS (order-independent) | `[0,1]` |
| restrict | cascade  | **reject** (both orders abort) | — |
| cascade  | restrict | **reject** | — |
| restrict | restrict | **reject** | — |
| restrict | setNull  | SUCCESS only `[1,0]` | `[1,0]` |
| setNull  | restrict | SUCCESS only `[0,1]` | `[0,1]` |

## Use cases for validation

New goldens in `93.4-view-mutation.sqllogic` (after `fo-f`; each seeds the mutual FK
like `fo-b` — nullable FK columns + back-fill `update`s so the cycle is establishable
under `foreign_keys` on):

- **(fo-g)** `g_a.bref → g_b on delete cascade`, `g_b.aref → g_a on delete restrict`
  (inbound0=restrict, inbound1=cascade) → `delete from g_jv where aid = 1` raises
  `-- error: mutual foreign key`; both base rows survive (plan-time reject is a no-op).
  This is the **headline** restrict+cascade shape — both orders abort at runtime today;
  the diagnostic replaces the raw FK error.
- **(fo-h)** both edges `on delete restrict` → same diagnostic; both rows survive.
- **(fo-i)** `i_a.bref → i_b on delete set null`, `i_b.aref → i_a on delete restrict`
  (inbound0=restrict, inbound1=setNull) → reordered fan-out `[1,0]` deletes i_b first
  (its SET NULL clears i_a.bref) then i_a cleanly; after `delete … where aid = 1`,
  **both** base rows for the joined identity are gone. The as-is `[0,1]` order would
  have aborted — this is the one asymmetric shape an ordering rescues.
- **(fo-b regression)** symmetric cascade/cascade still green (side0 deletable-first ⇒
  `[0,1]`).

Error matching: the sqllogic harness does a case-insensitive **substring** match
(`logic.spec.ts:601`), and the raised message contains the literal `mutual foreign key`.

## Validation performed

- `yarn workspace @quereus/quereus test` — **4410 passing, 9 pending, 0 failing**
  (includes the three new goldens and the fo-b regression).
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).

Did NOT run `yarn test:store` (LevelDB path) — this change is pure planner logic with
no storage-path interaction, but a reviewer wanting belt-and-suspenders could run it.

## Known gaps / where the reviewer should look hardest

The handoff is honest that the feasibility model is **scoped to the mutual-pair shape**,
not arbitrary cascade topology:

- **Deeper cascade chains are NOT modeled.** `deletableFirst`'s cascade clause
  (`inboundX === cascade && inboundY !== restrict`) assumes the only inbound child of Y
  relevant to the transitive pre-walk is X (the root). If deleting X cascade-deletes Y,
  and Y in turn cascades into a **third** table Z that has a RESTRICT child, the runtime
  pre-walk can still abort — and `orderDeleteFanout` would not detect it (it only
  inspects the two view-base tables' mutual edges). So the plan-time diagnostic is sound
  for the two-table mutual shape; a deeper chain remains a potential raw transitive-FK
  runtime error. This matches the two-table scope of the whole multi-source substrate,
  but a reviewer should confirm that scoping is acceptable and consider whether a follow
  -up fix/backlog ticket is warranted for n-deep cascade reasoning.

- **`fk.deferred` is not consulted.** The model assumes immediate enforcement (as the
  ticket frames it, and as the diagnostic message states). If a mutual restrict+restrict
  (or restrict+cascade) FK is declared `deferrable initially deferred`, `orderDeleteFanout`
  still rejects at plan time even though deferred-to-commit enforcement could in principle
  let it succeed — a potential **false-positive rejection**. The diagnostic even suggests
  "make the constraint deferred" as a remedy, which is only honest if the runtime actually
  honors deferred enforcement on this path. The reviewer should decide whether to (a)
  treat a deferred inbound FK as non-blocking in `deletableFirst`, or (b) leave it and
  tighten the remedy wording. No golden currently exercises a deferred mutual FK.

- **Aggregation tie-breaking when restrict + non-restrict FKs coexist on the same ordered
  pair.** `inboundDeleteAction` returns `restrict` if ANY matching FK is restrict
  (most-blocking governs). This is the conservative/correct choice under immediate
  enforcement (every referencing FK fires), but there is no golden for the multi-FK-per-
  ordered-pair case — only single-FK-per-edge shapes are pinned.

- The `restrict`+`cascade` headline shape (fo-g) and `restrict`+`restrict` (fo-h) are
  asserted *only* via the error fragment + post-state survival; the reviewer may want to
  confirm the diagnostic `reason` code itself (`mutual-fk-restrict-delete`) is what the
  harness surfaces (the sqllogic harness only matches the message text, not the structured
  reason).
