description: Review the two test additions hardening the shipped decomposition optional/EAV UPDATE materialization — a surrogate-keyed optional-member UPDATE (matched / absent-materialize / all-null-delete / no-op) and a GetPut over the optional value column (view-image idempotence across materialize / delete / lingering-all-null). Test-only; no production code changed. NOTE a real production gap was discovered during implement and worked around in the fixture — see ## Known gaps / findings.
prereq: view-write-decomp-stitch-key-unique-guard
files: packages/quereus/test/lens-put-fanout.spec.ts (new `surrogate-keyed optional-member UPDATE` describe), packages/quereus/test/property.spec.ts (3 new tests + `deployMultiValueOptional` in the `decomposition fan-out` describe), packages/quereus/src/planner/building/view-mutation-builder.ts (extraConstraints threading, reference), packages/quereus/src/planner/mutation/lens-enforcement.ts (collectLensSetLevelConstraints, reference), packages/quereus/src/planner/mutation/decomposition.ts (buildOptionalMaterializeInsert / singleKeyColumn / emitOptionalMemberUpdate, reference)
----

## What landed

Two pure test additions (no production source changed) closing the two coverage corners from
the `view-write-decomposition-optional-update` review hardening.

### Corner #2 — surrogate-keyed optional-member UPDATE (`lens-put-fanout.spec.ts`)

New describe `lens decomposition put: surrogate-keyed optional-member UPDATE`. A surrogate
decomposition with an **optional** member alongside a mandatory one, the surrogate spelled
**distinctly** across all three relations:

- anchor `Doc_core(sid pk default (coalesce((select max(sid) …),0)+mutation_ordinal()), doc_key text unique, title)` — maps `docKey`→`doc_key`, `title`→`title`.
- mandatory `Doc_body(doc_sid pk, body)` — maps `body`→`body`.
- **optional** `Doc_meta(meta_sid pk, note)` — maps `note`→`note`.
- `sharedKey: surrogate`, `keyColumnsByRelation = { Doc_core:[sid], Doc_body:[doc_sid], Doc_meta:[meta_sid] }`.
- logical `Doc { docKey text primary key, title, body, note }`; seed `Doc_meta` only for k1 (sid 100).

Four `it`s (each asserts base `Doc_meta` **and** the `x.Doc` view image):
- **matched UPDATE** — `set note='m1b' where docKey='k1'` updates `Doc_meta(meta_sid 100)`; no new row.
- **absent → materialize INSERT** (the headline thread-through) — `set note='m2' where docKey='k2'`
  materializes `Doc_meta` with `meta_sid = 101`, the **existing** anchor `sid` for k2 threaded into
  the distinctly-spelled member key — NOT a freshly minted surrogate. `buildOptionalMaterializeInsert`
  reads `select Doc_core.sid …` (it does not re-evaluate the anchor default; that fires only for a
  brand-new logical row at INSERT).
