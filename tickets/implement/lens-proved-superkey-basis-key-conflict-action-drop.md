description: A logical `proved` UNIQUE/PK whose uniqueness rests on a basis key that bijection-transport cannot recognize (a strict superkey of a smaller declared basis key, or any multi-source basis-keyed proof) still silently drops a declared `on conflict replace`/`ignore`. Decouple the conflict-action rejecter from the exact-match/single-source `proveKeyByBijectionTransport` gate: identify the *governing* basis key by a SUBSET search over the mapped basis columns (single-source) and reject conservatively when governance cannot be pinned (multi-source).
prereq: lens-proved-transport-key-conflict-action-drop
files:
  - packages/quereus/src/schema/lens-prover.ts                 # classifyKeyConstraint: replace transport-gated rejecter with basis-governance check; refactor proveKeyByBijectionTransport's mapping loop; generalize basisKeyDefaultConflict/basisKeyLabel off TransportProof
  - packages/quereus/src/schema/table.ts                       # add findGoverningBasisKeys (subset search) alongside findDeclaredKey (exact)
  - packages/quereus/test/lens-enforcement.spec.ts             # "conflict action on a transport-proved key" describe block — add superkey (UNIQUE+PK), multi-source, IGNORE, and negative pins
  - docs/lens.md                                               # § Constraint Attachment — line 282 conflict-action paragraph overclaims completeness; state the actual boundary
difficulty: hard

# Body-proved key whose basis-key backing transport can't see still drops its conflict action

## Confirmed repro (verified empirically this run — deploys CLEAN, no error)

```sql
declare schema y {
  table t (id integer primary key, a integer not null unique check (a in (1,2,3)), b integer not null)
}
apply schema y;
declare logical schema x {
  table t (id integer primary key, a integer not null check (a in (1,2,3)), b integer not null,
           unique (a, b) on conflict replace)
}
declare lens for x over y { view t as select id, a, b from y.t }
apply schema x;   -- EXPECTED: error lens.unenforceable-conflict-action
                  -- ACTUAL  : deploys clean — REPLACE silently dropped
```

A throwaway spec confirmed `apply schema x` does **not** throw. The body proves
`unique(a,b)` because the basis NOT-NULL `unique(a)` → relation key `{a}` is a
**subset** of `{a,b}` (`proveEffectiveKeyUnique` proves any superset of a real key —
`coverage-prover.ts:520` superkey note). The basis `unique(a)` (ABORT) governs any
write-through duplicate `(a,b)` (it is also a duplicate `a`), so the logical REPLACE
is never consulted. But `proveKeyByBijectionTransport` maps `{a,b}` → basis `{a,b}` and
calls `findDeclaredKey({a,b})`, which requires **exact** set-equality → no match →
`transport === undefined` → the rejecter (`rejectTransportConflictAction`) is skipped.

## Root cause

`classifyKeyConstraint` (`lens-prover.ts:1469`) currently uses
`transport !== undefined` as a proxy for "a basis key governs the body proof":

```ts
const transport = proveKeyByBijectionTransport(ctx, logicalColumns, bijectiveAuthored);
const bodyProvesKey = ctx.root != null && outCols.length === logicalColumns.length
    && proveEffectiveKeyUnique(ctx.root, outCols).proved;
if (bodyProvesKey || transport) {
    if (transport) rejectTransportConflictAction(ctx, constraint, transport, ...);  // only when transport !== undefined
    return { constraint, kind: 'proved' };
}
```

The biconditional "transport exists ⟺ a basis key governs the body proof" is false in
the ⟸ direction along **two** axes — `proveKeyByBijectionTransport` (`lens-prover.ts:1834`)
is strictly narrower than "the proof rests on a basis key":

1. **Exact-match gate** — `findDeclaredKey` (`table.ts:809`) requires the mapped basis
   columns to set-equal a declared basis key. A logical key that is a strict **superkey**
   of a smaller basis key is body-proved (superkey semantics) but transport-undefined.
   *(The confirmed repro.)*
2. **Single-source gate** — `proveKeyByBijectionTransport` returns `undefined` when there
   is no single `ctx.basisSource` (multi-source / decomposition body). A multi-source body
   whose key proof rests on a basis key skips the rejecter (the parent ticket's named
   "Multi-source bodies are not covered" gap).

Both deploy clean while silently dropping a declared `on conflict replace`/`ignore` — the
exact defect the parent ticket (`lens-proved-transport-key-conflict-action-drop`, now
landed) set out to close, residual because closing it requires identifying the governing
basis key *without* transport's exact-match/single-source gate.

