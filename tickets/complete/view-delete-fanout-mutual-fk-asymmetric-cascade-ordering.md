description: Make the lenient two-side DELETE fan-out for inner-join views ON-DELETE-aware. Over a mutual FK with asymmetric ON DELETE actions the former fixed `[0,1]` order could abort with a raw FK error where reordering would succeed, or abort no matter the order (genuinely unsatisfiable) while only surfacing a cryptic raw FK error. The fan-out now orders its two base deletes by ON DELETE action and raises a structured `mutual-fk-restrict-delete` diagnostic at plan time when no ordering can satisfy the mutual-FK edges under immediate enforcement.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What shipped (implement stage)

The two-side fan-out is reached only at `fkChildIndex(sides) === undefined`
(`chooseDeleteSides` returns a single side whenever a single-direction FK is provable):
**no FK either way**, or a **mutual FK** (each side declares an FK onto the other).
Previously `decomposeDelete` emitted the two base deletes in fixed AST order `[0, 1]`,
which is not order-independent over a mutual FK with asymmetric `on delete` actions.

Three helpers in `multi-source.ts`:

- **`inboundDeleteAction(child, parent)`** — restrict-dominant aggregation of the ON
  DELETE action(s) of FK(s) on `child` referencing `parent`: `restrict` > `cascade` >
  `setNull`/`setDefault` > absent.
- **`deletableFirst(inboundX, inboundY)`** — feasibility predicate: deleting X first is
  fine iff `inboundX` absent, OR `inboundX ∈ {setNull, setDefault}`, OR (`inboundX ===
  cascade` AND `inboundY !== restrict`).
- **`orderDeleteFanout(sides)`** — `[0,1]` if side0 deletable-first, else `[1,0]`, else
  `undefined` (unsatisfiable in any order → caller raises `mutual-fk-restrict-delete`).

`decomposeDelete` branches on `sides.length`; the single-side path keeps its trivial
order. `mutual-fk-restrict-delete` was added to `MutationDiagnosticReason` and the docs
diagnostics union.

## Review findings

Adversarial pass over the implement diff (commit `4973216d`), read fresh before the
handoff. Verdict: **the core logic is correct and the feasibility model is sound.**
Build, typecheck, lint, and the full quereus test suite (4410 passing / 9 pending / 0
failing) are green after the review edits below.

### Checked — correctness of the feasibility model
- **`onDelete` normalization (the load-bearing detail the handoff under-stated).**
  Verified that all three schema-build paths — `schema/manager.ts:936` (column-level FK),
  `:970` (table-level FK), and `runtime/emit/alter-table.ts:353` (ALTER) — normalize
  `fk.onDelete ?? 'restrict'`, and `ForeignKeyConstraintSchema.onDelete` is a **required**
  field. So `inboundDeleteAction` (which reads the *schema* FK, not the AST) never sees
  `undefined` for a declared FK — only when no FK matches the pair. The runtime RESTRICT
  pre-check (`assertNoRestrictedChildrenForParentMutation`) reads the same normalized
  `onDelete`, so absent-ON-DELETE is enforced as RESTRICT at runtime too. The model is
  therefore self-consistent with the runtime, including the "absent ON DELETE clause"
  case the handoff never addressed. ✔
- **Each table row of the feasibility model hand-traced against the runtime walker**
  (`assertTransitiveRestrictsForParentMutation`): fo-g (restrict+cascade → both orders
  abort), fo-i (restrict+setNull → only `[1,0]` survives), fo-j (setNull+restrict → only
  `[0,1]`). All match. ✔
- **No false reject within the modeled shapes:** `orderDeleteFanout` returns `undefined`
  only for restrict+restrict / restrict+cascade / cascade+restrict, all of which abort in
  both orders at runtime; a no-FK pair (both inbound absent) always returns `[0,1]`, never
  rejected; a single-direction FK never reaches the fan-out. ✔
- **Reachability of the reject:** confirmed `sides.length === 2` ⟺ `candidates === [0,1]`
  ⟺ `fkChildIndex` undefined, so the diagnostic fires only for genuine mutual FKs. ✔

