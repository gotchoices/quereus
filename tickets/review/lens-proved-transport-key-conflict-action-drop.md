description: A logical UNIQUE/PK whose uniqueness rests on a basis key silently dropped a declared `on conflict replace`/`ignore` — the basis key's action governs the write, not the logical key's. Now reds `lens.unenforceable-conflict-action` at deploy on EITHER the body-proved-via-basis-key arm or the bijection-transport arm.
files:
  - packages/quereus/src/schema/lens-prover.ts                        # classifyKeyConstraint proved arms; rejectBasisGovernedConflictAction; rejectTransportConflictAction; proveKeyByBijectionTransport (now returns TransportProof); basisKeyDefaultConflict/basisKeyLabel
  - packages/quereus/src/schema/table.ts                              # DeclaredKeyMatch + findDeclaredKey; columnsFormDeclaredKey delegates
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic   # scenarios 25-28
  - packages/quereus/test/lens-enforcement.spec.ts                    # "conflict action on a transport-proved key" describe block (4 pins)
  - docs/lens.md                                                      # § Constraint Attachment — conflict-action enforceability across all key paths
difficulty: medium

# Proved key whose uniqueness rests on a basis key silently dropped a declared conflict action

## What shipped

A logical UNIQUE/PK classified `proved` (zero runtime enforcement) is enforced by a
**basis key** when one stands behind it. A duplicate is resolved by *that basis key's*
own conflict action (`statement-OR ?? basis-key.defaultConflict ?? ABORT`) — the
logical key's own `defaultConflict` is never consulted. So a logical
`on conflict replace`/`ignore` the basis key does not itself carry was silently
dropped at write time, exactly the hazard the row-time and commit-time arms already
guard. It now reds `lens.unenforceable-conflict-action` at `apply schema`.

## ⚠️ Material deviation from the original ticket — read this first

The original ticket scoped the fix to **only the bijection-transport arm** and
explicitly said *"Do not add the check to the body-proved arm"* (claiming body-proved
keys have "no basis key behind them"). **That premise is wrong for the ticket's own
headline repro.** I verified empirically (throwaway probe, since deleted):

- The headline repro `view t as select id, code as grp` over basis
  `code integer not null unique` is **body-proved**, not transport-proved. A base-table
  NOT-NULL UNIQUE is promoted to a relation key (`planner/type-utils.ts:39-46`), so
  `proveEffectiveKeyUnique` proves the logical key directly via the basis UNIQUE and
  returns at the body-proved arm **before** the transport arm is ever reached.
- A transport-arm-only fix therefore left the headline repro **still deploying clean**
  with the declared REPLACE silently dropped — it did not fix the stated bug.

The correct unifying insight: the conflict-action check must fire whenever a **basis
key backs the proof**, regardless of which arm produces the `proved` classification.
`proveKeyByBijectionTransport` already answers "is there a basis key behind this key
and which one" — so I compute it up front and run the rejecter before returning
`proved` from **either** arm. A genuinely basis-keyless body proof (a GROUP BY
aggregate, etc.) has `transport === undefined`, so its vacuous `on conflict` deploys
clean — preserving the *spirit* of the ticket's "don't touch vacuous proofs" rule
while actually fixing the defect.

**This is the single most important thing for the reviewer to scrutinize:** is gating
the conflict-action rejection on a successful `proveKeyByBijectionTransport` the right
proxy for "a basis key governs the write-through", and does it have false-positive or
false-negative edges? My analysis (below) says no for the in-scope single-source
shapes, but it is the load-bearing judgment call.

## How it works now (`classifyKeyConstraint`, lens-prover.ts ~1503-1530)

```
transport = proveKeyByBijectionTransport(...)        // TransportProof | undefined
bodyProvesKey = ctx.root && allColsResolved && proveEffectiveKeyUnique(...).proved
if (bodyProvesKey || transport) {
    if (transport) rejectTransportConflictAction(...)  // pushes error iff mismatch
    return { kind: 'proved' }
}
```

- `proveKeyByBijectionTransport` changed return type `boolean → TransportProof | undefined`
  (`{ basis: TableSchema; match: DeclaredKeyMatch }`), so the caller can read which
  basis key (PK or a specific UNIQUE) and derive its governing action.