## Design — "which basis key governs" by SUBSET search

Decouple the conflict-action check from the `proved`-classification proof. Keep
`proveKeyByBijectionTransport` + `findDeclaredKey` exactly as-is — they answer "is this
key `proved` **via transport**" (an authored bijection onto an *exact* basis key; a strict
superset does not *prove* the smaller key's uniqueness, so exact-match is correct there).
Add an independent **governance** check that runs whenever the key is classified `proved`
(the `bodyProvesKey || transport` branch).

### Single-source governance (closes the confirmed repro)

The governing basis keys of a proved logical key are **every declared basis key (PK or
non-partial UNIQUE) whose column set is a subset of the logical key's mapped basis
columns.** Soundness: the logical key ⊇ any such basis key K (as column sets, after the
1:1 column mapping), so two rows equal on the full logical key are equal on K — *every*
subset basis key fires on *every* logical-key write-through duplicate. Therefore:

- **No governing basis key** (mapped columns subsume no declared basis key) ⇒ the proof is
  genuinely **basis-keyless** (a GROUP BY aggregate, an FD-closure key, etc.) ⇒ vacuous
  `on conflict`, deploy clean (preserves the "genuinely basis-keyless stays untouched"
  requirement).
- **Logical action is REPLACE/IGNORE and some governing basis key carries a different
  action** ⇒ that basis key (ABORT, or a mismatched REPLACE/IGNORE) fires first and drops
  the declared action ⇒ reject `lens.unenforceable-conflict-action`.
- **All governing basis keys carry the matching action** ⇒ honored for free ⇒ deploy clean
  (the documented remediation; matches the existing exact-match `proved` test).

When several subset basis keys exist with *differing* actions, the basis enforcement order
that decides which fires first is an implementation detail not soundly pinnable at deploy —
so reject conservatively (the ticket explicitly blesses this) the moment *any* governing
key mismatches. This strictly subsumes today's exact-match behavior (the exact key is a
subset of itself) and adds the superkey case.

### Multi-source governance (folds in the parent's named gap)

`ctx.basisSource` is undefined ⇒ the 1:1 logical→basis-column mapping the subset search
needs does not exist, and the superkey soundness argument (logical key ⊇ basis key) does
**not** transfer across a decomposition (the logical columns come from different basis
rows). Governance cannot be pinned soundly. **Recommended:** reject conservatively — a
multi-source `proved` (or transport, which is already undefined here) key declaring
REPLACE/IGNORE on a `!readOnly` table reds `lens.unenforceable-conflict-action`, because
the write path cannot be shown to honor the declared action. Document the over-rejection
and the escape hatch (drop the conflict action, or declare it on the basis key). The
genuinely-basis-keyless multi-source REPLACE shape (e.g. a writable join+group-by with
`on conflict replace`) is over-rejected by this; it is niche and conflict resolution over
a decomposition write is itself not clearly supported, so the over-rejection is acceptable
per the ticket. **Verify against the full suite** that no existing test pins a clean deploy
for such a shape; if one surfaces, narrow to per-source lineage mapping (future work) or
file a follow-up rather than regressing it.

### Mechanics

- Extract `proveKeyByBijectionTransport`'s per-column mapping loop into a reusable
  `mapLogicalKeyToBasisColumns(ctx, logicalColumns, bijectiveAuthored): number[] | undefined`
  (bare-reconstructible → `mappedBasisColumn`; authored-bijective → `authoredPutTargetBasisColumn`;
  undefined on multi-source / unmappable / multi-target authored put). **Do NOT** carry the
  `notNull` gate into the governance mapping — that gate is a `proved`-classification concern
  (a nullable basis key is NULL-skipping, so it cannot back an *unconditional* `proved` FD);
  governance asks only which basis key fires on a *non-null* write-through duplicate, which a
  nullable subset basis key still governs. Keep the `notNull` gate inside
  `proveKeyByBijectionTransport`.
- Add `findGoverningBasisKeys(table, basisCols): DeclaredKeyMatch[]` to `table.ts` beside
  `findDeclaredKey` — same PK + non-partial-UNIQUE walk, but `pk.every(c => want.has(c))`
  (subset) instead of exact set-equality, returning *all* matches. Reuse the existing
  `DeclaredKeyMatch` shape.
- Generalize `basisKeyDefaultConflict` / `basisKeyLabel` to take `(basis: TableSchema, match:
  DeclaredKeyMatch)` instead of `TransportProof` (a `TransportProof` is just that pair), so
  the governance check can label/resolve the action of any matched governing key. Update the
  two existing transport callers.
