description: Review the new deploy-time advisory `lens.over-restrictive-basis-key` — a warning that fires from the `proved` branch of `classifyKeyConstraint` when a logical UNIQUE/PK is a strict superkey of a NOT-NULL basis key (basis over-enforces what the logical schema advertises). Implementation is complete; build, lint, and full test suite (6296 passing) are green.
files:
  - packages/quereus/src/schema/lens-prover.ts        # ADVISORY_CODE_LIST (+1 = 6 codes); FingerprintInputs.basisKeyColumns; warnOverRestrictiveBasisKey + basisKeyColumnIndices; call site in proved branch; classifyKeyConstraint doc
  - packages/quereus/src/schema/lens-ack.ts            # computeAdvisoryFingerprint: conditional basisKey serialization
  - packages/quereus/src/schema/table.ts              # findGoverningBasisKeys (reused as-is, NOT modified)
  - packages/quereus/test/lens-prover.spec.ts          # new "over-restrictive basis key (advisory)" describe (9 tests)
  - packages/quereus/test/lens-ack.spec.ts             # six-code drift guard; basis-key fingerprint sensitivity
  - docs/lens.md                                       # § Constraint Attachment proved paragraph; Warnings table row; recognized-targets list; fingerprint-facts list

# Review: `lens.over-restrictive-basis-key` advisory

## What landed

A sixth governable, acknowledgeable warning-severity advisory. It fires when a logical
key (`unique` / primary key) classifies **`proved`** yet a **governing basis key is a
strict subset** of the logical key's mapped basis columns — i.e. the basis enforces
uniqueness on a *prefix* of the logical key, rejecting writes the logical schema permits
(two rows differing only outside the basis key's columns cannot coexist). Sound but
stricter than declared, so it is a warning, never an error, and never alters the `proved`
classification or the returned obligation.

### Soundness scoping (verified, drives placement)

The over-restriction-while-`proved` case arises **iff the governing basis key is NOT
NULL**. A nullable basis `UNIQUE(a)` is NULL-skipping ⇒ guarded FD ⇒ `{a}` is not an
unconditional body key ⇒ the logical superkey fails `proveEffectiveKeyUnique` ⇒ classifies
row-time/commit-time, never `proved`. So the only place a `proved` logical key can sit over
a strict-subset governing basis key is the `proved` branch of `classifyKeyConstraint`,
beside `rejectBasisGovernedConflictActionForProvedKey`. The advisory lives there and reuses
the same `mapLogicalKeyToBasisColumns` / `findGoverningBasisKeys` governance machinery.

### Firing condition (`warnOverRestrictiveBasisKey`)

All must hold: (1) key classifies `proved`; (2) `!readOnly`; (3) single-source body with a
1:1 logical→basis mapping (`mapLogicalKeyToBasisColumns` returns a value); (4) ≥1 governing
basis key whose columns are a **strict** subset (`governingKey.length < mappedBasisCols.length`).
One warning per logical key (names the first/smallest governing key in the message).

### Fingerprint

`FingerprintInputs` gains `basisKeyColumns?: readonly string[]` (governing basis key's
basis-column names, rendered + sorted). `lens-ack.ts` serializes it **only when present**
(mirroring the `domainValues` precedent), so every other advisory's hash is byte-stable.
A basis-key change (tightened to match, or loosened) moves the hash and re-surfaces an ack.

## Use cases / validation surface

Canonical shape (the firing case):
```sql
declare schema y { table t (id integer primary key, a integer not null unique, b integer not null) }
declare logical schema x { table t (id integer primary key, a integer, b integer, unique (a, b)) }
-- default basis inferred. `unique(a,b)` body-proves over the NOT-NULL basis unique(a),
-- so it classifies `proved` — but the basis unique(a) rejects (1,2)+(1,3). Advisory fires.
```

Tested in `lens-prover.spec.ts` → `describe('lens prover: over-restrictive basis key (advisory)')`:
- **Fires:** logical `unique(a,b)` over basis `unique(a)` (still `proved`); logical `primary key(a,b)` over basis `unique(a)` (PK arm); strict-subset is the basis **PRIMARY KEY**; **both** a strict-subset and an exact-match basis key exist (subset still warns).
- **Silent:** exact-match basis key (fully realizable); nullable basis sub-key (not `proved`); body-established key with no governing basis key (group by); read-only table; `replace`-declaring variant co-occurs with `lens.unenforceable-conflict-action`.
- Each firing test asserts `fingerprintInputs.basisKeyColumns` and the message wording (`strict superkey of basis unique` / `basis primary key`).

`lens-ack.spec.ts`: six-code drift guard updated; `basisKeyColumns` fingerprint sensitivity
(a key change moves the hash; order/case-canonical; omitted-when-absent leaves other hashes
untouched).

## Honest gaps / reviewer attention points

- **Group-by "basis-keyless proof" test is weaker than intended.** Through the lens, the
  group-by body classifies `enforced-set-level`, **not** `proved` (the lens pipeline does
  not surface a group-by/distinct key as a body proof here). The test therefore asserts only
  the *absence* of the advisory. Consequence: the `warnOverRestrictiveBasisKey` early-return
  for `findGoverningBasisKeys() === []` reached **from a genuinely `proved` key** is not
  directly exercised by any test — I could not construct a reliably-`proved` basis-keyless
  key through a lens. It is a trivial length-0 guard, but a reviewer wanting full-path
  coverage should know it rests on inspection, not a test.
- **Multi-source is out of scope (documented gap) and untested with a `proved` key.** The
  advisory relies on `mapLogicalKeyToBasisColumns` returning `undefined` for a multi-source
  body; I did not build a `proved` multi-source key (hard to construct, niche). No test
  exercises the multi-source early-return.
- **Conflict-action co-occurrence is split across two deploys.** The error throws
  atomically, so the warning and the error cannot share one report; the test asserts the
  warning on the clean variant and the error-throw on the `replace` variant. A single-report
  co-occurrence is not (cannot easily be) asserted.
- **Logical columns default to NOT NULL.** The nullable-sub-key test had to declare logical
  `a integer null` explicitly to match the nullable basis column (otherwise a
  `lens.nullability-mismatch` reds the deploy first). Worth confirming this default is
  intended; it affects how the firing cases read (logical `a integer` is NOT NULL there too,
  which does not change the uniqueness-over-restriction semantics).
- **Signature deviation from the ticket.** The ticket's suggested `warnOverRestrictiveBasisKey`
  signature included a `constraint: LogicalConstraint` param; it is unused (site/message/
  fingerprint derive from `label`/`columnNames`/`ctx`), so I dropped it rather than
  `_`-prefix a dead param. The call site passes 7 args.
- **No write-path behavioral test.** Tests assert deploy-time classification + advisory only.
  I did not add a test that actually inserts `(1,2)` then `(1,3)` and observes the basis
  reject the second — the advisory is diagnostic-only and the rejection is existing basis-UC
  behavior, but a reviewer may want that end-to-end demonstration.

## Validation run

- `yarn workspace @quereus/quereus run test` → **6296 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` → clean (eslint + `tsc -p tsconfig.test.json`).
- No `.pre-existing-error.md` written — no unrelated failures surfaced.
