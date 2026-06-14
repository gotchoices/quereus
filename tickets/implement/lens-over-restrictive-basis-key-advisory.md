description: A logical UNIQUE/PK that is a strict superkey of a smaller declared basis key (basis NOT-NULL `unique(a)`, logical `unique(a, b)`) classifies `proved`, but the basis over-enforces — it rejects writes the logical schema advertises as valid. Add a deploy-time advisory (`lens.over-restrictive-basis-key`, warning severity, acknowledgeable) that fires from the `proved` branch of `classifyKeyConstraint`, mirroring the conflict-action governance sibling.
files:
  - packages/quereus/src/schema/lens-prover.ts                 # classifyKeyConstraint proved branch; ADVISORY_CODE_LIST; FingerprintInputs; new warnOverRestrictiveBasisKey
  - packages/quereus/src/schema/table.ts                       # findGoverningBasisKeys (subset search, reused as-is)
  - packages/quereus/src/schema/lens-ack.ts                    # advisory fingerprint serialization (if a new FingerprintInputs field is added)
  - packages/quereus/test/lens-prover.spec.ts                  # new advisory firing/non-firing tests
  - packages/quereus/test/lens-ack.spec.ts                     # drift-guard vocabulary test (now six codes); fingerprint sensitivity
  - docs/lens.md                                               # § Constraint Attachment (proved paragraph) + § Coverage checklist (new warning row)

# `lens.over-restrictive-basis-key`: an advisory for a logical key strictly weaker than the basis enforces

## Decision (resolved — implement as specified)

**Yes, add a dedicated deploy-time advisory.** Warning severity, acknowledgeable (governable
via `error-on` / `require-ack`). It is *not* an error: the schema is sound — every logical
invariant the schema declares still holds (the relation genuinely is unique on the logical
key); the basis merely enforces something strictly stronger. "Correct but surprising" is
exactly the warning category, alongside `lens.no-backing-index` and `lens.partial-override`.

This is distinct from the two neighbouring diagnostics and must not be conflated:
- **`lens.unrealizable-constraint`** (error) is for a constraint that can be *neither proved
  nor enforced* (uniqueness over a value with no write path). This one is *proved and
  over-enforced* — the opposite end.
- **`lens.unenforceable-conflict-action`** (error) is about *which action* resolves a
  duplicate. This one is about *which states the logical relation can hold*. They are
  independent axes and can both fire for the same key; that is fine.

### Why an advisory is warranted here specifically (and not for every stricter-basis case)

A lens write always bears the full basis constraint set on top of the logical ones (the
re-planned basis write fires too — `docs/lens.md` § "The lens boundary is the only place
logical constraints apply"). So *any* basis constraint absent from the logical schema (e.g. a
basis `check (b > 0)`) can reject a logically-valid write. We do **not** advise on those —
the basis is the source of truth and a tighter basis is the author's prerogative.

What makes the superkey case worth a dedicated advisory is that the logical declaration
`unique(a, b)` **names overlapping columns** with the stricter basis key `unique(a)`, creating
a precise, detectable false expectation: "I declared a composite key, but the basis enforces a
*prefix* of it, so `(1,2)` and `(1,3)` cannot coexist even though my logical schema permits
them." The relationship is exactly the strict-subset relation `findGoverningBasisKeys` already
computes for the conflict-action check — cheap to detect, and a likely authoring surprise.

## The shape

```sql
declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }
declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }
declare lens for x over y { view t as select id, a, b from y.t }
```

The logical `unique(a, b)` permits two rows `(a=1, b=2)` and `(a=1, b=3)`. The basis NOT-NULL
`unique(a)` forbids them coexisting. The logical key is body-proved (`proveEffectiveKeyUnique`
proves any superset of the basis relation key `{a}` is unique), classifies `proved`, and the
schema deploys silently — yet an insert of `(1, 3)` after `(1, 2)` is rejected by the basis
with an `a`-uniqueness violation the logical schema never mentions. The advisory surfaces this
mismatch at deploy.

## Key soundness fact that scopes the implementation (verified)

The over-restriction-while-`proved` case arises **iff the governing basis key is NOT NULL**:

- A nullable basis `UNIQUE(a)` is NULL-skipping, so it contributes only a **guarded** FD
  (`a → others [guard: a is not null]`). `isUnique` / the closure surface **skip guarded FDs**
  (`planner/util/fd-utils.ts` lines ~46, ~690, ~719), so a nullable basis key never makes
  `{a}` an *unconditional* body key. The logical superkey then fails `proveEffectiveKeyUnique`
  and classifies row-time / commit-time, **not** `proved`.
- A NOT-NULL basis `UNIQUE(a)` (or basis PK) contributes an unconditional FD ⇒ `{a}` is a real
  body key ⇒ the logical superset `{a,b}` proves unique ⇒ `proved`.