### Found + fixed inline (minor)
- **Misleading "make the constraint deferred" remedy.** The diagnostic message
  (`multi-source.ts`), the `MutationDiagnosticReason` comment (`mutation-diagnostic.ts`),
  and `docs/view-updateability.md` all suggested deferring the constraint as a remedy.
  Verified that `fk.deferred` is stored on the schema but **never read** by any FK
  enforcement path (`grep` across `planner/` + `runtime/` is empty), and
  `foreign-key-builder.ts` hard-codes `deferrable: !isRestrict` — so a `deferrable
  initially deferred` RESTRICT FK is still enforced **immediately**. The deferred remedy
  does not work in the current engine. Reworded all three to point at the working remedy
  (null out the referencing column(s) first / restructure the ON DELETE action) and to
  state explicitly that deferring does not help. The fo-g/fo-h goldens still match (the
  literal `mutual foreign key` substring is untouched).
- **Test coverage gap: the `setNull`-first rescue was only pinned in the `[1,0]`
  direction** (fo-i). `deletableFirst`'s SET NULL clause in the `[0,1]` direction had no
  SUCCESS golden — fo-b covers `[0,1]` only via the *cascade* clause. Added **(fo-j)**
  (setNull+restrict → `[0,1]`), the mirror of fo-i, pinning order-selection symmetry.
  Hand-traced and confirmed green.

### Found + filed as backlog (major, but exotic / not a realistic-workload bug)
- **Data-independent over-rejection.** `orderDeleteFanout` / `inboundDeleteAction`
  inspect only `TableSchema.foreignKeys` — never the view's join predicate or the actual
  rows. For the common view shape (join *on* the FK columns) the plan-time reject exactly
  matches runtime and is a strict improvement. But for the exotic shape — a mutual FK pair
  joined on **non-FK** columns where the specific rows don't actually cross-reference
  (e.g. nullable FK columns left NULL) — the statement is now rejected at plan time where
  it previously **succeeded** at runtime. This is a narrow behavior regression for a very
  low-frequency shape (mutual/cyclic FK + non-FK join + non-referencing rows). Filed
  `tickets/backlog/mutual-fk-delete-fanout-data-independent-over-rejection.md` with repro
  sketch and resolution options (accept the conservative reject, or gate it on
  FK-correlated-lineage). Not fixed here: the precise fix needs join-predicate ↔
  FK-column correlation analysis, which is out of scope for a review pass.

### Checked — handoff's other flagged gaps (no action needed)
- **Deeper cascade chains not modeled** (X cascades→Y cascades→Z-with-restrict). Confirmed
  this is **not a regression**: the deep-chain shape raw-errored at runtime before this
  change and still does; the change only fails to *upgrade* it to a nice diagnostic. No
  false reject (the cascade clause returns deletable-first, so the statement proceeds and
  the runtime transitive pre-walk catches it). Acceptable boundary, consistent with the
  two-table scope of the whole multi-source substrate. No ticket.
- **Multi-FK-per-ordered-pair tie-break.** `inboundDeleteAction`'s restrict-dominant
  aggregation is the conservative/correct choice under immediate enforcement (every
  referencing FK fires). No golden, but the logic is sound and the shape (two FKs from the
  same child to the same parent) is exotic. No ticket.
- **`reason` code vs message text.** The sqllogic harness matches message substring only
  (`logic.spec.ts`), not the structured `reason`. The `reason` (`mutual-fk-restrict-delete`)
  is exercised by construction (it is the only code path that raises that message) and is
  pinned in the `MutationDiagnosticReason` union + docs. Acceptable.

### Docs
- `docs/view-updateability.md` § Inner Join — Deletes: deferred-remedy wording corrected
  (as above); the ON-DELETE-aware ordering narrative from the implement stage was verified
  accurate against the shipped code.

## Validation performed (review stage)
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus test` — **4410 passing, 9 pending, 0 failing** (includes
  the new fo-j golden and the unchanged fo-g/h/i + fo-b regression).
- Did NOT run `yarn test:store` (LevelDB path): the change is pure planner logic + test +
  docs with no storage-path interaction. No pre-existing failures encountered.
