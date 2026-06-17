description: A view that unions several branches and tags each with a constant label column (e.g. `'red' as kind`, `'A' as src`) can already be written through by filtering on those labels — this proves and documents that idiom as the way to get the "product-coordinate" behaviour the shelved product-coordinate design targeted, and fixes one rough edge where a delete/update whose filter matches no branch raises an internal error instead of doing nothing.
prereq: set-op-flagless-predicate-honest-writes
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: medium
----

## Why this ticket exists (supersedes the shelved product-coordinate build)

The shelved `set-op-product-coordinate-model` (backlog, now deleted) proposed a bespoke
*writable membership* surface: reused flag names merging into one coordinate column valued
`tuple ∈ <union of like-named leaves>`, σ-guard threading, coordinate-addressed multi-target
fan-out, and `checkSatisfiability` contradiction rejection. The plan-pass finding was that the
already-shipped **flag-less predicate-honest write path** (`set-op-flagless-predicate-honest-writes`,
complete) covers the *use case* via **multiple projected-constant discriminator columns**, and the
only thing the bespoke build adds — writable boolean membership over a *non-literal* σ-guard — has
no concrete use case and degrades anyway (the sat-checker returns `unknown` on exactly that fragment).

This was verified empirically against the engine: the existing test view `U`
(`93.6-set-op-flagless-write.sqllogic:19`) is **already** the shelved spec's `U4` fixture, re-expressed
with projected constants — a two-axis discriminator grid `kind ∈ {red,large}` × `src ∈ {A,B}`, i.e.
the `{inX,inY} × {inA,inB}` product grid. The addressing the product model wanted falls out of
filtering on those read-only discriminator columns:

| Product-model intent | Projected-constant idiom | Result |
|---|---|---|
| pin exactly one leaf (one-hot coordinates) | `where kind='red' and src='A'` (both axes) | writes the one co-satisfiable leg |
| multi-target (co-satisfiable axes fan) | `where kind='red'` (one axis) | fans to every consistent leg (red+A, red+B) |
| `predicate-contradiction` reject | `where kind='red' and kind='large'` (same axis, two values) | matches no row ⇒ **no-op** |

The contradiction case is *more* natural here than in the product model: discriminators are read-only
and addressed by `where`, so a contradictory filter simply selects nothing — there is no incoherent
"write two mutually-exclusive memberships" request to reject. So **no `predicate-contradiction` gate is
needed**; a contradictory (or off-grid) filter is a clean no-op, which is standard SQL for a no-match
DELETE/UPDATE.

So this ticket does **not** build the product model. It (1) fixes the one rough edge that breaks the
no-op promise, (2) adds tests pinning the product-coordinate addressing matrix, and (3) documents the
idiom as the recommended surface.

## The bug to fix: zero-leg DELETE/UPDATE raises an internal error

A flag-less set-op DELETE / data-UPDATE whose predicate is provably `unsat` for **every** leg fans to
zero legs, so `buildFlaglessDelete` / `buildFlaglessUpdate` (`set-op.ts:1963`, `:1974`) return
`{ baseOps: [] }`, and `buildSetOpMutation` (`view-mutation-builder.ts:511`) then constructs
`ViewMutationNode([])`, whose constructor throws `ViewMutationNode requires at least one base
operation` (`view-mutation-node.ts:189`, `StatusCode.INTERNAL`).

Reproduced (both throw today, against the `U` fixture above):

```sql
delete from U where kind = 'zzz';                 -- off-grid: no leg has kind='zzz'
delete from U where kind = 'red' and kind = 'large';   -- same-axis contradiction
```

Both should be a **clean no-op (0 rows affected)** — a DELETE/UPDATE that matches no rows never errors
in SQL. (The flag-less **INSERT** path is different and stays as-is: an insert routing to no leg is a
genuine "this row belongs to no branch" error, already raised as the `consistent with no writable leg`
diagnostic at `set-op.ts:1944` — do **not** turn that into a no-op.)

### Fix locus (recommended: the shared boundary, covers both set-op write paths uniformly)

In `buildSetOpMutation` (`view-mutation-builder.ts:511`), after `writeFn` returns, when
`req.op !== 'insert'` and the plan decomposed to nothing (`baseOps.length === 0` **and** no
`joinLegInserts` **and** no `nestedCaptures` that carry an op), return a **no-op sink** instead of
constructing `ViewMutationNode`. The codebase's void/side-effect wrapper is `SinkNode`
(`new SinkNode(ctx.scope, <zero-row source>, req.op)` — see `building/delete.ts:341`,
`building/update.ts:450`); a delete/update matching nothing is exactly a SinkNode whose source yields
no rows. Putting the guard here also defends the `exists`-membership path and is robust against future
fan rules that legitimately narrow to zero branches.

Discarding the unused `capture` descriptor is harmless (it is a plan-time descriptor with no runtime
side effect; nothing reads it once there are no base ops).

Per-builder alternative (return the no-op from `buildFlaglessDelete` / `buildFlaglessUpdate`
themselves) is acceptable but less uniform; prefer the shared-boundary fix unless it complicates the
`SetOpWritePlan` contract.