**Consequence:** the only place a `proved` logical key can sit over a strict-subset governing
basis key is the `proved` branch of `classifyKeyConstraint`. The row-time and commit-time arms
never need this check. Placement is therefore in the `proved` branch, beside
`rejectBasisGovernedConflictActionForProvedKey`, reusing the same governance machinery.

## Design

### Code, vocabulary, governance

- New advisory code `lens.over-restrictive-basis-key` added to `ADVISORY_CODE_LIST` in
  `lens-prover.ts` (the single authoritative governable vocabulary). This automatically makes
  it a valid `error-on` / `require-ack` policy target and adds it to
  `ACKNOWLEDGEABLE_ADVISORY_CODES`.
- `LensAdvisoryCode` / `LensCheckCode` pick it up via the list — no separate type edit.

### Firing condition (single-source `proved` keys only)

Fire the warning when **all** hold:
1. the key classifies `proved` (body-proved **or** bijection-transport — decoupled from the
   transport exact-match gate, exactly like the conflict-action sibling);
2. `!readOnly` (a read-only table never writes, so the over-enforcement never materializes —
   same gate as `lens.no-backing-index` and the conflict-action checks);
3. the body is single-source and the logical key maps 1:1 to basis columns
   (`mapLogicalKeyToBasisColumns` returns a value); and
