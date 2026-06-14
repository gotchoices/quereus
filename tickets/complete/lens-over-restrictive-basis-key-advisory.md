description: Reviewed and completed the deploy-time advisory `lens.over-restrictive-basis-key` — a warning fired from the `proved` branch of `classifyKeyConstraint` when a logical UNIQUE/PK is a strict superkey of a (NOT-NULL, via the transport path) basis key, so the basis over-enforces what the logical schema advertises. Sound but stricter than declared, hence a warning, never an error, and it never alters the `proved` classification. Build, lint, and full suite green (6297 passing after review).
files:
  - packages/quereus/src/schema/lens-prover.ts        # ADVISORY_CODE_LIST (6 codes); FingerprintInputs.basisKeyColumns; warnOverRestrictiveBasisKey + basisKeyColumnIndices; call site in proved branch; doc comment clarified (review)
  - packages/quereus/src/schema/lens-ack.ts            # computeAdvisoryFingerprint: conditional basisKey serialization
  - packages/quereus/test/lens-prover.spec.ts          # "over-restrictive basis key (advisory)" describe (10 tests after review — added end-to-end write-path test)
  - packages/quereus/test/lens-ack.spec.ts             # six-code drift guard; basis-key fingerprint sensitivity
  - docs/lens.md                                       # § Constraint Attachment proved paragraph; Warnings table row; recognized-targets list; fingerprint-facts list

# Completed: `lens.over-restrictive-basis-key` advisory

## What landed

