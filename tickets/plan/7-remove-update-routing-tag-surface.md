description: Remove the redundant quereus.update.* routing tags (target / exclude / delete_via, and evaluate policy) once the existence/membership presence columns subsume them. Keep default_for (value supply, no column equivalent). Shrinks the override surface to one mechanism: explicit per-row presence columns.
prereq: outer-join-existence-column, set-op-membership-write
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/reserved-tags-policy.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, docs/view-updateability.md, docs/sql.md, docs/lens.md
----

## Why

The view-update model currently controls write routing two ways: predicate-driven branch/side dispatch, plus a `quereus.update.*` tag override surface. Once `outer-join-existence-column` (join sides) and `set-operator-membership-columns` (set-op branches) land, **routing is expressible as explicit, per-row, writable presence columns** — strictly more precise than a statement-level tag, and self-documenting in the data shape. The routing tags then become a redundant second way to say the same thing. Per the directive to "remove most of the tag surface," this ticket deletes them so there is **one** override mechanism.

`docs/architecture.md` notes "Don't worry about backwards compatibility yet," so this is a clean removal, not a deprecation cycle.

## Scope

**Remove (routing — replaced by presence columns):**
- `quereus.update.target`
- `quereus.update.exclude`
- `quereus.update.delete_via`

**Retain (not routing):**
- `quereus.update.default_for.<column>` — supplies *values* for omitted insert columns; orthogonal to routing, no column equivalent.

**Evaluate (decide in the plan stage — do not assume removal):**
- `quereus.update.policy` (`strict` / `lenient`) — governs the **unspecified-case** default (what to do with an ambiguous multi-side delete when the user states *no* presence column). Presence columns resolve ambiguity only when the user uses them; they do not define the default when the user does not. Options: (a) keep `policy` as the unspecified-case knob; (b) fix the default (predicate-honest `lenient`) and drop the knob. Pick one with rationale.

## What the removal touches

- **Reserved-tag registry** (`reserved-tags.ts` / `-policy.ts`) — drop the removed keys from the typed registry so an occurrence becomes the standard hard "unknown tag" error (the registry is the single source of truth for the whole `quereus.*` namespace; the lens compiler / advertisement builder / declarative differ all validate through it, so no other call site needs editing).
- **Collection + consumption** (`mutation-tags.ts`, and the single-source / multi-source / decomposition spines) — remove the routing-tag read paths; the predicate-driven dispatch + presence columns are the remaining inputs.
- **Docs** — `docs/view-updateability.md` § Tags (rewrite to: predicates + presence columns + retained `default_for`), the per-operator sections that reference `delete_via` (Inner Join delete, Except, Intersect), and `docs/lens.md` / `docs/sql.md` cross-references.

## Open questions for the plan stage

- **`policy`** disposition (above).
- **View-DDL-level blanket routing.** `target` / `exclude` could appear at view-DDL level as a blanket "this view only ever writes relation X" restriction — which a per-row column does not reproduce. Confirm this blanket capability is acceptable to drop (lens shape / column non-exposure controls write reach instead), or design a replacement before removal.
- **Migration of existing tests/usages.** Sweep `test/` and sample schemas for the removed keys; convert routing-tag tests to presence-column equivalents so coverage is preserved, not deleted.

## Expected end state

- A `quereus.update.target` / `exclude` / `delete_via` tag anywhere is an unknown-tag error.
- Every routing outcome those tags expressed is reachable via an existence/membership column (or is the documented predicate-honest default).
- `default_for` (and possibly `policy`) remain, documented as the only retained `quereus.update.*` keys.
- Docs describe one override story: predicates rule; presence columns state per-row routing explicitly; `default_for` supplies missing values.

## Tests

- The View Round-Trip Laws families that previously exercised `delete_via` (multi-source delete, `except` right-insert, `intersect` single-side) now exercise the presence-column equivalents and still pass.
- A removed-tag occurrence raises the unknown-tag diagnostic (registry-level).
- No remaining reference to the removed keys in `src/`, `test/`, `docs/`, or sample schemas.
