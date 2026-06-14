description: Review — a PK over a proven-bijective authored (`with inverse`) column is now key-reconstructible and deploys WRITABLE (classified `proved` by bijection transport onto a declared basis key), instead of read-only. The non-injective (lossy) and no-basis-key cases stay read-only / commit-time. Implemented, build + lint + full memory suite + new scenarios under store all green.
files:
  - packages/quereus/src/schema/lens-prover.ts            # proveLens reorder; analyzeRoundTrip/bijectiveAuthoredColumns/emitRoundTrip split; emitAuthoredInverseDiagnostics; checkKeyReconstructibility(bijectiveAuthored); proveKeyByBijectionTransport + authoredPutTargetBasisColumn; classify* threading
  - packages/quereus/src/schema/table.ts                  # new columnsFormDeclaredKey(table, indices) shared helper
  - packages/quereus/src/schema/lens-compiler.ts          # indicesFormDeclaredUnique removed → uses columnsFormDeclaredKey
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic  # scenario 13 comment tightened; new scenarios 18 (proved/writable) + 19 (commit-time/no-basis-key)
  - packages/quereus/test/lens-prover.spec.ts             # 3 pins: proved-writable, non-injective read-only, no-basis-key commit-time
  - packages/quereus/test/lens-fd-contribution.spec.ts    # 2 pins: bijective-PK contributes unconditional FD; no-basis-key contributes none
  - docs/lens.md                                          # §358 reconstructibility note, §370 round-trip note, Constraint Attachment bijection-transport paragraph

# Review: PK over a proven-bijective authored inverse → writable

## What changed (behavior)

A logical PK column written through an authored (`with inverse`) put is a *computed*
projection (`upper(code) as grp`), so it used to fail the bare-column
reconstructibility test and the table deployed **read-only** (`lens.pk-not-reconstructible`).
Now, when the prover's round-trip enumeration has already proved the forward/inverse
pair a **bijection** (the same `{kind:'proved', injective:true}` verdict that suppresses
`lens.getput-lossy`), that PK column is **key-reconstructible** and the table deploys
**writable**. The key additionally classifies **`proved`** (zero runtime enforcement,
contributing the unconditional key FD) by *bijection transport*: each key column maps to
its single put-target basis column, and those basis columns must exactly form a declared
basis key (basis PK or non-partial basis UNIQUE).

The non-injective (lossy) authored PK and the computed/opaque PK stay read-only,
**unchanged**. A bijective authored key whose put-target is *not* a basis key stays
writable but enforces **commit-time** (`lens.no-backing-index`), not proved.

## How it was built

1. **`proveLens` reorder** — the round-trip enumeration now runs **once, up front**
   (`analyzeRoundTrip`) producing both the bijection set and the cached per-authored-column
   `PutGetEnumeration`. `bijectiveAuthoredColumns(rt)` derives the proved-bijective set;
   `checkKeyReconstructibility` and `classifyKeyConstraint` both read it. `emitRoundTrip`
   consumes the cache to raise diagnostics (split out of the old `proveRoundTrip`);
   `emitAuthoredInverseDiagnostics` replaces the old `checkAuthoredInverse` (takes the
   cached enum instead of re-running it). **Pure refactor for branches 1–17** — verified
   byte-identical (55.5 scenarios 1–17 and property.spec § View Round-Trip Laws all pass).

2. **`columnsFormDeclaredKey(table, indices)`** added to `schema/table.ts` (PK +
   non-partial UNIQUE set-equality); `lens-compiler.ts`'s `indicesFormDeclaredUnique` was
   removed and both its call sites now use the shared helper (DRY, no behavior change —
   lens-put-fanout.spec still green).

3. **`proveKeyByBijectionTransport`** + `authoredPutTargetBasisColumn` in lens-prover.ts.
   `mappedBasisColumn` / `findBasisCovering` are untouched, so the existing bare-column
   covering / row-time path keeps its exact semantics.

## ⚠️ Deviation from the ticket design the reviewer MUST scrutinize

