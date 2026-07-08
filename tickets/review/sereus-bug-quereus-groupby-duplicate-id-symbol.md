---
description: Verify the fix for the crash that happened when a query grouped by two same-named columns from different tables (e.g. `group by i.id, c.id`); it now groups correctly instead of failing.
files:
  - packages/quereus/src/planner/scopes/registered.ts            # RegisteredScope — added markAmbiguous / getAmbiguousSymbols
  - packages/quereus/src/planner/building/select-aggregates.ts   # createAggregateOutputScope rewrite + HAVING hybrid-scope ambiguity copy
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # new regression cases (bottom of file)
difficulty: medium
---

# Review: GROUP BY of two qualified same-base-name columns no longer crashes

## What the bug was

`GROUP BY i.id, c.id` (two *qualified* columns whose base names collide) crashed at
plan time with `QuereusError: Symbol 'id' already exists in the same scope.` Standard
SQL permits this; the sibling query without GROUP BY worked. Root cause: after the
`AggregateNode` advertises one output attribute per GROUP BY key named by the key's
**base** column name, `createAggregateOutputScope` registered each output attribute
into a flat `RegisteredScope` keyed by the bare lowercased name. Two keys named `id`
→ second `registerSymbol('id')` threw.

## What changed

**1. `RegisteredScope` gained explicit ambiguity** (`registered.ts`)
- New `private ambiguousSymbols: Set<string>`.
- `markAmbiguous(key)` — records a key as ambiguous; never throws (unlike
  `registerSymbol`, whose duplicate-throw stays as a genuine guard for other callers).
- `resolveSymbol` now returns `Ambiguous` for a marked key **before** delegating to
  the parent scope — so a bare ambiguous reference cannot silently fall through and
  bind to the wrong pre-aggregate source column in the parent.
- `getAmbiguousSymbols()` — lets a derived scope copy the marks.

**2. `createAggregateOutputScope` rewritten** (`select-aggregates.ts`) to mirror
source-side (FROM/JOIN) naming semantics:
- Counts bare-name owners by **column identity** (`qualifier.name`, or bare name, or
  a per-aggregate token) so a genuine collision is distinguished from a degenerate
  duplicate.
- Always registers the **qualified** key `qualifier.name` (deduped) for a qualified
  column group key → `i.id` and `c.id` resolve distinctly.
- Registers the **bare** key only when unique; otherwise `markAmbiguous(bareKey)`.
- Aggregate aliases register as before, but an alias colliding with a group-key base
  name (or another alias) is marked ambiguous instead.

**3. HAVING hybrid scope carries the marks** (`select-aggregates.ts`
`buildHavingFilter`) — after copying the aggregate output scope's symbols it also
copies its ambiguous marks, so a bare ambiguous reference in HAVING stays ambiguous
rather than binding to the source-column fallback that method registers.

The physical selection is unaffected: the fix is entirely in the logical building
phase, so both HashAggregate and StreamAggregate inherit it (they don't rebuild this
scope).

## How to validate

Build + tests + lint all pass locally (memory vtab):
- `cd packages/quereus && yarn build` — clean
- `yarn test` — 6432 passing, 9 pending
- `yarn lint` — clean

New regression cases live at the bottom of
`packages/quereus/test/logic/07.3-group-by-extras.sqllogic`. Run just that file with:
`node test-runner.mjs --grep "07.3-group-by-extras"` (from `packages/quereus`).

Cases covered:
- **The exact repro** — `select i.id, i.name, c.id as categoryId, c.name as categoryName, count(lei.entry_id) as usageCount ... group by i.id, i.name, c.id, c.name` over a 3-table join with a bound `?` param — groups correctly; qualified/aliased SELECT columns resolve to the right keys; `usageCount` is 0 for the left-join-miss group.
- **Qualified ORDER BY** (`order by c.id, i.id`) resolves to group keys.
- **Qualified HAVING** (`having i.id >= 2`) resolves to a group key.
- **Aliased duplicate projection** (`i.id as a, c.id as b`) → distinct output columns, no crash.
- **Degenerate duplicate key** (`group by i.id, i.id`) → no crash, qualified key resolves.
- **Negative — bare ambiguous HAVING** (`having id` with two `id` group keys) → `-- error: ambiguous column name: id` (exercises the ambiguity mark via the HAVING hybrid scope).
- **Regression** — single-table `group by c.id, c.name` still works.
- Pre-existing bare `group by grp` cases in the same file still pass.

## Known gaps / notes for the reviewer (treat tests as a floor)

- **Optional message enrichment was DEFERRED.** The ticket's point 1 (clearer message)
  is satisfied for the reported case without bespoke work: the valid query no longer
  errors, and the only remaining error path (a genuinely ambiguous *bare* reference)
  already yields the actionable `ambiguous column name: id`. The suggested low-priority
  enrichment of `RegisteredScope.registerSymbol`'s generic "Symbol '…' already exists"
  message to name the clause/columns was **not** done — it's out of the hot path and
  not required by this ticket.

- **The bare-ambiguous negative case:** for a bare ambiguous ref in the **SELECT list**
  (rather than HAVING), the error is actually raised earlier by source-side scope
  ambiguity (two source `id` columns in the join), not by the new aggregate-scope mark
  — same observable message. I therefore exercised the *aggregate-scope* mark through
  **HAVING**, where the source columns would otherwise resolve via the fallback. A
  reviewer wanting SELECT-list coverage of the mark specifically would need a shape
  where the bare name is unambiguous at the source but ambiguous only post-grouping,
  which the two-qualified-keys construction cannot produce (both sources carry the
  base name). Worth a second look if you disagree that HAVING is sufficient.

- **Adjacent, out-of-scope, verified NOT a crash:** a query projecting two
  *unaliased* duplicate base names (`select i.id, c.id, count(*) ... group by i.id,
  c.id`) no longer crashes (it did before, as the ticket's core bug) and now returns
  rows. The two output columns share the name `id`; the engine disambiguates output
  column *names* elsewhere (observed `id` / `id:1`), and `db.eval`'s row→object mapping
  can collapse duplicate keys. This duplicate-output-column *naming* behavior is
  pre-existing and orthogonal to the group-by scope fix — not touched here, and not a
  regression. Flagged only so the reviewer knows it was considered, not overlooked.

- **No new tripwire comments were added** — the fix is localized and self-explanatory;
  the ambiguity rationale lives in doc comments on `markAmbiguous` and in
  `createAggregateOutputScope`.