## Tests to add (extend `93.6-set-op-flagless-write.sqllogic`, reuse the `U` / `U4` fixtures)

A new section titled for product-coordinate addressing via projected-constant discriminators:

- **Cross-axis pin** — `update U set x = x + 100 where kind = 'red' and src = 'A'` touches only the one
  co-satisfiable leg (items_a red), leaving items_b and the `large` legs untouched. (Verified working.)
- **Single-axis fan (UPDATE companion)** — the existing file fans a DELETE on one axis (`where
  kind='large'`) and an UPDATE on the other (`where src='A'`); add the symmetric `update ... where
  kind='red'` fanning to both red legs, to pin the fan/pin distinction explicitly on UPDATE.
- **Same-axis contradiction → no-op** — `delete from U where kind='red' and kind='large'` and
  `... where src='A' and src='B'` each delete 0 rows, base tables unchanged (this is the bug-fix
  assertion; today it throws).
- **Off-grid value → no-op** — `delete from U where kind = 'zzz'` (and an UPDATE form) delete/update 0
  rows, base tables unchanged (also the bug fix).
- Keep the existing static-surface (`view_info` / `column_info`) assertions for `U`: plain columns
  `YES`, discriminators `NO` — already present, do not regress.

## Docs to update

`docs/view-updateability.md` § Set Operations (the flag-less predicate-honest writes subsection,
around lines 614-664, plus the two "shelved product model" mentions at ~403-411 and ~608-612):

- Add a short **"Product-coordinate addressing via projected-constant discriminators"** note: a body
  with **multiple** literal discriminator columns forms a discriminator grid; a write addresses it by
  filtering on those (read-only) columns — fully-specified ⇒ pins one leg, partially-specified ⇒ fans
  to every consistent leg, contradictory/off-grid ⇒ clean no-op. Frame this as the recommended way to
  get product-coordinate behaviour.
- Replace the "shelved `set-op-product-coordinate-model` (backlog)" framing with: the product
  *use case* is served by projected-constant discriminators (above); the **only** genuinely
  out-of-scope residue is **writable boolean membership over a non-literal σ-guard** (a range /
  correlated / function predicate the FD framework cannot fold to a constant *and* whose
  co-satisfiability the sat-checker can actually decide — not `unknown`). State that no use case has
  required it; reopen only if one does.
- Note the zero-leg DELETE/UPDATE no-op explicitly (a DELETE/UPDATE consistent with no leg affects 0
  rows; contrast the INSERT `consistent with no writable leg` diagnostic).

## Edge cases & interactions

- **No-op must not swallow real writes.** The zero-`baseOps` guard fires only when *every* leg is
  `unsat`; a single consistent leg must still write. Cover with a positive assertion right next to each
  no-op assertion (a real delete/update on the same view in the same section).
- **INSERT empty-route stays a diagnostic.** Re-assert the existing `consistent with no writable leg`
  insert reject (and the `GV` gap-value insert) — the no-op change is delete/update only and must not
  weaken the insert path.
- **`except` / `intersect` zero-leg.** `fanLegsForFanOut` already returns `[]` for an `except` whose
  left operand is inconsistent; that path must reach the same no-op (not the internal error). Add an
  `except`/`intersect` no-match delete to confirm.
- **`exists`-membership path parity.** Confirm the membership write path (`buildSetOpWrite`) does not
  separately hit the empty-baseOps error for a no-match delete/update; the shared-boundary fix should
  cover it. If a membership no-match delete already no-ops today, note why (it fans to all branches and
  the runtime member-exists filters), and assert it stays a no-op.
- **RETURNING through the no-op.** Set-op writes reject RETURNING up front (`rejectReturning`); ensure a
  no-op delete/update still hits that reject before the no-op short-circuit, or is independently fine
  (RETURNING is rejected regardless of leg count).
- **Halloween / capture.** The discarded capture in the no-op path carries no runtime op, so there is
  no fork/drain to leak; assert no base table is touched (already implied by the row-count assertions).
- **Static-surface agreement.** A view that *can* produce a zero-leg write at runtime is still
  statically writable (`view_info` YES) — the no-op is a runtime/per-predicate outcome, not a shape
  rejection. Do not let this fix flip any static surface to `NO`.

## TODO

- Fix zero-leg DELETE/UPDATE → clean no-op at the `buildSetOpMutation` boundary (guard `req.op !==
  'insert'` + empty decomposition → `SinkNode` no-op); leave the flag-less INSERT `consistent with no
  writable leg` diagnostic untouched.
- Extend `93.6-set-op-flagless-write.sqllogic` with the product-coordinate addressing section (cross-axis
  pin, single-axis UPDATE fan, same-axis contradiction no-op, off-grid no-op) plus the edge-case
  assertions above (positive write beside each no-op; `except`/`intersect` no-match no-op).
- Update `docs/view-updateability.md` § Set Operations per above; remove the stale "shelved
  product-coordinate model" framing, keep only the non-literal-σ-guard reopen condition.
- `yarn workspace @quereus/quereus lint` and `yarn workspace @quereus/quereus test` green before handoff.
