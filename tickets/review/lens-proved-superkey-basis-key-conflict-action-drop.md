description: Review the decoupling of the lens conflict-action rejecter from the exact-match/single-source bijection-transport gate. A `proved` logical key (by body or transport) whose uniqueness rests on a basis key that transport cannot recognize — a strict superkey of a smaller declared basis key (single-source) or any multi-source basis-keyed proof — previously dropped a declared `on conflict replace`/`ignore` silently. The fix identifies the *governing* basis key by SUBSET search over the mapped basis columns (single-source) and rejects conservatively when governance cannot be pinned (multi-source).
prereq: lens-proved-transport-key-conflict-action-drop
files:
  - packages/quereus/src/schema/table.ts                       # NEW findGoverningBasisKeys (subset search) beside findDeclaredKey (exact)
  - packages/quereus/src/schema/lens-prover.ts                 # mapLogicalKeyToBasisColumns extracted; basisKeyDefaultConflict/basisKeyLabel generalized to (basis, match); rejectBasisGovernedConflictActionForProvedKey replaces rejectTransportConflictAction
  - packages/quereus/test/lens-enforcement.spec.ts             # 6 new tests in "conflict action on a transport-proved key" describe block (10 total)
  - docs/lens.md                                               # § Constraint Attachment — conflict-action paragraph now states the subset/multi-source boundary
difficulty: hard

# Review: superkey / multi-source proved-key conflict-action drop

## What changed (and why it is sound)

The bug: `classifyKeyConstraint` (`lens-prover.ts`) used `transport !== undefined`
(`proveKeyByBijectionTransport`) as a proxy for "a basis key governs this proved key,"
and only then ran the conflict-action rejecter. But transport is strictly narrower than
"the proof rests on a basis key" along **two** axes:

1. **Exact-match gate** — `findDeclaredKey` requires the mapped basis columns to set-*equal*
   a declared basis key. A logical key that is a strict **superkey** of a smaller basis key
   (e.g. logical `unique(a,b)` over a basis NOT-NULL `unique(a)`) is body-proved
   (`proveEffectiveKeyUnique` proves any superset of a real key) but transport-undefined.
   The basis `unique(a)` still governs every `(a,b)` write-through duplicate, so a logical
   `on conflict replace`/`ignore` it does not carry was silently dropped. *(Confirmed repro.)*
