description: A commit-time set-level (logical unique/PK) uniqueness CHECK is threaded onto EVERY base op of a decomposition UPDATE — including member UPDATEs that do not carry the logical key column. When the logical PK is not carried by every member AND has no basis covering structure (the natural surrogate-keyed shape), the member UPDATE fails to BUILD with `QuereusError: NEW.<keycol> isn't a column`. Discovered while writing test coverage for `view-write-decomp-update-test-coverage`.
files: packages/quereus/src/planner/building/view-mutation-builder.ts (extraConstraints threading, ~L144-176 + buildBaseOp ~L843-865), packages/quereus/src/planner/mutation/lens-enforcement.ts (collectLensSetLevelConstraints ~L589), packages/quereus/src/planner/mutation/decomposition.ts (member fan-out: memberUpdateOp / emitOptionalMemberUpdate), packages/quereus/test/lens-put-fanout.spec.ts (surrogate-keyed optional-member UPDATE describe — fixture currently carries a workaround `doc_key text unique`), docs/view-updateability.md (§ Current limitations)
----

## Symptom

A decomposition-backed logical table whose **logical primary/unique key is not carried by every
member** and **lacks a basis covering structure** cannot be UPDATEd at all — the statement throws at
**plan-build time**, before any row is touched:

```
QuereusError: NEW.doc_key isn't a column
  at resolveColumn (planner/resolve.ts)
  at buildConstraintChecks (planner/building/constraint-builder.ts)
  at buildUpdateStmt (planner/building/update.ts)
  at buildBaseOp (planner/building/view-mutation-builder.ts:756)
  at buildViewMutation (planner/building/view-mutation-builder.ts:162)
```

This is a hard error (build failure), not a silent correctness bug — the affected schema's UPDATE path
is entirely unusable.

## Reproduction

In `packages/quereus/test/lens-put-fanout.spec.ts`, the `surrogate-keyed optional-member UPDATE`
describe declares its anchor `doc_key text unique` **specifically to dodge this bug**. Drop the
`unique` (anchor becomes `doc_key text`) and all four tests in that describe throw
`NEW.doc_key isn't a column` on the very first `update x.Doc set …`. (Confirmed empirically during
review of `view-write-decomp-update-test-coverage`.)

Minimal shape:
- surrogate decomposition: anchor `Doc_core(sid pk, doc_key text, title)`, optional member
  `Doc_meta(meta_sid pk, note)`, shared key `surrogate` (`sid`/`meta_sid`).
- logical `Doc { docKey text primary key, title, body, note }`, mapping `docKey → Doc_core.doc_key`.
- any `update x.Doc set note = … where docKey = …` → build throws.

## Root cause

1. The logical PK `docKey` maps to `Doc_core.doc_key`. With no basis UNIQUE on `doc_key`, the lens
   prover has **no covering structure** for it, so it classifies the key
   `enforced-set-level` / `mode: 'commit-time'`.
2. `collectLensSetLevelConstraints` (`lens-enforcement.ts`) synthesizes a deferred count-subquery
   uniqueness CHECK whose `NEW.*` side references the **basis** key column `doc_key`.
3. `buildViewMutation` (`view-mutation-builder.ts` ~L144-151) computes `extraConstraints` **once** and
   then `baseOps.map(op => buildBaseOp(ctx, op, extraConstraints, …))` (~L162/L175) threads that SAME
   list onto **every** base op of the fanned-out UPDATE — anchor AND members alike.
4. The `Doc_meta` member UPDATE targets only `Doc_meta(meta_sid, note)` — it does not carry (and
   cannot change) `doc_key`. `buildConstraintChecks` therefore can't resolve `NEW.doc_key` and throws.

Decomposition **INSERT** member ops dodge this because `buildDecompositionMemberInsert` passes `[]`
extras — which is why every insert-only surrogate fixture never surfaced it.

Logical-**tuple** decompositions never hit it either: their logical PK *is* the stitch key, present on
every member and basis-PK-unique, so the key proves out and no commit-time set-level CHECK is ever
synthesized. The bug is specific to: **logical PK not carried by every member + no basis uniqueness**,
i.e. the natural surrogate-keyed case.

## Expected behavior

The set-level uniqueness obligation should ride **only the op(s) that can introduce a duplicate of the
logical key** — the op(s) whose target carries (and can change) the key column(s). A member UPDATE that
neither carries nor can alter the logical key cannot create a duplicate, so threading the CHECK onto it
is both wrong (build failure) and semantically over-broad even if it could build.

After the fix, the reproduction above (anchor `doc_key text`, no UNIQUE) must build and run: a
`update x.Doc set note = …` fans out, the uniqueness CHECK rides only the op that owns `doc_key` (or is
omitted entirely for an UPDATE that does not touch the key), and the member UPDATE builds cleanly.

## Scope / design notes

- The likely fix is in `view-mutation-builder.ts`'s `extraConstraints` threading: filter (per base op)
  the set-level constraints down to those whose referenced `NEW.*` columns are resolvable on that op's
  target — or, more precisely, route a set-level uniqueness CHECK only onto the op that owns the key
  columns. (The same per-op resolvability question may apply to other `extraConstraints` classes —
  row-local CHECKs, FK existence checks — for a multi-op decomposition fan-out; audit whether any of
  those reference columns a given member op cannot carry, and gate uniformly rather than per-class.)
- Alternatively / additionally, `collectLensSetLevelConstraints` could carry enough metadata (the
  owning member / key columns) for the threading site to target correctly.
- An UPDATE that does **not** assign any logical key column cannot create a duplicate at all — consider
  whether the set-level CHECK should be emitted for such an UPDATE in the first place (it currently is,
  via `operations: INSERT | UPDATE`). A key-unchanged UPDATE provably preserves uniqueness.
- Remove the `doc_key text unique` workaround in `lens-put-fanout.spec.ts`'s `setupSurrogateOptional`
  (revert to `doc_key text`) as part of the fix, so the corner-#2 tests pin the fixed path directly.
  Add a regression test for the no-basis-uniqueness surrogate UPDATE.
- Update `docs/view-updateability.md` § Current limitations: this is currently an undocumented build
  failure; once fixed, ensure no stale "deferred" note is added (it should just work) — or, if any
  residual shape stays deferred, document precisely which.

## Verification

- `yarn workspace @quereus/quereus test --grep "surrogate-keyed optional-member UPDATE"` with the
  `unique` workaround removed → all four green.
- Full `yarn workspace @quereus/quereus test` + `lint` clean.
