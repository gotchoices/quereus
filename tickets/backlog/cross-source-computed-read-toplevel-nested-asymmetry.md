description: Unify cross-source computed-column READ handling between the top-level SET value and a nested value subquery — the top-level path rejects (`no-inverse`) a value-correct read that the nested path admits via per-leaf base capture.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts   # gateCrossSourceReads (forEachTopLevelColumnRef — top-level only), lowerValueOntoSide, stripSideQualifier per-leaf capture
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic  # uq-8 (top-level reject), uq-11 (nested computed-partner read admitted)
difficulty: medium
----

# Unify cross-source computed-column reads: top-level reject vs nested admit

## The asymmetry

A join-view value position that **reads** a computed (non-`base`) partner-side
view column behaves differently by nesting depth:

- **Top level** — `update v set cval = pc` where `pc` is a computed column whose
  lineage reads a *partner* side → rejected at plan time with `no-inverse`
  (`gateCrossSourceReads`, which walks only top-level refs via
  `forEachTopLevelColumnRef`). The diagnostic claims "a cross-source read requires
  the partner column to have base lineage". (Covered by uq-8.)

- **Nested in a value subquery** — `update v set cval = (select max(tv) from t
  where tv < pc)` → **admitted**. `gateCrossSourceReads` sees no top-level `pc`, so
  it never fires; substitution injects `pc`'s side-qualified lineage (`p.pv * 2`),
  and the qualifier strip routes the partner *leaf* (`p.pv`) through the
  `__vmupd_keys` capture per-leaf, applying the scalar expression on read.
  (Covered by uq-11, added by ticket
  `cross-source-unqualified-nested-subquery-scope`.)

## Why it is value-safe today

The nested admission is **not** a correctness bug: every base leaf is captured
**pre-mutation**, the computed scalar applies on read, and (in a single UPDATE) a
bare owning-side leaf already reads the OLD row — so a computed cross-source read
evaluates to the correct pre-mutation value of the column. The `no-inverse` reject
is needed only to **write** a computed column (it cannot be inverted); for a pure
**read** the per-leaf capture is sufficient and the top-level reject is therefore
*over-conservative*.

So the surfaces disagree on which shapes they accept, but neither produces a wrong
result. This is a latent design wrinkle the bare-projection nested-scope change
merely made reachable for bare-projected lineage (it pre-existed for qualified
computed columns).

## Desired resolution (one direction, to be decided)

Pick one and make both depths agree:

1. **Permit at top level too** — let a top-level computed cross-source *read*
   (value position, not an assignment target) ride the same per-leaf capture the
   nested path uses, instead of rejecting `no-inverse`. The reject would narrow to
   the genuinely-uninvertible case: a computed column appearing as an **assignment
   target** (`set pc = …`). This is the more permissive, arguably more correct
   option (the nested path already proves it is well-defined).

2. **Reject at both depths** — extend the computed cross-source-read gate to walk
   nested value subqueries (a deep variant of `gateCrossSourceReads`), so a nested
   computed partner read is rejected with the same `no-inverse` diagnostic as the
   top-level one. More conservative; loses the uq-11 capability (would need uq-11
   re-pointed to an expect-error).

Option 1 is preferred (keeps capability, removes an over-reject) unless there is a
soundness concern with a computed column whose lineage mixes owning- and
partner-side leaves under an owning-site inverse — audit that interaction before
committing to it.

## Acceptance

- Top-level and nested cross-source computed-column **reads** are accepted (or
  rejected) consistently, with a test pinning each depth.
- The `no-inverse` reject continues to fire for a computed column used as an
  **assignment target** at any depth.
- uq-8 / uq-11 updated to reflect the unified rule; docs/view-updateability.md
  § Inner Join, cross-source `set` updated (the "read of a `computed` (non-base)
  partner column is rejected (`no-inverse`)" sentence currently describes only the
  top-level reject).