- **all-null DELETE** — `set note=null where docKey='k1'` removes the component (`note` is the
  member's only value column); view `note` for k1 reads null.
- **null write to an already-absent component is a no-op** — `set note=null where docKey='k2'`
  (k2 never had a `Doc_meta` row): no materialize INSERT fires (the fan-out emits one only when
  some assigned value is non-null), the absent component stays absent, k1's present component is
  untouched.

### Corner #3 — GetPut over the optional value column (`property.spec.ts`, `decomposition fan-out`)

- **(a) Property `GetPut (columnar, over c)`** (`numRuns: 40`) — reuses `deployColumnar`. Reads the
  full view image, then writes **every** read column back (`a, b, AND c`), per visible row, and
  re-asserts the view image equals the pre-write image. Oracle is **view-image** equality (see the
  load-bearing note below). Counters guard that both the present-`c` arm (same-value matched UPDATE +
  ceded materialize INSERT) and the absent-`c` arm (all-null no-op) are exercised.
- **(b1) Deterministic `single-value c`** — `deployColumnar`, id 1 present (c) / id 2 absent.
  materialize (absent→INSERT) then re-put; delete (all-null) then re-put; view image stable across both.
- **(b2) Deterministic `lingering-all-null`** — a new in-test `deployMultiValueOptional`
  (`T2_core(id,a)` + optional `T2_opt(id,c1,c2)`, logical-tuple `id`). Two **partial** null writes
  (`set c2=null`, then `set c1=null`) leave the row present-but-all-null (partial-null does not
  delete). A GetPut writing both read nulls back (`set c1=null, c2=null`) fires the all-value-columns
  -null DELETE, collapsing present-all-null → absent. The **view image is identical** across the
  collapse; the test additionally asserts `main.T2_opt` has no row for id=1 to document the intended
  representational collapse.

## Validation performed

- Full quereus suite (`yarn workspace @quereus/quereus test`): **4920 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint`: clean (exit 0).
- Focused decomposition subset (both spec files, `--grep decomposition`): 78 passing, including the 7
  new tests.

## Known gaps / findings (treat the tests as a floor)

**FINDING — real production gap, worked around in the fixture (reviewer: candidate fix ticket).**
The ticket's corner-#2 design spelled the anchor `doc_key text` (no UNIQUE). With that fixture the
four corner-#2 tests **fail to build** with `QuereusError: NEW.doc_key isn't a column`. Root cause:

- The logical PK `docKey` maps to `Doc_core.doc_key`, which (without UNIQUE) has **no basis covering
  structure**, so the prover classifies it `enforced-set-level` / `commit-time` and
  `collectLensSetLevelConstraints` (lens-enforcement.ts) synthesizes a count-subquery uniqueness
  CHECK whose `NEW.*` side references the **basis** key column `doc_key`.
- `buildViewMutation` (view-mutation-builder.ts ~L144-176) threads that constraint, via
  `extraConstraints`, onto **every** member base op of an UPDATE — including the `Doc_meta` member
  UPDATE, which does not carry `doc_key`. `buildConstraintChecks` then can't resolve `NEW.doc_key` and
  throws. (Decomposition **INSERT** member ops dodge this — `buildDecompositionMemberInsert` passes
  `[]` extras, view-mutation-builder.ts ~L716 — which is why every existing insert-only surrogate
  fixture never surfaced it.)
- This is reachable for any decomposition whose logical PK is **not** carried by every member **and**
  lacks basis uniqueness (surrogate is the natural case). Logical-tuple decompositions never hit it:
  their logical PK is the stitch key, present on every member and basis-PK-unique, so no commit-time
  set-level CHECK is ever synthesized.

**Workaround taken:** the fixture declares `doc_key text unique`. This is the realistic surrogate
shape (natural key UNIQUE on the basis; the surrogate `sid` is the internal stitch) and gives `docKey`
a basis covering structure, so no commit-time set-level CHECK is synthesized and the member UPDATE
builds. Corner #2's actual subject — the anchor-surrogate-into-distinct-member-key thread — is
unaffected by the UNIQUE and is fully pinned. **To reproduce the gap:** drop `unique` from `doc_key`
in `setupSurrogateOptional` and re-run — the four tests throw `NEW.doc_key isn't a column`.

Reviewer call: is the commit-time set-level uniqueness CHECK supposed to be threaded onto a member
UPDATE that cannot carry (and cannot change) the key column? It looks over-broad — the obligation
should ride only the op(s) that can introduce a duplicate of the logical key. If confirmed, file a
fix ticket (likely in `view-mutation-builder.ts`'s `extraConstraints` threading or
`collectLensSetLevelConstraints` gating). Not fixed here (test-only ticket).

**Other notes:**
- **View-image vs base-diff oracle (load-bearing).** Corner #3 asserts view-image idempotence, NOT
  per-member base-multiset equality. The lingering-all-null collapse (present-all-null → absent on
  write-back) is a real base-representation change that a base-diff oracle would (correctly) flag; only
  view-image equality is sound. Both the property and the deterministic test carry comments warning a
  future edit not to "tighten" the oracle into a base diff. Reviewer: confirm no other GetPut here was
  silently tightened.
- **Counter guards accumulate across runs**, not per-run (matches the existing `mutated` / `opsSeen`
  pattern). With `numRuns: 40` and `c` ~50% null this is robust, but it is a probabilistic guard, not a
  guarantee — if fast-check seeding ever changes, the `presentReput`/`absentReput > 0` asserts are the
  early-warning. The deterministic (b1/b2) tests are the non-probabilistic floor for those arms.
- **Corner #3 does NOT walk the absent→materialize-NEW arm via the property** — a GetPut writes back
  the *read* value, which for an absent row is null (a no-op), so the materialize-new branch is only
  covered by the deterministic (b1) test, not the randomized (a). This is intended and noted in the
  test comment, but worth a reviewer's eye if broader randomized materialize coverage is wanted.
- All fixtures use PK/UNIQUE stitch keys, so they deploy cleanly under the prereq's deploy-time
  uniqueness guard. `deployMultiValueOptional`'s `T2_opt(id pk)` stitch is a declared PK.

## Suggested adversarial checks for the reviewer

- Drop `unique` from `doc_key` → confirm the documented `NEW.doc_key isn't a column` repro, decide on a
  fix ticket.
- Flip corner #3's oracle to a per-member base-multiset compare → confirm the lingering-all-null test
  goes red (proves the oracle choice is load-bearing, not cosmetic).
- Mutate `buildOptionalMaterializeInsert` to source the **member** key on both sides of the surrogate
  thread (instead of `<anchor>.sid` → `meta_sid`) → confirm the corner-#2 `meta_sid = 101` assert
  catches the misthread.
