----
description: Regression test guarding the refill-path declared-arity guard in importMaterializedView (assertDeclaredColumnArity hoisted ABOVE the adopt/refill branch + drop). Twin of the existing adopt-path arity test. Test-only — the production fix already landed in maintained-table-unified-model.
files:
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts        # the new refill-path twin (~line 255)
  - packages/quereus/src/schema/manager.ts                        # importMaterializedView: assertDeclaredColumnArity (line 2767) above preExisting/drop (2805) + materializeView (2813)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # assertDeclaredColumnArity + materializeView (re-asserts internally, post-drop)
  - docs/materialized-views.md                                    # § Cross-module atomicity, line 116 (property already documented, path-independent)
----

## Summary

Implement added one regression test to `mv-rehydrate-adopt.spec.ts` — a refill-path twin of
the existing adopt-path declared-arity test. It exercises a stale-at-close MV (`mv (a, b)` over
a `select *` body widened to 3 columns by a session-2 `alter table src add column w`) and asserts
that on the next reopen the entry errors per-entry (`/2 declared columns but body produces 3/i`)
with the durable backing **preserved** (no maintained record, backing still registered as a plain
table, sentinel row intact). No production change — the fix landed earlier in
`maintained-table-unified-model` (the arity guard hoisted above the adopt/refill branch).

## Review findings

### What was checked

- **Read the implement diff first** (commit `defe45de`) with fresh eyes before the handoff: a
  single `it(...)` added after the adopt-path twin, plus the ticket move.
- **Routing — is the "refill twin" genuinely a refill, not a disguised adopt?** Confirmed it is.
  The sibling test at `mv-rehydrate-adopt.spec.ts:196-219` uses the *identical* setup (no marker
  re-arm + `alter src add column`) and asserts the sentinel is **destroyed** by a successful
  refill — proving this setup routes through the refill branch (`trustBackings: false`). The
  adopt-path twin must re-arm `[]` precisely *because* the default is refill. `docs/materialized-views.md:114`
  independently confirms the premise: any `table_modified` on a source (an ALTER) detaches
  row-time maintenance → the MV is stale-at-close → `trustBackings: trusted && !staleAtClose.has(name)`
  is false.
- **Does the test actually catch its target regression?** Verified by mutation: commented out the
  line-2767 `assertDeclaredColumnArity(def, shape)` guard, **rebuilt quereus** (store tests import
  the built `dist`, not `src` — a first mutation attempt without a rebuild was a false negative),
  and re-ran. Both arity twins then **fail** with `backing still registered: expected undefined not
  to be undefined` — the backing was dropped before the error. With the guard restored + rebuilt,
  both pass. The test is a real guard, not a tautology.
- **Production structure** (`schema/manager.ts:2764-2813`): `deriveBackingShape` (2764) and
  `assertDeclaredColumnArity` (2767) both fire above the `preExisting`/`dropTable` block (2805) and
  above `materializeView` (2813). `materializeView` re-asserts internally but only *after* its own
  drop-on-fail — so removing the top-level guard genuinely reintroduces drop-before-check on the
  refill path. The two-catalog-entry model (a STORE-hosted maintained table persists both a
  table-key backing entry connected in phase 1 and an mview-key entry imported in phase 3,
  `store-module.ts:2244-2246`) is what makes `preExisting` defined and the drop reachable.
- **Docs**: `docs/materialized-views.md:116` already states the property path-independently
  ("A declared-column arity mismatch ... errors per-entry with the backing preserved instead of
  dropping first"). Read the surrounding § Cross-module atomicity; it reflects current reality.
  No doc change needed.
- **Test quality**: assertions cover the error (count + message), the absent maintained record,
  the preserved plain-table registration, and the preserved physical sentinel row — i.e. the full
  "preserve-before-drop" contract, not just the happy path.

### What was found

- **Correctness — none.** The test is correctly routed (refill), correctly targeted (verified to
  fail under the exact regression it documents), and its assertions match the production contract.
- **Type safety / lint / build — none.** Build (tsc) clean, quereus lint clean.

### Minor (noted, no change)

- The refill twin and adopt twin are near-duplicates differing by one line (the marker re-arm).
  This is **intentional** twin coverage of two distinct branches (adopt vs refill); the comments
  clearly distinguish them. Matches the file's existing convention.
- Both twins share identical assertions and cannot *internally* prove which branch they took — the
  arity error short-circuits above the adopt/refill split, so there is no path-distinguishing
  observable at the assertion point. Routing is pinned by external invariants (marker semantics +
  the sibling refill test 196-219). Inherent to the guard's placement; not improvable without
  weakening the test. Acceptable.

### Disposition

No major findings — no new tickets filed. No minor findings requiring an inline fix. Empty
fix categories above are empty because the change is a single, well-targeted, verified regression
test with no production-code surface.

### Validation run

- `yarn workspace @quereus/store test` → **536 passing**.
- `yarn workspace @quereus/quereus lint` → clean (exit 0).
- `yarn workspace @quereus/quereus build` (tsc typecheck) → clean.
- Mutation cross-check (guard removed + rebuilt) → both arity twins fail as expected; reverted +
  rebuilt to baseline; working tree clean.
