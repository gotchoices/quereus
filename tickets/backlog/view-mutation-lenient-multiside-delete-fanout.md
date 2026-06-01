description: Implement the doc's maximal **lenient** multi-side delete fan-out for join views — an ambiguous join delete should "make the joined row not exist" by deleting from every candidate side, rather than being rejected. Requires snapshot-consistent base-op execution (or eager key materialization) so the second side's join subquery is not invalidated by the first side's delete.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/view-updateability.md

## Background

The `quereus.update.*` tag override surface (ticket `view-mutation-tag-override-surface`,
shipped in Phase 3.4) realizes `target` / `exclude` / `delete_via` / `policy` / `default_for`.
During that work the doc's *maximal lenient* reading of an ambiguous join delete — delete from
**every** candidate side, the predicate-honest "make this row not exist" — was deliberately
**deferred**. Today, an ambiguous multi-source delete (two candidate sides, no provable FK, no
resolving tag) is **rejected** with a structured `delete-ambiguous` diagnostic under the default
`lenient` policy; `policy=strict` additionally rejects even the FK-resolvable case.

This is documented in `docs/view-updateability.md` § Inner Join ("Shipped behavior vs. intent")
and the Phase 3.4 Status-table footnote. It is a defensible reading of "reject any ambiguity," but
it differs from the doc's framing that lenient *fans out*.

## Why it was deferred (the hard part)

A join view's per-side delete addresses rows via a subquery over the **join body**
(`delete from <side> where <pk> in (select <pk> from <join> where <predicate>)`). The
view-mutation substrate (`runtime/emit/view-mutation.ts`) runs base ops **sequentially against
live state**. So deleting one side empties the join before the second side's subquery runs —
under either ordering, the second delete sees zero matching rows and the fan-out loses rows.

A correct fan-out needs one of:
- **snapshot-consistent base-op execution** — each side's identifying subquery evaluates against
  the pre-statement snapshot of the join, not the mutated live state; or
- **eager key materialization** — resolve and freeze the per-side PK sets to delete *before*
  running any base delete, then delete by frozen key lists.

## Scope / expected behavior

- Under `lenient` (default), an ambiguous multi-side join delete deletes the joined row's
  contribution from every candidate side (after `target`/`exclude` narrowing), instead of raising
  `delete-ambiguous`.
- `policy=strict` continues to reject ambiguity (no behavior change).
- `delete_via` / `target` continue to pin a single side (no behavior change).
- Decide the interaction with FK cascades when fanning out across both an FK-parent and FK-child
  side (avoid double-deleting a cascaded child).
- Update `docs/view-updateability.md` to move this from "deferred" to "shipped" and drop the
  "Shipped vs. intent" caveat.

## Notes

This is future work, not a regression — the shipped reject-on-ambiguity behavior is safe and
tested. Sequence/priority is a human call; it is the natural next increment on the join
write-through path.
