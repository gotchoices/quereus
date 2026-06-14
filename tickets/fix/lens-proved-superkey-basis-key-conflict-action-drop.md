description: A logical UNIQUE/PK proved `proved` by the BODY whose proof rests on a basis key that bijection-transport does NOT recognize (a strict superkey of a smaller declared basis key, or any multi-source basis-keyed proof) still silently drops a declared `on conflict replace`/`ignore`. The conflict-action rejecter is gated on a successful `proveKeyByBijectionTransport`, which is strictly narrower than "a basis key governs the write-through" — it requires exact set-equality to a declared basis key AND a single basis source.
prereq: lens-proved-transport-key-conflict-action-drop
files:
  - packages/quereus/src/schema/lens-prover.ts                 # classifyKeyConstraint body-proved arm; proveKeyByBijectionTransport (exact-match + single-source gate); rejectBasisGovernedConflictAction
  - packages/quereus/src/schema/table.ts                       # findDeclaredKey (exact set-equality; would need a subset-search variant)
  - packages/quereus/src/planner/analysis/coverage-prover.ts   # proveEffectiveKeyUnique — superkey semantics (isUnique proves any superset of a real key)
  - packages/quereus/test/lens-enforcement.spec.ts             # "conflict action on a transport-proved key" describe block (extend with superkey + multi-source pins)
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic
  - docs/lens.md                                               # § Constraint Attachment — the conflict-action paragraph overclaims completeness
difficulty: hard

# Body-proved key whose basis-key backing transport can't see still drops its conflict action

## Background

Ticket `lens-proved-transport-key-conflict-action-drop` made a `proved` logical
UNIQUE/PK red `lens.unenforceable-conflict-action` when a *basis key* governs the
write-through but the logical key declares a different `on conflict replace`/`ignore`.
It identifies "a basis key governs" by computing `proveKeyByBijectionTransport`
up front and rejecting on the transport proof's matched basis key — fired on **both**
the body-proved arm and the transport arm:

```
const transport = proveKeyByBijectionTransport(...)   // TransportProof | undefined
const bodyProvesKey = ctx.root && allColsResolved && proveEffectiveKeyUnique(...).proved
if (bodyProvesKey || transport) {
    if (transport) rejectTransportConflictAction(...)   // only when transport !== undefined
    return { kind: 'proved' }
}
```

The load-bearing assumption (the implementer flagged it explicitly as the thing to
scrutinize): **"a transport proof exists" ⟺ "a basis key governs the body proof."**
That biconditional is false in the ⟸ direction. `proveKeyByBijectionTransport` is
strictly *narrower* than "the body proof rests on a basis key" along two axes, so a
body-proved key whose uniqueness genuinely rests on a basis key can have
`transport === undefined`, skip the rejecter, and **deploy clean while silently
dropping the declared conflict action** — the exact defect the parent ticket set out
to close.

## Confirmed repro (single-source SUPERKEY)

`proveEffectiveKeyUnique` proves **any superset** of a real relation key (superkey
semantics — see `coverage-prover.ts` doc and `covering-structure.spec.ts` "group-by
proves a superset of the group key"). But `findDeclaredKey` requires **exact**
set-equality. So a logical key that is a strict superset of a smaller declared basis
key is body-proved but transport-rejected:

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
                  -- ACTUAL  : deploys CLEAN — REPLACE silently dropped
```

The body proves `unique(a,b)` because `{a}` (the basis NOT-NULL UNIQUE → relation key)
is a subset of `{a,b}`. The basis `unique(a)` (ABORT) governs the write: any duplicate
`(a,b)` is also a duplicate `a`, so the basis UC ABORTs it before the logical REPLACE
is ever consulted. `proveKeyByBijectionTransport` maps `{a,b}` and calls
`findDeclaredKey({a,b})`, which finds no exact declared key → `undefined` → no
rejection. Verified empirically (throwaway spec, deploy returned no error).

*(Aside: this shape is also questionable for realizability — the basis is strictly
more restrictive than the logical key, so the logical table cannot represent two rows
sharing `a` with different `b`. That is a separate concern from the conflict-action
drop and may warrant its own analysis.)*

## Second instance (MULTI-SOURCE)

`proveKeyByBijectionTransport` returns `undefined` when there is no single
`basisSource` (multi-source / decomposition body). A multi-source body whose key proof
rests on a basis key therefore also skips the rejecter. This is the gap the parent
ticket's "Known gaps" section already named ("Multi-source bodies are not covered").
Same root cause, same silent drop; fold it into this fix.

## Why this was deferred out of the parent ticket

The parent fix is correct and complete *for single-source bodies whose logical key
exactly equals a declared basis key* (bare rename, authored bijection, composite —
all the shipped tests). Closing the residual requires the body-proved arm to identify
the governing basis key **without** relying on transport's exact-match/single-source
gate — a non-trivial soundness question (which declared basis key actually fires first
when several subset keys exist? how is the governing action resolved across a
multi-source decomposition?). That is design work, not an inline review fix.

## Requirements

- A logical `proved` UNIQUE/PK declaring `on conflict replace`/`ignore` that differs
  from the action of the basis key that *actually governs its write-through* must red
  `lens.unenforceable-conflict-action` at `apply schema` — including when the logical
  key is a strict **superkey** of a smaller declared basis key, and (separately) when
  the proof rests on a basis key in a **multi-source** body.
- A matching action (or ABORT/FAIL/ROLLBACK / no action) must still deploy clean, and
  a genuinely basis-keyless body proof (GROUP BY aggregate, etc.) must remain
  untouched (vacuous `on conflict` deploys clean) — no new false positives.
- Resolve the "which basis key governs" question soundly: with multiple subset
  declared basis keys, identify the one whose violation fires first on a write-through
  duplicate (or, if that cannot be pinned down soundly, reject conservatively and
  document the over-rejection).
- Decide and document whether the strictly-more-restrictive-basis superkey shape is a
  realizability concern in its own right (the logical key under-constrains relative to
  the basis), separate from the conflict-action drop.
- Tests: superkey single-source (UNIQUE and PK), multi-source basis-keyed proof, plus
  the matching-action and genuinely-basis-keyless negative cases. Cover IGNORE as well
  as REPLACE (the parent ticket's tests pin only REPLACE; the IGNORE arm of
  `rejectBasisGovernedConflictAction` is currently untested).
- Update `docs/lens.md` § Constraint Attachment: the current conflict-action paragraph
  overclaims completeness ("a key declaring `on conflict replace`/`ignore` the backing
  basis key does not itself carry is rejected") — it must reflect whatever boundary
  this fix actually establishes.
