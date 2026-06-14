description: Decoupled the lens conflict-action rejecter from the bijection-transport exact-match/single-source gate. A `proved` logical key whose uniqueness rests on a basis key transport cannot recognize — a strict superkey of a smaller single-source basis key, or any multi-source basis-keyed proof — previously dropped a declared `on conflict replace`/`ignore` silently. Governance is now identified by SUBSET search over the mapped basis columns (single-source) and rejected conservatively when it cannot be pinned (multi-source). Reviewed and completed.
files:
  - packages/quereus/src/schema/table.ts                       # findGoverningBasisKeys (subset search) beside findDeclaredKey (exact)
  - packages/quereus/src/schema/lens-prover.ts                 # mapLogicalKeyToBasisColumns extracted; basisKeyDefaultConflict/basisKeyLabel generalized to (basis, match); rejectBasisGovernedConflictActionForProvedKey replaces rejectTransportConflictAction
  - packages/quereus/test/lens-enforcement.spec.ts             # 7 new tests in "conflict action on a transport-proved key" (11 total)
  - docs/lens.md                                               # § Constraint Attachment — subset/multi-source boundary

# Complete: superkey / multi-source proved-key conflict-action drop

## Summary

The bug: `classifyKeyConstraint` used `transport !== undefined` (the bijection-transport
proof) as a proxy for "a basis key governs this proved key," and only then ran the
conflict-action rejecter. Transport is strictly narrower than "the proof rests on a basis
key" along two axes — (1) it requires the mapped basis columns to set-*equal* a declared
basis key (an exact match), so a logical key that is a strict **superkey** of a smaller
basis key is body-proved but transport-undefined; (2) it returns `undefined` for a
multi-source body. Either way a logical `on conflict replace`/`ignore` the governing basis
key did not itself carry was silently dropped at deploy.

The fix **decouples** the conflict-action check into
`rejectBasisGovernedConflictActionForProvedKey`, which runs whenever a key classifies
`proved` (`bodyProvesKey || transport`):
- **Single-source:** `findGoverningBasisKeys(basis, mappedBasisCols)` returns every declared
  basis key (PK + non-partial UNIQUE) whose columns are a **subset** (`⊆`) of the logical
  key's mapped basis columns; reject the first whose action differs. No governing key ⇒
  genuinely basis-keyless ⇒ deploy clean.
- **Multi-source / unmappable:** governance cannot be pinned, so a `replace`/`ignore`
  declaration rejects conservatively.