2. **Single-source gate** — transport returns `undefined` for a multi-source body. A
   multi-source proved key declaring `replace`/`ignore` skipped the rejecter (the parent
   ticket's named "Multi-source bodies are not covered" gap).

The fix **decouples** the conflict-action check from transport. The new
`rejectBasisGovernedConflictActionForProvedKey` runs whenever a key is classified `proved`
(`bodyProvesKey || transport`):

- **Single-source:** `findGoverningBasisKeys(basis, mappedBasisCols)` returns *every* declared
  basis key (PK + non-partial UNIQUE) whose columns are a **subset** (`⊆`) of the logical
  key's mapped basis columns. Soundness: logical key ⊇ K ⇒ two rows equal on the full logical
  key are equal on K ⇒ K fires on every logical-key duplicate. Reject the first governing key
  whose action ≠ the declared action (funnelled through the shared `rejectBasisGovernedConflictAction`
  emitter, whose `eff === basis.conflict` early-return yields the all-match clean case). No
  governing key ⇒ genuinely basis-keyless ⇒ deploy clean.
- **Multi-source** (mapping undefined, no single `basisSource`): governance cannot be pinned
  (no 1:1 column mapping; the superkey argument does not transfer across a decomposition), so a
  `replace`/`ignore` declaration rejects conservatively.

`proveKeyByBijectionTransport` + `findDeclaredKey` are unchanged for the **proof** (exact-match
is correct there — a strict superset does not *prove* the smaller key's uniqueness). The shared
per-column mapping loop is extracted into `mapLogicalKeyToBasisColumns` (used by both proof and
governance); the `notNull` gate stays in the proof (a nullable basis key cannot back an
*unconditional* proved FD) and is deliberately **omitted** from the governance mapper (a nullable
subset basis key still governs a *non-null* write-through duplicate). `basisKeyDefaultConflict` /
`basisKeyLabel` were generalized from `TransportProof` to `(basis: TableSchema, match: DeclaredKeyMatch)`.

## Validation — all green

- `node ... mocha "packages/quereus/test/lens-enforcement.spec.ts" --grep "conflict action on a transport-proved key"` → **10 passing** (4 pre-existing + 6 new).
- All lens specs (`lens-*.spec.ts`) → **455 passing, 0 failing**.
- Full suite `yarn workspace @quereus/quereus test` → **6249 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`) → exit 0, no output.
- `yarn workspace @quereus/quereus typecheck` (src `tsc --noEmit`) → exit 0.

### Test cases added (review focus)

- **superkey UNIQUE, MISMATCHED REPLACE** (the confirmed repro: logical `unique(a,b)` over basis NOT-NULL `unique(a)`) → blocks. Before the fix this deployed clean.
- **superkey UNIQUE, MISMATCHED IGNORE** → blocks (exercises the IGNORE arm, previously untested).
- **superkey PK** (logical `primary key (a,b)` ⊋ basis `unique(a)`), MISMATCHED REPLACE via `resolvePkDefaultConflict` → blocks.
- **superkey UNIQUE, MATCHING action** (basis `unique(a) on conflict replace`) → deploys clean, stays `proved`, no set-level obligation.
- **multi-source proved key** (1:1 join, logical PK `on conflict replace`) → blocks conservatively. **Verified** (one-off diagnostic) this travels the NEW "no single-source basis-column mapping" path — the join PK *is* proved — not the pre-existing commit-time path; before the fix it deployed clean.
- **genuinely basis-keyless proof** (`select distinct a, b`, basis PK `{id}` only) with `on conflict replace` → deploys clean (exercises the "no governing key → clean" branch).

## Known gaps / honest notes for the reviewer

- **GROUP BY ≠ DISTINCT for `proved`.** The ticket's example basis-keyless shape was "GROUP BY over
  plain cols," but empirically `select a, b from t group by a, b` (no aggregate) classifies
  `enforced-set-level commit-time` here (NOT `proved`), so it is rejected by the **pre-existing**
  commit-time block, not the new governance path. `select distinct a, b` *does* reach `proved`
  while staying writable, so the basis-keyless-clean test uses DISTINCT. The coverage-prover doc
  claims GROUP BY proves the key; the no-aggregate group-by not surfacing as `proved` may be a
  separate pre-existing limitation worth a glance, but it is out of scope here.
- **Multi-source over-rejection (accepted per ticket).** The conservative multi-source reject
  over-rejects the niche genuinely-basis-keyless multi-source `replace` shape (e.g. a writable
  join+group-by with `on conflict replace`). The full suite has **no** test pinning a clean deploy
  for such a shape (verified — suite green), so nothing regressed. Escape hatch: drop the conflict
  action, or declare it on the basis key. Narrowing to per-source lineage mapping is future work.
- **Realizability deferred.** The strictly-more-restrictive-basis superkey shape (basis `unique(a)`,
  logical `unique(a,b)` — the logical advertises write-capacity the basis cannot hold) is *over*-enforced,
  not unenforceable, so it is NOT a `lens.unrealizable-constraint`. Out of scope here; tracked under
  `tickets/backlog/lens-superkey-over-restrictive-basis-realizability.md` (referenced from the code
  comment and `docs/lens.md`).
- **Conservatism on differing subset keys.** When several subset basis keys disagree on action, the
  check rejects on the *first* mismatch (the basis enforcement order that decides which fires first is
  not soundly pinnable at deploy). The ticket explicitly blesses this; worth confirming the reviewer
  agrees the message names a sensible governing key in that (rare) case.
