description: Advertisement-driven **put** fan-out for an n-way decomposition lens (columnar / column-family / EAV). Shipped the substrate-independent half — DELETE across every member and UPDATE routed to the mandatory backing member — and deferred INSERT/surrogate + predicate-honest multi-member writes onto substrate not yet present, each with a precise diagnostic. `propagate()` recognizes a decomposition body and routes it off the generic two-table join path (unsound for a decomposition) to the new fan-out. Reviewed and completed.
prereq:
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped

A decomposition lens is registered as an ordinary view whose `selectAst` is the
synthesized `anchor ⋈ members` join. `propagate()` (`propagate.ts` →
`decompositionStorage`) intercepts a target whose lens slot carries a `primary-storage`
advertisement with no override (⇒ the body is exactly the synthesized decomposition) and
routes its writes to `propagateDecomposition` (`decomposition.ts`) **before** the generic
two-table `multi-source.ts` path — which is unsound for a decomposition (single delete
side, two-member cap, rejects the outer joins optional members ride).

- **DELETE** fans out to every member (mandatory, optional, EAV pivot). Members are
  ordered **anchor-last**; each non-anchor member's identifying set is read from the
  **anchor alone** (`… where memberKey in (select anchorKey from anchor where <pred>)`),
  so an earlier member's delete can never shrink a later member's set. No-`WHERE` ⇒
  unconditional per-member truncate. An EAV pivot deletes every triple for the matched
  entity (keyed by `attributePivot.entityColumn`).
- **UPDATE** routes each `set` assignment to the single mandatory, non-EAV member backing
  it and emits one per-member UPDATE keyed off the anchor the same anchor-last way.
- **Deferred, each with a precise diagnostic** (`mutation-diagnostic.ts`):
  `unsupported-decomposition-insert`, `unsupported-decomposition-predicate` (non-anchor
  WHERE), `unsupported-decomposition-update` (optional/EAV/shared-key column),
  `unsupported-decomposition-key` (composite/absent shared key). The substrate-gated
  remainder is the follow-on `implement/` ticket `lens-multi-source-put-insert-fanout`
  (prereq `view-mutation-shared-surrogate-insert`), which correctly captures all four.

## Review findings

**Verification approach.** Read the implement diff (5176df3c) cold before the handoff
summary. Re-derived the anchor-last soundness argument and exercised it adversarially
with scratch specs (multi-mandatory-member topology, differently-spelled per-member key,
anchor-column predicates, Halloween-shaped updates, EAV), then folded the durable cases
into the committed suite. Ran lint, typecheck, and the full `@quereus/quereus` suite.

**Soundness of the anchor-last + anchor-only-subquery crux — CHECKED, sound.** Built a
topology with **two** mandatory non-anchor members plus an anchor whose key column is
spelled differently per member (`T_b.core_id` vs `T_core.id`/`T_d.id`); DELETE and
multi-member UPDATE both fanned out correctly, and a delete keyed on a shared anchor
*column* value (two logical rows matching) reached every member. Because every non-anchor
member reads its identifying set from the still-intact anchor and the anchor mutates
last, no member op can corrupt another's set regardless of member count or key spelling.
The single-column-key guard (`unsupported-decomposition-key`) fires for a composite key.

**EAV-column UPDATE diagnostic — MINOR, FIXED INLINE.** An EAV member backs its logical
columns as attribute *rows*, never via `member.columns`, so the value-routing loop could
not match them; an EAV-column UPDATE fell through to a bare `no-inverse` ("not backed by
any decomposition member") — the *same* message a typo'd column gets — and the in-loop
`member.attributePivot` arm was effectively dead code (EAV members carry empty
`columns`). This contradicted the docstring/ticket, which claimed that arm handled EAV.
Fixed `routeAssignment` to detect an EAV-served column off the projection map
(`viewColToBaseRef`: a logical column the get body projects as a non-column expression is
EAV-served, distinct from a name the body never projects) and raise the documented
`unsupported-decomposition-update` with the EAV-pivot message, while a genuine non-column
stays a plain `no-inverse`. Regression test added (`update set p=… ⇒ /EAV pivot member/`,
`update set notacol=… ⇒ /not backed by any decomposition member/`, atomicity asserted).

**Cross-member UPDATE value references — was untested, NOW TESTED (minor gap closed).**
`rewriteAssignedValue` correctly strips the owner member's qualifier and rejects a value
referencing a *different* member. Added cases: a self-member value (`set b = b + 1`,
`set a = a * 2`) succeeds; both cross directions (`set a = b + 1` anchor←non-anchor and
`set b = a + 1` non-anchor←anchor) reject with `cross-member assignment`.

**Anchor-update self-reference vs anchor-delete bare-predicate — CHECKED, not a bug,
documented.** The anchor DELETE uses a bare predicate (the implementer's comment notes an
IN-subquery would self-reference the rows it removes), but the anchor UPDATE goes through
the uniform `memberUpdateOp` and uses `id in (select id from anchor where <pred>)` — a
self-referencing subquery. Probed the Halloween shapes (`set a=99 where a=10`,
`set a=a+1 where a<100`, `set a=10 where a=5`): all correct, because the engine
materializes the IN row-set once and the key column is never updated (shared-key updates
are rejected up front), so the set is stable. This is an inconsistency, not a defect — no
change made. A future cleanup could give the anchor UPDATE the same bare-predicate form
as the anchor DELETE for symmetry; not worth a ticket.

**Deferral diagnostics — CHECKED.** INSERT, a non-anchor-member predicate (including an
EAV-column predicate, which maps to a correlated subquery and is caught by the
subquery/non-anchor guard), an optional-member UPDATE, and a composite key each raise
their intended diagnostic, and the deferred write is atomic (asserted nothing changed).

**Docs — CHECKED, accurate.** `docs/lens.md` § The Default Mapper and
`docs/view-updateability.md` § propagate/decomposition now describe the shipped
DELETE/UPDATE and the four deferrals; the EAV fix makes the documented
`unsupported-decomposition-update`-for-EAV behavior actually true (it was aspirational
before). No further doc edits needed.

**Not exhaustively covered — assessed, no new ticket warranted for this slice:**
- *Mutation context across the fan-out* — `contextValues` is threaded into every member
  statement structurally; not behaviorally pinned. For the logical-tuple DELETE/UPDATE
  slice there is no surrogate generation, so context is a pass-through; the per-row
  evaluate-once-and-thread cadence is the deferred insert envelope's charter.
- *Conflict / FK ordering across member ops* — RETURNING is rejected
  (`returning-through-view`); UPDATE has no upsert clause and DELETE has no on-conflict,
  so conflict composition is not reachable on this slice, and decomposition members are
  stitched by the shared key (an existence-anchor IND models totality), not inter-member
  SQL FKs. The load-bearing conflict/FK/surrogate-ordering case is INSERT, which is
  deferred to `lens-multi-source-put-insert-fanout` — the right place for it.
- *`yarn test:store`* — not run (slow store-path re-run, deferred per the implement note);
  a human/CI pass should exercise the store write path before release.

**Test result.** `yarn workspace @quereus/quereus test` → **4163 passing, 9 pending, 0
failing** (the 9 pending are pre-existing). `lint` and `typecheck` clean. The committed
`lens-put-fanout.spec.ts` now carries the EAV-update and cross-member-value regressions in
addition to the original 12 happy-path / deferral cases.