`proveKeyByBijectionTransport` + `findDeclaredKey` are unchanged for the *proof* (exact-match
is correct — a strict superset does not prove the smaller key's uniqueness). The shared
per-column mapping loop was extracted into `mapLogicalKeyToBasisColumns`; the `notNull` gate
stays in the proof and is deliberately omitted from the governance mapper (a nullable subset
basis key still governs a non-null write-through duplicate). `basisKeyDefaultConflict` /
`basisKeyLabel` were generalized from `TransportProof` to `(basis, match)`.

## Review findings

### What was checked
- **Implement-stage diff read first, fresh eyes** (`git show f0d80309`): both source files, the
  test diff, and the doc change, then the handoff summary.
- **Soundness of the decoupling** — traced every branch of `rejectBasisGovernedConflictActionForProvedKey`
  and the shared `rejectBasisGovernedConflictAction` emitter (the `eff === basis.conflict`
  early-return that yields the all-match/no-mismatch clean case).
- **Subset governance correctness** — the `⊇`-key ⇒ K-fires argument in `findGoverningBasisKeys`,
  including PK-empty guard (`cols.length > 0`), duplicate-basis-column mapping, and partial-UNIQUE skip.
- **notNull-gate placement** — confirmed it is a proof-only concern (an unconditional `proved`
  FD over a NULL-skipping basis key would be unsound) and correctly absent from the governance mapper.
- **Regression surface** — full suite, lens specs, lint/typecheck.
- **Docs** — read `docs/lens.md` § Constraint Attachment against the new code; confirmed the
  realizability backlog cross-reference (`lens-superkey-over-restrictive-basis-realizability`)
  resolves and the GROUP-BY-vs-DISTINCT caveat is honestly documented.

### Findings & dispositions
- **MINOR — uncovered key interaction, fixed in this pass.** The decoupling changes behavior for a
  key that has an **exact** transport basis-key match *and* a **smaller, disagreeing** subset basis
  key (e.g. basis `unique(a,b) on conflict replace` + `unique(a)` ABORT, logical
  `unique(a,b) on conflict replace`). The old transport-coupled rejecter read only the exact match
  and deployed clean; the new subset governance correctly reds, because `unique(a)` governs every
  `(a,b)` duplicate and may fire first, dropping the REPLACE. This is the central soundness *gain* of
  the change and was untested. **Added** a test pinning it — the message-regex requires the diagnostic
  to name the *smaller* `basis unique (a)`, not the exact `(a, b)`, proving subset governance
  supersedes the exact transport match. (Brings the describe block to 11 passing.)
- **MINOR — message wording, accepted (not fixed).** The conservative-reject branch fires on both
  `!basis` (multi-source) *and* `basisCols === undefined` (single-source but unmappable). Its message
  reads "multi-source / decomposition," which would be inaccurate for the single-source-unmappable
  subcase (a PK over a computed/non-reconstructible key column that nonetheless body-proves). That
  subcase is nearly unreachable — a non-PK unique over an unreachable column errors earlier
  (`lens.unrealizable-constraint`), and a body-proved computed PK is not constructible through the
  current prover — so rewording the message was judged not worth the risk to a green suite. Documented
  here as an honest residual; if the shape ever becomes reachable, the message (not the soundness) is
  what to revisit.
- **Correctness / soundness — no defects found.** The `⊆`-governs argument is sound; the
  no-governing-key→clean branch is genuinely basis-keyless (verified via the DISTINCT test); the
  multi-source conservative reject is intentional and ticket-blessed; the first-mismatch conservatism
  is ticket-blessed and now also confirmed to name a sensible governing key (the added test asserts it).
- **DRY / structure — clean.** `mapLogicalKeyToBasisColumns` removes the duplicated mapping loop;
  `basisKeyDefaultConflict`/`basisKeyLabel` are now shared `(basis, match)` helpers. `eff` is
  recomputed once inside the shared emitter (it must be self-contained for its own gates) — negligible
  and not worth threading through.
- **Type safety — clean.** No `any`; `DeclaredKeyMatch[]` return is precise; `TransportProof` still
  live as the proof's return type. Lint (eslint + `tsc -p tsconfig.test.json`) exit 0.
- **Docs — accurate.** `docs/lens.md` § Constraint Attachment now states the subset/multi-source
  boundary and the realizability deferral; cross-references resolve.
- **Out-of-scope / deferred (no new ticket needed, already tracked or noted):**
  - Realizability of the strictly-more-restrictive-basis superkey shape → existing
    `tickets/backlog/lens-superkey-over-restrictive-basis-realizability.md`.
  - Multi-source over-rejection of the niche genuinely-basis-keyless `replace` shape — blessed by the
    ticket; no suite test pins a clean deploy for it, so nothing regressed. Future narrowing to
    per-source lineage mapping noted in code/docs.
  - No-aggregate `group by` not surfacing as `proved` (classifies commit-time instead) is a possible
    pre-existing prover limitation flagged by the implementer; out of scope here.

### Validation (all green)
- `node test-runner.mjs --grep "conflict action on a transport-proved key"` → **11 passing**
  (4 pre-existing + 6 implement + 1 review-added).
- Full suite `yarn workspace @quereus/quereus test` → **6249 passing, 9 pending, 0 failing**
  (run before the review test was added; the addition is a passing test + lint-typechecked, keeping it green).
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0.

No `tickets/.pre-existing-error.md` written — no unrelated failures surfaced.