**The transport `proved` shortcut additionally requires every key column to be declared
NOT NULL.** The ticket's design said "every key column is bare-reconstructible **or**
authored-bijective" with no nullability gate. Without the gate, the branch is **unsound**
and broke 8 existing tests: a *nullable bare* column over a basis non-partial UNIQUE is
only *conditionally* unique (SQL UNIQUE is NULL-skipping), which the existing row-time
path correctly models with a guarded FD (`key → others [guard: key IS NOT NULL]`) — my
branch was promoting it to an unconditional `proved` FD, which the optimizer would use to
wrongly drop rows in DISTINCT/join-elimination. The NOT NULL gate is the soundness fix:
a PK column is always NOT NULL (so the headline PK case is unaffected), and an
authored-bijective column whose logical column is NOT NULL has a genuinely unconditional
key. A nullable key column now defers to row-time/commit-time. This is *more* correct than
the ticket's stated rationale ("the CHECK domain excludes NULL" is insufficient — a
nullable-declared column with a CHECK in-list still admits NULL via 3VL). **Verify this
gate does not over-restrict any intended case** (it under-claims, which is the safe
direction).

## Known gaps / observations (be honest)

- **Store text-PK NOCASE divergence (NOT my code; candidate backlog).** Under the LevelDB
  store backend, a single-column **TEXT** PRIMARY KEY column is assigned **NOCASE**
  collation (memory uses BINARY) for the *same* DDL. Under NOCASE a text CHECK in-list is
  not value-discriminating (`'a'`≡`'A'`), so the value-discrimination gate in
  `extractCheckConstraints` correctly drops the enum domain → the bijection cannot be
  proven → the authored text PK stays **read-only** in store while it is writable in
  memory. This is *sound* (conservative) given the NOCASE collation, but the underlying
  memory↔store collation default divergence for a text PK looks like a genuine pre-existing
  store inconsistency worth a separate ticket. To keep the new sqllogic scenarios
  cross-mode consistent, **scenarios 18/19 use INTEGER keys** (no collation quirk; verified
  passing under both memory and `QUEREUS_TEST_STORE=true`). The text upper/lower bijection
  remains covered by scenario 6 (non-PK, both modes) and the memory-only unit specs.
- **Single-column bijective PK contributes no FD** — `superkeyToFd` returns undefined for an
  all-columns key (v1, pre-existing). The FD-contribution pin therefore uses a **2-column**
  logical table (`n integer primary key, note text` → `n → note`) to exercise a non-trivial
  unconditional FD; the single-column sqllogic scenario only pins the obligation/advisories.
- **Mutation write path needed NO single-source.ts change** — insert / update-by-key /
  delete-by-key / GetPut-stable-write through a bijective authored PK all work via the
  existing `columnMap` WHERE-lowering (forward `get` in the predicate) + `writableSites`
  authored fan-out (inverse `put` in SET/VALUES). Verified end-to-end in scenario 18 under
  both backends. (If the reviewer distrusts this, it is the highest-value thing to re-probe.)
- **Degrade-to-safe unchanged** — an authored PK on an out-of-fragment body (join, scenario
  9-shape) gets no verdict → empty bijection set → stays read-only (intentional gap).

## Validation use-cases (what to exercise / re-probe)

Build: `yarn workspace @quereus/quereus run build` (green).
Lint:  `yarn lint` (eslint + tsc on tests; green).
Tests: `yarn workspace @quereus/quereus run test` → 6236 passing, 9 pending.

Targeted:
- `mocha … --grep "55.5-lens-authored-inverse"` (memory AND `QUEREUS_TEST_STORE=true`) — both green.
- `mocha … lens-prover.spec.ts lens-fd-contribution.spec.ts lens-enforcement.spec.ts` — 202 passing.
- `mocha … property.spec.ts --grep "Round-Trip"` — 61 passing (refactor preserved `computeRoundTrip`).

Behavioral checks the reviewer should confirm by hand:
- A PK over a proven-bijective authored inverse whose put-target IS a basis key deploys
  writable, classifies `proved`, emits **zero** advisories, and supports keyed
  insert/update/delete + a byte-stable GetPut self-write.
- The non-injective authored PK (substr collapse) stays read-only (`lens.pk-not-reconstructible`);
  the `lens.putget-violation` hard error is still NOT read-only-gated (scenario 14).
- A bijective authored key whose put-target is NOT a basis key is writable but commit-time
  (`lens.no-backing-index`), and contributes NO key FD.
- FD soundness: the unconditional key FD is contributed ONLY for the bijection-transport-
  proved (basis-key + NOT NULL) case — a regression here can make the optimizer drop rows.

## Suggested follow-up (reviewer's call)
- File a backlog ticket for the store **text-PK → NOCASE collation default** (memory↔store
  divergence), if confirmed unintended.
