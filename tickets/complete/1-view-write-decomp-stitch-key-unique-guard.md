description: COMPLETE — deploy-time guard rejecting a decomposition whose member stitch key (columnar) or EAV `(entity, attribute)` conflict target is not a declared PRIMARY KEY / non-partial UNIQUE. Corner #1 of view-write-decomposition-optional-update hardening. Reviewed; logic correct; +2 regression tests added (partial-UNIQUE skip, anchor rejection); one minor doc-reference fix applied inline.
files: packages/quereus/src/schema/lens-compiler.ts (validatePrimaryAdvertisement + resolveColumnIndices/indicesFormDeclaredUnique), packages/quereus/src/planner/mutation/decomposition.ts (buildOptionalMaterializeInsert / buildEavMaterializeInsert doc comments), packages/quereus/test/lens-put-fanout.spec.ts (describe 'stitch-key uniqueness guard', now 6 tests), docs/lens.md (§ The `put` fan-out)
----

## What shipped

A **deploy-time** guard in `validatePrimaryAdvertisement` (lens-compiler.ts, runs at `apply
schema`) rejects any `primary-storage` decomposition whose materialize conflict target is not a
declared PRIMARY KEY / non-partial UNIQUE on its basis:

- **columnar member** — the stitch key columns (`keyColumnsByRelation.get(member.relationId)`)
  must set-equal a declared PK or non-partial UNIQUE on the member basis. Empty stitch key
  (`primary key ()` singleton) is skipped (no stitch, no materialize path).
- **EAV pivot member** — the conflict target is `(entityColumn, attributeColumn)` (NOT the stitch
  key `entity` alone, which is intentionally one-to-many). That pair must set-equal a declared
  PK / non-partial UNIQUE.
- The **anchor** is validated by the same loop (it is itself a member), so its stitch identity
  must also be 1:1.

This single deploy-time fact underwrites **both** lens directions: the get-side equi-join /
EAV correlated subquery stays single-valued, and the put-side materialize partition is sound
(the `on conflict (<target>) do nothing` only cedes a matched row to the matched UPDATE on a
real declared-unique violation — against a non-unique target the runtime would double-insert).
Two helpers: `resolveColumnIndices` (names→indices, `undefined` on an unresolved name to avoid
double-reporting) and `indicesFormDeclaredUnique` (exact set-equality vs PK / non-partial UCs).
Errors aggregate into the existing `QuereusError`. Plan-time builders document the reliance and
do not re-check. `docs/lens.md § The \`put\` fan-out` records the invariant.

## Review findings

**Diff scope verified.** `git diff 3a5a7ef5 --name-only -- packages/quereus docs/lens.md`
returns exactly the four logic files (lens-compiler.ts, decomposition.ts, lens-put-fanout.spec.ts,
docs/lens.md). The ~896-file `packages/quereus` restoration the implementer performed is
**byte-identical** to the pre-deletion state — no stray edits rode in under the restoration.

**Correctness / SPP / type safety — checked, no issues.**
- Types confirmed against `schema/table.ts`: `primaryKeyDefinition: ReadonlyArray<{index:number}>`,
  `uniqueConstraints?: ReadonlyArray<{columns: ReadonlyArray<number>, predicate?: Expression}>`,
  `columnIndexMap: ReadonlyMap<string, number>`. The helpers consume them correctly; no `any`.
- `indicesFormDeclaredUnique` set-equality is **order-independent** (uses a `Set`) and the
  `pk.length > 0` guard prevents an empty stitch falsely matching an empty PK. Sound.
- The guard runs only in `validatePrimaryAdvertisement` (primary-storage); auxiliary
  advertisements use a separate validator — correct scope.

**Exact-set-equality semantics — verified against the runtime, NOT overly strict.** The
implementer flagged uncertainty about whether the runtime `on conflict` resolver permits a
prefix/permutation match (which would make the guard marginally stricter than necessary). Read
`dml-executor.ts matchUpsertClause`: the `do nothing` clause fires only after the vtab reports
`result.constraint === 'unique'`, i.e. only on a real declared PK/UNIQUE violation. A conflict
target that is a *subset* of a composite key never triggers that violation on the target alone
(the full composite isn't violated), so `do nothing` would not fire and the matched row would be
double-inserted. Exact set-equality is therefore **necessary**, not conservative. (Permutations
are tolerated by both the guard's `Set` and the resolver's index-wise compare.) Concern resolved.

**Doc reference — minor, fixed inline.** The new code/test comments cited
`docs/view-updateability.md § Decomposition put fan-out`, a heading that does not exist there
(only a table row). The prose the implementer actually wrote lives in `docs/lens.md` under
`#### The \`put\` fan-out`. Repointed the two stale references (lens-compiler.ts:1649 comment,
lens-put-fanout.spec.ts:1207 docstring) to `docs/lens.md § The \`put\` fan-out`.

**Test coverage — extended; two flagged gaps now pinned.** Added two regression tests to the
`stitch-key uniqueness guard` describe (now **6 tests**, full suite **4913 passing / 9 pending**):
- *reject: partial UNIQUE on the stitch column* — a `create unique index … where id > 0` on the
  stitch column is rejected. This exercises the `predicate !== undefined` skip **end-to-end**,
  which was previously asserted only by code-read.
- *reject: non-unique anchor stitch key* — a non-unique anchor stitch is rejected, locking the
  "anchor validated like any member" branch (all prior fixtures gave the anchor a PK stitch, so
  the reject path through the anchor was untested).
The implementer's four originals (reject columnar, reject EAV, accept UNIQUE-not-PK round-trip,
accept singleton) plus the file's existing PK-stitch regression fixtures (`split`, `multiSplit`,
`eavSplit`, surrogate, self-decomposition, empty-schema) all pass — they would fail if the guard
wrongly rejected a valid 1:1 stitch.

**Validation run.** `yarn lint` clean, `yarn typecheck` clean, `yarn test` (in-memory vtab)
**4913 passing / 9 pending**.

**Accepted deferrals (low risk, documented not fixed).**
- *Not run under `yarn test:store` (LevelDB).* The guard is pure schema-shape validation,
  independent of the storage module; per AGENTS.md `test:store` is reserved for store-specific
  diagnosis. Storage divergence is implausible for a deploy-time shape check. Left to CI/full.
- *`.pre-existing-error.md` is absent* — expected. The triage commit `bc38869e` ran after the
  implement commit, found the deletion already restored (nothing to fix), and consumed the file.
  This matches the implementer's prediction. No action.

**No major findings → no new tickets filed.** All findings were minor and fixed in this pass
(doc reference) or were test-coverage additions. The guard logic is correct as implemented.