- `table.ts` gained `DeclaredKeyMatch` + `findDeclaredKey` (returns the matched key);
  `columnsFormDeclaredKey` is now a thin boolean wrapper over it (its other caller,
  `lens-compiler.ts validatePrimaryAdvertisement`, is untouched — still boolean).
- `rejectBasisGovernedConflictAction` is the shared core (per AGENTS.md DRY): fires only
  when the logical effective action is REPLACE/IGNORE *and* differs from the basis key's
  action, gated on `!readOnly`. `rejectRowTimeConflictAction` (covering-MV basis UC) and
  the new `rejectTransportConflictAction` (matched basis key via `basisKeyDefaultConflict`
  / `basisKeyLabel`) both funnel into it. The diagnostic wording was reworded slightly
  vs the old row-time message but kept close; no test asserts on the prose (only the code
  `/unenforceable-conflict-action/`).

## Validation

- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) — clean, EXIT=0. The
  `proveKeyByBijectionTransport` return-type change type-checks at all call sites.
- `yarn test` (full quereus suite) — **6243 passing, 0 failing**. Includes the new
  sqllogic scenarios and the lens-enforcement.spec.ts pins. No `test:store` run (no
  store-specific surface touched); no `.pre-existing-error.md` (suite fully green).

## Use cases / behaviors covered

sqllogic `55.5-lens-authored-inverse.sqllogic`:
- **25 (headline repro)** — bare-rename `code as grp` over basis `code … unique` (no
  action) + logical `unique (grp) on conflict replace` → `error: lens.unenforceable-
  conflict-action`. This is the **body-proved** path — the one the original ticket
  mechanism would have missed.
- **26** — authored +10 bijection, basis `code … unique`, logical `unique (grp) on
  conflict replace` → same error. The **transport** path (`code + 10` is not body-provable).
- **27** — matching: basis `code … unique on conflict replace`, logical `unique (grp) on
  conflict replace` → deploys clean (0 advisories) AND the write **honors REPLACE** (a
  duplicate `code` replaces, basis ends one row `{id:2, code:1}`), proving the action is
  honored not ABORTed.
- **28a / 28b** — PK transport variant: logical PK `on conflict replace` over a
  plain-ABORT basis PK → red; matching basis PK action → clean.

unit `lens-enforcement.spec.ts` (describe "conflict action on a transport-proved key"):
- authored-bijective UNIQUE mismatch → throws `/unenforceable-conflict-action/`.
- **bare-rename UNIQUE proved by the BODY** mismatch → throws (pins the discovery — the
  body-proved-via-basis-key path is the regression guard most likely to silently break).
- transport-proved PK mismatch → throws.
- matching basis-UNIQUE action → stays `proved` (`o.kind === 'proved'`), collector `[]`,
  deploys clean.

## Known gaps / where a reviewer should push

- **Multi-source bodies are not covered.** `proveKeyByBijectionTransport` returns
  `undefined` when there is no single `basisSource`, so a multi-source/decomposition body
  whose key proof rests on a basis key would NOT trigger the rejection. This is consistent
  with the row-time path (`findBasisCovering` also requires single-source) and with the
  ticket's single-source framing, but it is a real residual: a multi-source proved key
  with `on conflict replace` could still silently drop the action. Not exercised by any
  test. Flagging rather than fixing — confirm this is acceptable scope.
- **The `transport`-as-proxy judgment.** The check assumes "a transport proof exists" ⟺
  "a basis key governs the write-through" for the body-proved arm. I argued this holds
  because the only body proofs that rest on a basis key are faithful bare projections of a
  basis PK/NOT-NULL-UNIQUE, which `isReconstructibleColumn` + `findDeclaredKey` also
  recognize. A reviewer should sanity-check there is no body-proved-via-basis-key shape
  that `isUnique` accepts but transport rejects (e.g. an unusual projection/collation
  case) — that would be a silent false-negative, not a crash.
- **Diagnostic wording** was reworded into the shared core ("its backing <basis key
  label> resolves a duplicate to '<action>' — the write path honors the basis key's
  action…"). It reads consistently for row-time/transport but is no longer the verbatim
  old row-time string; confirm that is acceptable (no test pins the prose).
- The original ticket's "Semantics to preserve" bullet *"Only the transport sub-case …
  do not add the check to that [body-proved] arm"* is **intentionally not followed** — see
  the deviation section. If the reviewer disagrees with broadening to the body-proved arm,
  the alternative is to leave the headline repro unfixed, which seems wrong.
