description: A logical UNIQUE/PK classified `proved` (zero runtime enforcement) whose uniqueness rests on a basis key now reds `lens.unenforceable-conflict-action` at `apply schema` when it declares an `on conflict replace`/`ignore` the governing basis key does not itself carry — closing the silent conflict-action drop on both the body-proved-via-basis-key arm and the bijection-transport arm.
files:
  - packages/quereus/src/schema/lens-prover.ts
  - packages/quereus/src/schema/table.ts
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic
  - packages/quereus/test/lens-enforcement.spec.ts
  - docs/lens.md

# Proved key whose uniqueness rests on a basis key silently dropped a declared conflict action — COMPLETE

## What shipped

A logical UNIQUE/PK classified `proved` is enforced by the **basis key** standing
behind it, whose own conflict action (`statement-OR ?? basis-key.defaultConflict ??
ABORT`) resolves a write-through duplicate — the logical key's own `defaultConflict`
is never consulted. So a logical `on conflict replace`/`ignore` the basis key does not
itself carry was silently dropped at write time. It now reds
`lens.unenforceable-conflict-action` at `apply schema`, mirroring the row-time and
commit-time arms.

The implementer **deviated materially** from the original ticket — which scoped the
fix to only the bijection-transport arm and said "do not add the check to the
body-proved arm" — and was right to: the ticket's own headline repro (`code as grp`
over a basis NOT-NULL UNIQUE) is **body-proved**, not transport-proved, so a
transport-only fix would have left the headline bug unfixed. The shipped fix computes
`proveKeyByBijectionTransport` up front and runs the conflict-action rejecter when a
transport proof exists, on **either** arm.

Mechanism (`classifyKeyConstraint`, lens-prover.ts):
- `proveKeyByBijectionTransport` return type `boolean → TransportProof | undefined`
  (`{ basis, match: DeclaredKeyMatch }`), so the caller reads which basis key (PK or a
  specific UNIQUE) governs and derives its action via `basisKeyDefaultConflict` /
  `basisKeyLabel`.
- `table.ts` gained `DeclaredKeyMatch` + `findDeclaredKey`; `columnsFormDeclaredKey` is
  now a thin boolean wrapper (its other caller, `lens-compiler.ts`, untouched).
- `rejectBasisGovernedConflictAction` is the shared DRY core; `rejectRowTimeConflictAction`
  (covering-MV basis UC) and the new `rejectTransportConflictAction` both funnel into it.

## Validation

- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — clean, EXIT=0.
- `yarn test` (full quereus suite) — **6243 passing, 0 failing, 9 pending**. Re-run
  during this review pass, green at HEAD. No `test:store` (no store surface touched);
  no `.pre-existing-error.md` (suite fully green).

## Review findings

Read the implement diff (`08da7c57`) with fresh eyes before the handoff summary, then
scrutinized the prover change, the shared rejecter, the `findDeclaredKey` refactor, the
return-type change at all call sites, the docs, and the tests. Empirically probed the
single load-bearing judgment call (transport-as-proxy) with a throwaway spec (since
deleted).

### Major — filed as new ticket

- **Body-proved key whose basis-key backing transport can't recognize still drops its
  conflict action** → `tickets/fix/lens-proved-superkey-basis-key-conflict-action-drop.md`.
  The conflict-action rejecter is gated on a successful `proveKeyByBijectionTransport`,
  which is strictly *narrower* than "a basis key governs the write-through" along two
  axes, so two basis-keyed body proofs escape the check and **deploy clean while
  silently dropping `on conflict replace`/`ignore`** — the exact defect this ticket set
  out to close:
  1. **Superkey (single-source), CONFIRMED empirically.** `proveEffectiveKeyUnique`
     proves any *superset* of a real relation key (superkey semantics), but
     `findDeclaredKey` requires *exact* set-equality. Logical `unique(a,b) on conflict
     replace` over basis `unique(a)` (ABORT): the body proves `{a,b}` via subset `{a}`,
     the basis `unique(a)` governs (any dup `(a,b)` is a dup `a` → ABORT), but
     `findDeclaredKey({a,b})` finds no exact key → `transport === undefined` → no
     rejection → deploys clean, REPLACE dropped. This is precisely the
     "body-proved-via-basis-key shape that `isUnique` accepts but transport rejects"
     the implementer flagged as the thing to sanity-check — it exists.
  2. **Multi-source.** `proveKeyByBijectionTransport` returns `undefined` with no single
     `basisSource`; a multi-source basis-keyed proof skips the rejecter too. (The
     implementer named this one in "Known gaps".)
  Filed rather than fixed inline: closing it requires identifying the governing basis
  key without transport's exact-match/single-source gate, which is a soundness design
  question (which subset key fires first; multi-source action resolution), not a review
  edit.

### Minor — noted, not blocking

- **IGNORE arm untested.** `rejectBasisGovernedConflictAction` fires on `REPLACE ||
  IGNORE`, but every new test (sqllogic 25–28, the 4 spec pins) pins only REPLACE. The
  code path is symmetric so risk is low; the new fix ticket's requirements include an
  IGNORE pin.
- **Doc slightly overclaims completeness.** `docs/lens.md` § Constraint Attachment now
  reads as if *every* `proved` key with a mismatched basis-carried action is rejected;
  the superkey/multi-source residual escapes. Left as-is (the doc reflects the intended
  end-state and the new fix ticket owns reconciling prose with the established
  boundary); flagged here for honesty.

### Checked, clean

- **No false positives in the transport arm.** The rejecter fires only when transport
  *succeeds* (the basis key genuinely governs) AND the effective action is REPLACE/IGNORE
  AND it differs from the basis key's action — all three necessary for a real silent
  drop. A matching action / ABORT-family / no action / genuinely basis-keyless body
  proof all deploy clean (verified by tests 27, 28b, and the spec matching-action pin).
- **DRY / modularity.** The shared `rejectBasisGovernedConflictAction` core correctly
  unifies the row-time and transport rejecters; `findDeclaredKey` ←→
  `columnsFormDeclaredKey` split keeps the lens-compiler caller on the boolean API.
- **Type safety.** `boolean → TransportProof | undefined` return-type change type-checks
  at all call sites (lint EXIT=0). `basisKeyDefaultConflict` mirrors
  `effectiveKeyDefaultConflict`'s two arms (PK via `resolvePkDefaultConflict`, UNIQUE
  via its own `defaultConflict`) exactly.
- **Behavioral honoring.** sqllogic 27 proves the matching-action positive case actually
  *honors* REPLACE through the basis UNIQUE (duplicate `code` replaces, basis ends one
  row), not merely that it deploys — a genuine write-path assertion, not just a deploy
  check.
- **Tests + lint pass** at HEAD (re-run this pass): 6243 passing / 0 failing, lint clean.
