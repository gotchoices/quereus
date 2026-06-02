description: Four test-only coverage extensions to the View Round-Trip Law harness (`describe('View Round-Trip Laws')` in `packages/quereus/test/property.spec.ts`) — each walks an already-supported (or already-rejected) put-path arm that the prior seeding modeled in its oracle but never generated. No engine code touched. Reviewed: read the implement diff first, traced each oracle against the shipped decomposition/multi-source semantics (cross-checked vs `docs/lens.md` + `docs/view-updateability.md`), hardened one under-guarded behavioral claim inline, and filed one backlog ticket for a coverage gap in the collision-atomicity test. Lint + typecheck clean; full `View Round-Trip Laws` block 36 passing / 0 failing.
prereq:
files: packages/quereus/test/property.spec.ts, tickets/backlog/view-mutation-multisource-insert-partial-write-atomicity.md
----

## What landed (implement)

Four coverage extensions, all in `packages/quereus/test/property.spec.ts` under
`describe('View Round-Trip Laws')`. Test-only — `git show ce5533bf` touches no `src/`.

- **Family C `decomposition fan-out`:**
  - `PutGet (columnar, missing member)` — the invisible-row arm: some `T_core` rows
    have no mandatory `T_b`, so the logical row is invisible through the inner join.
    Asserts a `set b` to the absent member never materializes it, the anchor is still
    routed by the bare anchor predicate even for an invisible row (`set a` lands on
    `T_core`, the view never widens), and a per-member-independent oracle. Also
    exercises a non-key anchor predicate (`where a = K`).
  - `PutGet (surrogate, multi-row)` — per-row-distinct minting through the fan-out:
    2–4 logical rows in one insert; each threads the same fresh surrogate into every
    member, surrogates pairwise distinct and `> max(seeded sid)`.
  - lineage agreement refactored into `assertAdvertisementLineage` + a small
    `expectLogicalPkForwardKey`, with columnar / EAV / surrogate `it`s. Surrogate
    advertises **no** forward key (the surrogate is projected away, `docKey` rides a
    base column with no uniqueness constraint) — the helper no longer requires one.
- **Family B `multi-source inner join`:**
  - directly-supplied-insert collision — fuzzes the supplied key against the seed range;
    on collision the insert is rejected and both bases are asserted unchanged, on a
    fresh key both bases gain the row.
  - `delete_via=parent` fuzzed — few parents / many children so a routed child's parent
    is frequently shared; deleting that parent leaves every child in the base but hides
    all the parent's dependents through the join.

## Review findings

I read the implement diff (`git show ce5533bf`) before the handoff, then traced every
new oracle against the shipped engine semantics, cross-checked the documented
contract, ran the gates, and inspected the surrounding helpers/fixtures.

### Checked — and the verdict

- **Oracle soundness (all four extensions).** Each per-member / per-base oracle is
  computed from pre-state and matches the documented fan-out. The headline semantic
  in the missing-member test (an anchor-predicate write touches an *invisible* row's
  anchor) is **documented intent**, not an accidental view-widening: `docs/lens.md`
  § DELETE and `docs/view-updateability.md` § Decomposition put fan-out both specify
  that *"each non-anchor member's identifying set is read from the **anchor alone** …
  never the full join"* (`where memberKey in (select anchorKey from anchor where
  <pred>)`). The view image never widens (the row stays invisible). The handoff's
  flagged "arguably view-widening / design question" is therefore already settled by
  the shipped design — **no ticket filed for it**, and no doc change needed (the docs
  already describe exactly what the test now characterizes).
- **Surrogate "no forward key" characterization** — confirmed legitimate, not masking
  a derivation gap: `Doc_core.doc_key` carries no base `unique` constraint, so the
  forward FD walk on the synthesized read body surfaces no key; the logical-PK
  uniqueness is a logical-level assertion the base substrate does not back. The
  surrogate `it` correctly asserts the backward/threading facts instead.
- **`fc.uniqueArray({ selector })`** — supported by the repo's fast-check; the
  multi-row surrogate test runs green.
- **Test hygiene** — every `it` runs on a fresh `beforeEach` `Database`, so the three
  lineage tests' repeated `declare logical schema x` do not collide; `pragma
  foreign_keys = false` in the `delete_via=parent` test is scoped to its own db.
  Interesting arms are guarded (`collidedSeen`/`freshSeen`, `routedSeen`/`sharedSeen`,
  `invisibleSeen`, `opsSeen`). Lint + typecheck clean.

### Fixed inline (minor)

- **Missing-member test: under-guarded headline arm.** The claim "an anchor-predicate
  op mutates an *invisible* row's anchor" was only verified when fast-check happened to
  generate that combination (invisible row + anchor-touching op + matching predicate) —
  no guard ensured it ever fired, so the test could silently degrade to never
  exercising its own thesis. Added an `invisibleAnchorTouched` counter (incremented when
  an `update-a` / `update-ab` / `delete` matches an id whose mandatory `T_b` is absent)
  and a closing `expect(invisibleAnchorTouched).to.be.greaterThan(0)`. Test stays green
  — confirming the arm does fire across the 80 runs.

### Filed as backlog (major — coverage gap, not an engine defect)

- **`view-mutation-multisource-insert-partial-write-atomicity`** — the collision test
  is named "rejected atomically" but **cannot falsify a non-atomic engine**: it seeds
  each key into *both* bases together, so a colliding supplied key is present in both,
  the fan-out fails on the *first* member op, and the second base is never touched.
  "Both unchanged" is satisfied by first-op-failure, not by rollback of a partial
  write. The genuinely atomic path — a key present in *exactly one* base, so the first
  insert succeeds and the second fails, forcing a rollback of the already-written base
  — is never constructed. The shipped engine is believed correct (transactional
  multi-base writes); this is a harness coverage gap, deferred to backlog.

### Not changed (with reasons, not silence)

- **Engine / `src/`** — out of scope by design; this ticket is test-only and the
  diff confirms it.
- **Docs** — read `docs/lens.md` and `docs/view-updateability.md` for the
  decomposition + multi-source put-fan-out sections the tests exercise; both already
  accurately describe the anchor-only predicate routing, surrogate minting, and
  delete-fan-out semantics the new tests characterize. Nothing stale to update for a
  coverage-only change.
- **Collision-atomicity test** — left as-is (its rejection + both-unchanged assertions
  are valid as far as they go); the missing partial-write-rollback coverage is the
  backlog ticket above rather than an inline rewrite, because constructing the
  one-base-collide oracle requires independent per-base models (the current single
  `kept` list assumes identical key sets) — more than a minor inline tweak.

## Verification

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `View Round-Trip Laws` block (`test-runner.mjs --grep "View Round-Trip Laws"`) —
  **36 passing / 0 failing**, including the inline guard addition.

## Out of scope (unchanged from the source ticket)

- GetPut write-back of optional `c` / EAV columns (read-only by design — stays
  asserted-as-rejected).
- The both-sides Family B update predicate-clash variant (owned by
  `view-mutation-multisource-both-sides-predicate-clash`).