- Replace the `if (transport) rejectTransportConflictAction(...)` line with a single
  `rejectBasisGovernedConflictActionForProvedKey(...)` that: returns on `readOnly`; returns
  unless `effectiveKeyDefaultConflict` is REPLACE/IGNORE; maps to basis columns; on
  single-source finds governing keys and delegates to the existing
  `rejectBasisGovernedConflictAction` with the first *mismatched* governing key (its
  `eff === basis.conflict` early-return already yields the all-match clean case); on
  multi-source (mapping undefined) rejects conservatively. `rejectTransportConflictAction`
  is then dead — fold it in / remove it.

The existing `rejectBasisGovernedConflictAction` shared core (`lens-prover.ts:1616`) stays
the single diagnostic emitter (gated on `!readOnly`, REPLACE/IGNORE, and `eff !==
basis.conflict`); pass it the governing key as `basis`.

## Realizability concern (decided & deferred)

The strictly-more-restrictive-basis superkey shape (basis `unique(a)`, logical `unique(a,b)`)
is **a separate realizability concern**, not handled by this conflict-action fix: the logical
schema advertises write-capacity the basis cannot hold — logical `unique(a,b)` permits rows
`(1,2)` and `(1,3)` to coexist, but the basis `unique(a)` forbids it. The logical key is
*over*-enforced, not unenforceable, so it is not a `lens.unrealizable-constraint`. **Decision:
out of scope here** (this ticket only stops the silent conflict-action drop); filed as a
separate backlog ticket `lens-superkey-over-restrictive-basis-realizability` for the advisory
analysis. Document this boundary in the implement work, not block on it.

## TODO

- [ ] `table.ts`: add `findGoverningBasisKeys(table, basisCols)` — subset (`⊆`) search over PK
      + non-partial UNIQUE, returning all `DeclaredKeyMatch`. Doc-comment it beside
      `findDeclaredKey`, contrasting exact-match vs subset and *why* governance needs subset.
- [ ] `lens-prover.ts`: extract `mapLogicalKeyToBasisColumns` from `proveKeyByBijectionTransport`
      (no `notNull` gate in the extracted mapper; keep the gate in the transport proof).
- [ ] `lens-prover.ts`: generalize `basisKeyDefaultConflict` / `basisKeyLabel` to
      `(basis, match)`; update the transport callers.
- [ ] `lens-prover.ts`: add `rejectBasisGovernedConflictActionForProvedKey` (single-source
      subset governance + multi-source conservative reject); replace the
      `if (transport) rejectTransportConflictAction(...)` call with it; remove the now-dead
      `rejectTransportConflictAction`.
- [ ] Tests (`lens-enforcement.spec.ts`, extend the "conflict action on a transport-proved
      key" describe block):
  - [ ] superkey single-source UNIQUE, mismatched REPLACE (the confirmed repro) → blocks.
  - [ ] superkey single-source UNIQUE, mismatched **IGNORE** → blocks (IGNORE arm of
        `rejectBasisGovernedConflictAction` is currently untested).
  - [ ] superkey single-source **PK** (logical PK a superset of a smaller basis UNIQUE),
        mismatched action via `resolvePkDefaultConflict` → blocks.
  - [ ] superkey single-source where the subset basis key carries the **matching** action →
        deploys clean (honored for free).
  - [ ] multi-source basis-keyed proof with mismatched REPLACE/IGNORE → blocks (conservative).
  - [ ] genuinely basis-keyless single-source proof (GROUP BY over plain cols, no basis UC
        over the key) declaring `on conflict replace` → deploys clean (no new false positive).
- [ ] `docs/lens.md` line 282: the conflict-action paragraph claims the check fires whenever
      "a *basis key* stands behind the logical key … a body proof that rests on a basis key".
      State the *actual* boundary this fix establishes: single-source identifies the governing
      basis key by **subset** of the mapped basis columns (so a superkey of a smaller basis key
      is covered); when multiple subset keys disagree, or the body is **multi-source**, the
      check rejects conservatively (the governing/first-firing key cannot be pinned), with the
      same remediation (declare the matching action on the basis key, or drop the logical
      action). Note the strictly-more-restrictive-basis superkey *realizability* concern is
      tracked separately.
- [ ] Run `yarn workspace @quereus/quereus test` (lens specs at minimum) + `yarn lint`; confirm
      no multi-source proved-key-with-conflict-action regression.