A sixth governable, acknowledgeable warning-severity advisory. It fires when a logical key
(`unique` / PK) classifies **`proved`** yet a **governing basis key is a strict subset** of
the logical key's mapped basis columns — the basis enforces uniqueness on a *prefix* of the
logical key, rejecting writes the logical schema permits (two rows differing only outside
the basis key's columns cannot coexist). Diagnostic-only: never alters the `proved`
classification or the returned obligation.

The advisory lives in the `proved` branch of `classifyKeyConstraint`, beside
`rejectBasisGovernedConflictActionForProvedKey`, and reuses the same
`mapLogicalKeyToBasisColumns` / `findGoverningBasisKeys` governance machinery. It fires
only for a **strict** subset (`governingKey.length < mappedBasisCols.length`) — an exact
match is fully realizable and stays silent — and only on the single-source, `!readOnly`
path. The new advisory code is added to the single `ADVISORY_CODE_LIST` source of truth, so
it flows automatically into the ack vocabulary, escalation-policy recognition, and the
`quereus_lens_advisories` TVF with no other enumeration site to touch. The fingerprint gains
a conditionally-serialized `basisKeyColumns` field (mirroring `domainValues`), keeping every
other advisory's hash byte-stable.

## Review findings

Reviewed the implement diff (commit `74c4cf4b`) with fresh eyes against the source it
touches and the source it *should* have touched. Verdict: **sound and well-tested**; one
doc-accuracy fix and one coverage-strengthening test applied inline. No major findings, no
new tickets filed.

**Validation (run during review):**
- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json`), re-run after edits.
- `yarn workspace @quereus/quereus run test` → **6296 passing, 9 pending, 0 failing** before edits; the new test brings the over-restrictive describe to 10 (suite 6297). No regression — confirming the new `proved`-branch warning call emits no spurious advisory on any existing lens deploy test.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.

**Correctness / soundness — checked, clean:**
- *No false positives.* A strict-subset governing key (columns ⊊ the logical key's mapped
  basis columns) genuinely over-restricts: two rows equal on the subset but differing on the
  rest of the logical key are rejected by the basis yet permitted by the logical schema. The
  firing condition is sound.
- *No false negatives in the supported scope.* Strict-subset PK and UNIQUE governing keys,
  multiple subset keys, and the both-subset-and-exact-match case all fire correctly; exact
  match correctly stays silent.
- *Reachability argument holds.* The transport path requires NOT-NULL key columns mapping to
  an exact basis key, so a nullable basis sub-key never reaches `proved` via transport (the
  nullable test confirms it classifies `enforced-set-level`). Note: the advisory itself does
  *not* re-check NOT-NULL — and that is correct, because even a body-proved key over a
  nullable basis sub-key still over-restricts for non-null values, so firing there would also
  be sound. The "NOT-NULL basis key" framing in the docs describes how the case is *reached*
  via transport, not a precondition the firing logic enforces.
- *Single source of truth verified.* `ACKNOWLEDGEABLE_ADVISORY_CODES`, the escalation-policy
  recognized-codes set, and the TVF all derive from `ADVISORY_CODE_LIST`; the drift-guard
  test pins exactly six codes. No hardcoded code list anywhere else (checked `explain.ts`,
  `reserved-tags.ts`, policy validation).

**Fingerprint — checked, clean:**
- `basisKeyColumns` is conditionally serialized in `computeAdvisoryFingerprint` (the
  `domainValues` precedent), so all other advisory hashes are unchanged. Canonicalization
  (lowercase + sort) happens in the fingerprint function, so the warning not pre-sorting
  `constraintColumns` is harmless.
- The fingerprint deliberately **omits** `cardinalityBand` and `hasCoveringStructure`
  (the manual `fingerprintInputs` does not call `buildFingerprint`). This is a *correct*
  judgment call, not an oversight: the advisory's truth is purely structural (key column
  relationships + basis relation), so it should not re-surface on row-count churn. A minor
  philosophical inconsistency with `getput-lossy` (which includes the band via
  `buildFingerprint` even though its truth is also non-cardinal), but the over-restrictive
  choice is the better one and not worth churning the sibling.

**Tests — implementer's set is a solid starting point; one gap closed:**
- *Added* `the over-restriction is real: the basis rejects two write-through rows the logical
  key permits` — an end-to-end write-path test that inserts `(1,1,2)` then `(2,1,3)` through
  the lens and asserts the basis `unique(a)` rejects the second with `UNIQUE constraint
  failed`. This was the implementer's explicitly-flagged "no write-path behavioral test" gap;
  it validates the advisory's central claim is observable runtime behavior, not just a
  deploy-time classification.
- *Accepted as adequate* the implementer-flagged coverage gaps: the `strictSubset.length ===
  0` early-return **is** exercised by the exact-match test (a governing key exists but is not
  strict, reaching the same `return` from a genuinely `proved` key); the multi-source and
  genuinely-basis-keyless-`proved` early returns rest on inspection + a tested sibling
  (`rejectBasisGovernedConflictActionForProvedKey`'s identical multi-source guard) — both are
  hard-to-construct, documented conservative gaps, not correctness risks.

**Docs — checked, one fix:**
- *Fixed* the `warnOverRestrictiveBasisKey` doc comment: it claimed the "smallest enumerated"
  governing key names the message, but the code picks `strictSubset[0]`, which is
  `findGoverningBasisKeys` enumeration order (basis PK first, then declared UNIQUEs in
  order) — **not** smallest by arity. Clarified to avoid misleading a future reader when
  several differently-sized strict-subset keys exist.
- `docs/lens.md` (§ Constraint Attachment proved paragraph, Warnings table, recognized-codes
  list, fingerprint-facts list) read in full against the new reality — accurate, no changes
  needed.

**Minor nits left as-is (deliberate, consistent with surrounding code):**
- The redundant `basis ?` guard before `mapLogicalKeyToBasisColumns` (the mapper already
  null-guards) mirrors the sibling `rejectBasisGovernedConflictActionForProvedKey` — left for
  consistency.
- `basisKeyColumnIndices`' PK arm duplicates `getPrimaryKeyIndices`-style logic, but the
  helper is local, small, and its UNIQUE arm needs custom handling — not worth a shared
  helper.

**Empty categories (explicit):** No major findings → no new fix/plan/backlog tickets filed.
No error-handling, resource-cleanup, or type-safety concerns — the function is pure, pushes
to a diagnostics array, and handles missing columns/keys with `?? \`#${c}\`` fallbacks.

## Validation run (final)

- `yarn workspace @quereus/quereus run test` (over-restrictive subset) → 10 passing.
- `yarn workspace @quereus/quereus run test` (full) → 6296 → 6297 passing with the added
  test, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` → clean (re-run after the doc + test edits).
