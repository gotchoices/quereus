description: A partial member self-reference UPDATE on an optional decomposition member that leaves a sibling value column unassigned now **rejects** at plan time whenever that sibling is NOT NULL or carries a non-null default — even for a **null-propagating** self-expression (`set e1 = e1 + 1`) that, by construction, materializes no absent row and therefore can never widen anything. The reject is sound but conservative, and it is a behavior regression: the pre-materialize matched-update-only self path silently accepted these partial writes (present rows updated, absent rows untouched). Recover the previously-working null-propagating case by folding the materialize's null-substituted non-empty filter at plan time: if it folds constant-false (no absent row can materialize), skip the materialize INSERT entirely and its two soundness gates, restoring the present-rows-only behavior.
files: packages/quereus/src/planner/mutation/decomposition.ts (emitOptionalMemberUpdate `hasSelf` branch, buildSelfMaterializeInsertSelect, assertNoUnassignedValueColumnWiden, assertNoMissingNotNull call site), packages/quereus/test/lens-put-fanout.spec.ts (the `rejects a partial self-update that leaves a non-null-defaulted sibling value column unassigned` test pins the current conservative reject — it would flip to an accept for the null-propagating arm if this lands)
----

## Background

The self-reference materialize (ticket `view-write-decomposition-self-reference-null-result-materialization`,
landed) makes `emitOptionalMemberUpdate`'s `hasSelf` branch emit a matched UPDATE **plus** a
materialize INSERT for absent rows. The INSERT runs the same two plan-time soundness gates the
constant/anchor materialize paths use:

- `assertNoUnassignedValueColumnWiden` — an unassigned member value column that would not land
  null (NOT NULL, or has a declared default) cannot materialize without widening the absent row's
  image;
- `assertNoMissingNotNull` — a NOT NULL base column with no default that no value covers cannot be
  created.

Both fire **unconditionally at plan time**, before the runtime non-empty filter is known. So a
null-propagating partial self-update — `set e1 = e1 + 1` on a member whose sibling `e2` carries
`default 7` — is rejected, even though its materialize filter (`(null + 1) is not null` →
constant-false) guarantees **no absent row ever materializes**, hence nothing is ever widened.

## Why it's a regression

The old matched-update-only `hasSelf` branch called **neither** gate (it never materialized), so it
accepted `set e1 = e1 + 1` and correctly updated only the present rows. The new path rejects it.
Sound (never wrong data) but strictly less permissive than what shipped before, and the reject
message ("materializing an absent row … would leave value column 'e2' to a base default") is
misleading for the null-propagating case, which never materializes.

This was a deliberate, documented tradeoff at implement time: the planner could not cheaply
distinguish `e1 + 1` (null-propagating, no materialize) from `coalesce(e1, 0) + 1` (materializes,
genuinely would widen). The current `rejects a partial self-update …` test pins the conservative
behavior on purpose.

## Desired behavior

A self cell's value, after `substituteOwnerColumnsWithNull`, has **no column refs** (the classifier
proved every leaf is the owner's own column) — it is a **constant expression**. So the materialize's
non-empty filter `(<v1> is not null or <v2> is not null …)` is a plan-time constant once each `<vi>`
is folded. Therefore the planner *can* decide statically whether the materialize is dead:

- if the folded filter is **constant-false** (every self cell null-propagates **and** no non-null
  constant sibling) → no absent row can materialize → **skip** the materialize INSERT and its two
  soundness gates → the group degrades to matched-update-only, recovering the old behavior;
- otherwise → emit the materialize INSERT and run the gates as today.

This needs a deterministic constant-fold of the null-substituted value expression (the engine
already has constant folding for deterministic operators/functions; `coalesce`/`iif`/`case` fold
once their args are literals). Non-foldable / volatile expressions stay conservative (emit + gate).

## Acceptance

- `set e1 = e1 + 1` (null-propagating) on `M_def` (`e2 default 7`) **succeeds**, updating present
  rows only, materializing nothing — matching the pre-materialize behavior.
- `set e1 = coalesce(e1, 0) + 1` on the same fixture **still rejects** via the widen gate (it
  genuinely would materialize an absent row and widen `e2`).
- The `assertNoMissingNotNull` analogue holds: a null-propagating partial self-update that leaves a
  NOT-NULL-no-default sibling uncovered succeeds (present rows only), while a null→non-null one
  rejects.
- Flip the `rejects a partial self-update …` test's null-propagating arm to an accept; keep a
  null→non-null arm rejecting. Update `docs/lens.md` § The Default Mapper UPDATE and
  `docs/view-updateability.md` to state the gates fire only when the materialize is statically live.
