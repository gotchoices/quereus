description: Reviewed the two test additions hardening the shipped decomposition optional/EAV UPDATE materialization — a surrogate-keyed optional-member UPDATE and a GetPut over the optional value column. Test-only; no production code changed. A real production gap surfaced during implement (worked around in the fixture) was confirmed empirically and filed as a fix ticket.
files: packages/quereus/test/lens-put-fanout.spec.ts (surrogate-keyed optional-member UPDATE describe), packages/quereus/test/property.spec.ts (GetPut-over-c property + 2 deterministic tests + deployMultiValueOptional), packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/planner/mutation/decomposition.ts
----

## What landed (implement)

Two pure test additions (no production source changed) closing two coverage corners from the
`view-write-decomposition-optional-update` hardening:

- **Corner #2 — surrogate-keyed optional-member UPDATE** (`lens-put-fanout.spec.ts`): a surrogate
  decomposition with an optional member spelled distinctly across relations (`sid`/`doc_sid`/`meta_sid`).
  Four `it`s pin matched UPDATE, absent→materialize INSERT (existing anchor `sid` threaded into the
  distinctly-spelled `meta_sid`), all-null DELETE, and null-write-to-absent no-op.
- **Corner #3 — GetPut over the optional value column** (`property.spec.ts`, `decomposition fan-out`):
  a `numRuns: 40` view-image-idempotence property re-putting every read column (incl. `c`), plus two
  deterministic tests (single-value materialize/delete re-put; multi-value lingering-all-null collapse
  via the new `deployMultiValueOptional`).

See the implement commit (`678de4a1`) for the full per-test rationale.

## Review findings

### Validation re-run (independently, this pass)

- **Full suite** `yarn workspace @quereus/quereus test`: **4920 passing, 9 pending, 0 failing** — matches
  the handoff exactly.
- **Lint** `yarn workspace @quereus/quereus lint`: clean (exit 0).
- **Focused** `--grep decomposition`: 97 passing, including the 7 new tests.

### Checked — what I scrutinized

- **The flagged production gap (CONFIRMED, MAJOR → fix ticket filed).** The implement handoff flagged
  that the corner-#2 fixture carries a workaround `doc_key text unique`, and that dropping it surfaces a
  real production build failure. I **reproduced it empirically**: with `unique` removed, all four
  corner-#2 tests throw `QuereusError: NEW.doc_key isn't a column` at plan-build time. Root cause
  verified by reading `view-mutation-builder.ts` ~L144-176 — `extraConstraints` (including
  `lensSetLevelConstraints`) is computed **once** and `baseOps.map(op => buildBaseOp(…, extraConstraints, …))`
  threads the SAME commit-time set-level uniqueness CHECK (which references `NEW.doc_key`) onto **every**
  member op, including the `Doc_meta` member UPDATE that cannot carry `doc_key`. The bug is real and
  reachable for any decomposition whose logical PK is not carried by every member and lacks basis
  uniqueness (the natural surrogate case). **Disposition: filed `fix/view-write-decomp-set-level-check-overbroad-member-update.md`** with reproduction, root-cause, expected behavior, suggested fix
  direction, and instruction to remove the fixture workaround + add a regression test on fix.
  The implementer's workaround (`doc_key text unique`) is sound and does NOT weaken corner #2's actual
  subject (the anchor-surrogate → distinct-member-key thread is unaffected by the UNIQUE).

- **Corner #2 tests are load-bearing, not tautological.** The headline `meta_sid = 101` assertion in the
  absent→materialize test distinguishes the threaded *existing* anchor `sid` from a freshly-minted
  surrogate (`buildOptionalMaterializeInsert` sources `select Doc_core.sid`, not the member key, and does
  not re-evaluate the anchor default) — a misthread would surface a wrong/null `meta_sid`. Each of the
  four tests asserts both base `Doc_meta` and (three of four) the `x.Doc` view image. The all-null DELETE
  correctly deletes only the predicate-matched component (member-delete builder restricts by anchor
  subquery), not the whole member.

- **Corner #3 oracle choice is load-bearing.** The view-image (not base-multiset) oracle is sound: the
  lingering-all-null collapse (present-all-null → absent on write-back) is a real base-representation
  change that a base-diff oracle would correctly flag. The deterministic lingering-all-null test asserts
  both view-image equality AND `main.T2_opt` count = 0 after collapse — flipping to a base-multiset
  compare would (correctly) go red. Both the property and deterministic tests carry comments warning a
  future edit not to tighten the oracle. Confirmed no other GetPut in the file was silently tightened.

- **Property test soundness.** `colRowArb` makes `a`/`b` always non-null integers (1-9) and `c`
  `fc.option`, so the write-back string-interpolation (`update … set a=…, b=…, c=…`) is always valid SQL
  (a null `c` interpolates the `null` literal). The `presentReput`/`absentReput` counter guards are
  accumulating + probabilistic (acknowledged in the handoff); the deterministic (b1/b2) tests are the
  non-probabilistic floor for those arms, so the probabilistic guards degrading would not leave the
  branches uncovered.

- **Test fixtures / helpers.** `colMap`/`keyMap`/`AdvertisingModule` (lens-put-fanout) and
  `deployColumnar`/`deployMultiValueOptional`/`readRows`/`assertRowsEqual` (property) all exist and are
  used consistently with the established patterns in each file. All stitch keys are declared PK/UNIQUE, so
  every fixture deploys cleanly under the prereq's deploy-time uniqueness guard.

- **DRY / structure.** Each corner-#2 `it` opens/closes its own `Database` — matches the existing
  file-wide pattern; no extractable duplication worth churning. No lint or type-laziness issues
  introduced (lint clean, no `any` added in the new code).

### Found & fixed inline (MINOR)

- **None.** No minor defects required inline fixes. The test fixture's temporary `unique`-drop I made to
  reproduce the gap was reverted (`git diff` clean before handoff).

### Found & deferred (MAJOR → new ticket)

- The over-broad set-level CHECK threading onto member UPDATEs — see above; filed
  `fix/view-write-decomp-set-level-check-overbroad-member-update.md`.

### Docs

- This change is test-only and alters no production behavior, so no doc was made stale **by this
  ticket**. The production gap it surfaced is currently undocumented in `docs/view-updateability.md`
  § Current limitations; documenting/closing it is owned by the filed fix ticket (it should ultimately
  *work*, not be documented as a permanent limitation).

### Coverage gaps acknowledged (not defects)

- Corner #3's randomized property does NOT walk the absent→materialize-NEW arm (a GetPut writes back the
  read value, which for an absent row is null = a no-op); that arm is covered only by the deterministic
  (b1) test. Intended and documented in the test comment.
- Corner #2 does not cover composite surrogate keys (deferred at `singleKeyColumn` with
  `unsupported-decomposition-key`), consistent with the documented v1 single-column-key boundary.
