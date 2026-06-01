description: The lens parent-side FK UPDATE short-circuit guard uses plain `=`, so updating a *nullable* referenced parent key from a value to NULL while a child still references the old value is wrongly ALLOWED (silently orphans the child), diverging from physical RESTRICT which rejects it. Narrow (nullable referenced columns only; unreachable for NOT-NULL/PK keys) but a genuine soundness gap. Make the guard null-safe (`IS NOT DISTINCT FROM`-equivalent) without requiring a general `IS` operator.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

## Problem

The lens parent-side FK enforcement (`lens-parent-side-fk-enforcement`, shipped) reproduces
the physical parent-side RESTRICT UPDATE short-circuit in-AST via `buildParentSideUpdateGuard`:

```
( (OLD.p1 = NEW.p1 and … and OLD.pn = NEW.pn) or <NOT EXISTS over OLD> )
```

The equality uses plain `=` (not a null-safe comparison). This was an explicit mandate of the
source plan ticket. For a NOT-NULL referenced key (the common case — FKs usually reference a
PK) this is exact. But for a **nullable** referenced parent key it admits an orphaning update:

- Schema: `parent(id pk, email text unique null)`, `child(... pemail references parent(email))`.
- Data: `parent(1, 'a@x')`, `child(10, 'a@x')`.
- `update x.parent set email = null where id = 1`:
  - guard `OLD.email = NEW.email` = `'a@x' = NULL` = **NULL**
  - `NULL or <false NOT EXISTS>` = **NULL**
  - the deferred-constraint check fails only on `value === false || value === 0`
    (`runtime/deferred-constraint-queue.ts`), so **NULL passes** ⇒ the update is **allowed**,
    leaving `child(10)` referencing a now-absent `email='a@x'`.

Physical RESTRICT (`buildParentSideFKChecks` + `emit/constraint-check.ts`) **rejects** this:
the referenced column *changed*, so the short-circuit does not fire and the immediate
`NOT EXISTS` over `OLD='a@x'` finds the child ⇒ ABORT.

**Empirically confirmed** during review (`lens-parent-side-fk-enforcement` review pass): a
standalone probe printed `ABORTED? false` with the child row left dangling.

## Why it is parked (not a blocker)

- **Narrow.** Requires an FK that references a *nullable* unique column — unusual; references
  to NOT-NULL / PK columns (the overwhelming majority) are unreachable.
- The shipped behavior **follows the source ticket's explicit plain-`=` mandate**.
- The fix needs a small **design decision**: Quereus has no general `is`/`is not distinct from`
  operator surface for synthesized constraint ASTs. Options:
  1. Synthesize a null-safe equality as `((OLD.p = NEW.p) or (OLD.p is null and NEW.p is null))`
     per column — verbose but uses only existing `is null` + `=` + `or`/`and` nodes.
  2. Drop the per-column guard and instead reproduce the physical "did any referenced column
     change" test some other way (e.g. a `referencedColumnIndices`-style runtime hook on the
     routed constraint), aligning with how the physical path skips via `referencedColumnIndices`.
  3. Note that option 1 must still preserve the *benign-update* short-circuit (the existing
     `lens enforcement: parent-side FK … short-circuit guard` test must stay green): a value→value
     no-op update keeps `OLD.p = NEW.p` true, and a NULL→NULL no-op must short-circuit true via the
     added `is null and is null` arm.

## Acceptance

- A nullable referenced parent key updated value→NULL while a child references the old value
  is **rejected** (parity with physical RESTRICT), via a null-safe guard built from existing
  AST node kinds (no new operator).
- The existing benign-update short-circuit behavior is preserved (no regression): updates that
  do not change the referenced key — including NULL→NULL — still pass without running the
  `NOT EXISTS`.
- Add tests: (a) value→NULL orphaning update ABORTs; (b) NULL→NULL benign update on a
  referenced row still succeeds; (c) value→value benign update (non-key column) still succeeds.
- Update the `docs/lens.md` parent-side FK paragraph to drop the documented v1-divergence
  caveat once closed.