4. there exists a governing basis key (`findGoverningBasisKeys`) that is a **strict** subset of
   the logical key's mapped basis columns — i.e. `governingKey.columns.length <
   mappedBasisCols.length`. (`findGoverningBasisKeys` returns subset *including* equality; the
   strict filter excludes the exact-match basis key, which is fully realizable and must not
   warn.)

One warning per logical key (not per governing key). When several strict-subset basis keys
exist, name the smallest / first for the message but the condition is "≥1 strict subset".

### Covers both PK and UNIQUE

Both kinds route through `classifyKeyConstraint`, so the check covers a logical PK that is a
superset of a smaller basis UNIQUE as well as a logical UNIQUE superset of a basis UNIQUE/PK.
PK columns are always NOT NULL, so a logical PK superkey is always `proved` over a NOT-NULL
basis sub-key — squarely in scope.

### Multi-source: out of scope (documented gap)

A multi-source / decomposition body has no single basis source, so the 1:1 logical→basis
mapping the subset search needs does not exist and the superkey argument does not transfer
(the logical columns come from different basis rows). `mapLogicalKeyToBasisColumns` returns
`undefined` ⇒ no advisory. This matches the conflict-action check's multi-source posture
(though that one *over-rejects* conservatively because it is an error; an advisory has no such
obligation, so silence is correct — there is no sound subset relationship to report).

### Nullable governing basis key: out of scope (documented gap)

Per the soundness fact above, a nullable basis sub-key never yields a `proved` logical key, so
this advisory never sees it. The basis still over-restricts *non-null* writes in that case, but
the diagnosis is fuzzier (the logical and basis NULL semantics also differ) and the key
classifies row-time/commit-time. Left as a documented limitation, not handled here.

### Message

Sited at `{ table, constraint: label }`. Name the logical key columns, the governing basis key
(via a label akin to `basisKeyLabel`), and the surprise concretely. Suggested wording:

> lens: {label} on '{table}' ({cols}) is a strict superkey of {basis key label} — the basis
> enforces uniqueness on a subset of the logical key's columns, so it will reject writes the
> logical schema permits (two rows differing only outside the basis key's columns cannot
> coexist). This is sound but stricter than the logical declaration advertises; widen the basis
> key to match, or narrow the logical key, to make the logical contract faithful.

### Fingerprint

Populate `FingerprintInputs`:
- `constraintColumns` — the logical key's columns (declaration order);
- `basisRelation` — lowercased `schema.table` of the basis source;
- **new field** `basisKeyColumns?: readonly string[]` — the governing basis key's basis-column
  names, rendered + **sorted**. Add it to `FingerprintInputs` and serialize it in
  `lens-ack.ts`'s fingerprint computation **only when present** (mirroring the `domainValues`
  precedent so existing advisory fingerprints stay byte-stable). Material because if the basis
  key changes (tightened to match, or loosened), the advisory's truth changes and a prior ack
  should re-surface.

## Edge cases & interactions

- **Exact-match basis key (no strict subset):** basis `unique(a,b)` = logical `unique(a,b)` →
  fully realizable, **no** warning. The strict-length filter is what excludes it; assert this.
- **Both a strict subset and an exact match exist:** basis `unique(a)` *and* `unique(a,b)`;
  logical `unique(a,b)`. The strict subset `unique(a)` still over-restricts → **warn**. The
  presence of an exact match does not rescue it.
- **Basis PK as the strict subset:** basis `primary key (a)`, extra col `b`; logical
  `unique(a,b)` → warn (PK is a NOT-NULL declared key, governs every duplicate).
- **Logical PK superset of basis UNIQUE:** basis NOT-NULL `unique(a)`; logical `primary key
  (a, b)` → warn (covers the PK arm).
- **Nullable basis sub-key:** basis `a integer null unique`; logical `unique(a,b)` → key is
  *not* `proved` (guarded FD) → **no** warning (out of scope, documented).
- **Multi-source body:** logical key spanning two basis tables → mapping undefined → **no**
  warning (out of scope, documented).
- **Genuinely basis-keyless proof:** `select distinct a, b` / `group by a, b` body with no
  basis UC over the key → no governing key → **no** warning (correctly silent — the body, not a
  stricter basis key, proves it).
- **Read-only table:** PK not reconstructible ⇒ `readOnly` ⇒ **no** warning (never writes).
- **Interaction with `lens.unenforceable-conflict-action`:** a superkey logical key that also
  declares `on conflict replace/ignore` differing from the basis key's action fires *both* the
  conflict-action error and this warning. Confirm both surface; the error still blocks the
  deploy (atomic-throw) while the warning would flow to the report on a clean variant.
- **Acknowledgement round-trip:** an in-source `quereus.lens.ack.over-restrictive-basis-key`
  tag suppresses it from the default report and tallies it in `acknowledged`; changing the
  basis key columns must re-surface the ack (fingerprint sensitivity test).
- **Drift guard:** `ACKNOWLEDGEABLE_ADVISORY_CODES` is now **six** codes — update the
  drift-lock test in `lens-ack.spec.ts` (currently asserts exactly five).
- **No FD-contribution change:** the obligation stays `proved`; `computeLensAssertedKeyFds`
  still contributes the unconditional key FD. The advisory is diagnostic-only and must not
  alter classification or the returned obligation kind.

## TODO

### Phase 1 — prover

- Add `'lens.over-restrictive-basis-key'` to `ADVISORY_CODE_LIST` in `lens-prover.ts`.
- Add the optional `basisKeyColumns?: readonly string[]` field to `FingerprintInputs` with a
  doc comment matching the `domainValues` "serialized only when present" precedent.
- Implement `warnOverRestrictiveBasisKey(ctx, constraint, logicalColumns, bijectiveAuthored,
  label, columnNames, readOnly, warnings)`: early-return on `readOnly`; map via
  `mapLogicalKeyToBasisColumns` (return on `undefined`); compute strict-subset governing keys
  from `findGoverningBasisKeys` filtered by `length < mappedBasisCols.length`; on any match push
  the warning with the fingerprint (use `basisKeyLabel` for the basis-key spelling and the
  matched key's basis-column names, sorted, for `basisKeyColumns`).
- Call it from the `proved` branch of `classifyKeyConstraint` (right after
  `rejectBasisGovernedConflictActionForProvedKey`). Thread `warnings` through — note that
  branch currently takes only `errors`; add the `warnings` array to the call site.
- Update the `classifyKeyConstraint` doc comment: the strictly-more-restrictive-basis superkey
  realizability concern is now **handled here** (remove the "tracked under
  `lens-superkey-over-restrictive-basis-realizability`, not this check" deferral note and
  describe the new advisory instead).

### Phase 2 — ack serialization

- In `lens-ack.ts`, fold `basisKeyColumns` into the advisory fingerprint computation, guarded
  by presence so existing hashes are unaffected.

### Phase 3 — docs

- `docs/lens.md` § Constraint Attachment: in the `proved` paragraph (line ~284), replace the
  trailing deferral sentence ("The strictly-more-restrictive-basis superkey shape … tracked
  under `lens-superkey-over-restrictive-basis-realizability`") with a description of the new
  `lens.over-restrictive-basis-key` advisory and why it is a warning, not an error.
- `docs/lens.md` § Coverage checklist: add a new row to the **Warnings** table for
  `lens.over-restrictive-basis-key`.

### Phase 4 — tests

- `lens-prover.spec.ts`: firing case (basis NOT-NULL `unique(a)`, logical `unique(a,b)` →
  warning present, obligation still `proved`); PK-superset case; basis-PK-subset case;
  non-firing cases (exact match; nullable basis sub-key → no warning; multi-source → no
  warning; basis-keyless `group by` proof → no warning; read-only → no warning); the
  both-subset-and-exact case (warn). Optionally assert the combined fire with
  `lens.unenforceable-conflict-action` on a `replace`-declaring variant.
- `lens-ack.spec.ts`: update the drift-guard to the six-code list; add a fingerprint-sensitivity
  test that changing `basisKeyColumns` moves the hash and an ack re-surfaces.

### Validation

- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/lens-test.log; tail -n 80 /tmp/lens-test.log`
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
