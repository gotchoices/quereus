description: A logical UNIQUE over a proven-bijective authored-inverse column is realizable (proved via basis-key transport, else commit-time scan over the forward image) instead of redding lens.unrealizable-constraint.
files:
  - packages/quereus/src/schema/lens-prover.ts                 # classifyKeyConstraint gate lift
  - packages/quereus/src/planner/mutation/lens-enforcement.ts  # commit-time count-scan NEW-side forward-image fix
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic # scenarios 20-24
  - packages/quereus/test/lens-enforcement.spec.ts             # classification pins
  - docs/lens.md                                               # Constraint realizability + no-backing-index notes

# Logical UNIQUE over a proven-bijective authored inverse is realizable

## What shipped

`classifyKeyConstraint` (`lens-prover.ts`) previously red the hard
`lens.unrealizable-constraint` for any `unique` over a non-bare-reconstructible
column. A column proved a bijection by the round-trip enumeration
(`bijectiveAuthored`) transports uniqueness to/from its basis put target, so it is
now admitted to the key:

- **Gate lift:** a key column that is not bare-reconstructible no longer reds when it
  is authored-bijective (`bijectiveAuthored.has(name)`); it falls through like a
  bijective PK column. A non-bijective authored column, or a computed/opaque column,
  still reds `lens.unrealizable-constraint`. Then the existing arms classify it:
  - **`proved`** via `proveKeyByBijectionTransport` when the put-target basis
    column(s) form a declared basis key — zero runtime cost.
  - **`enforced-set-level` `commit-time` + `lens.no-backing-index`** otherwise.
- **Commit-time enforcement fix (beyond the original ticket scope):** the synthesized
  count check now puts the authored column's NEW-qualified forward `get` image (e.g.
  `_u.grp = NEW.code + 10`) on the NEW side, reusing `authoredForwardMap` +
  `transformExpr`, so a logical-domain value is compared to a logical-domain value.
  Bare/rename columns are unchanged (`NEW.<basis>`). Without this, the NEW side fell
  back to a `NEW.<logicalName>` the basis write row does not have, so the scan never
  fired and a duplicate inserted clean.

## Review findings

I read the implement diff (commit `68344ff3`) with fresh eyes before the handoff,
re-derived the gate-lift / transport / commit-time logic, and traced
`authoredForwardMap` / `transformExpr` / `logicalToBasisColumnMap` /
`proveKeyByBijectionTransport`. Beyond static reading I ran empirical probes for
every gap the implementer flagged.

### Checked and sound (no change)

- **Subquery-source corner (potential silent-broken-constraint).** I worried a
  bijective authored column over a `from (select …) sub` single-source body could be
  admitted to the key (`bijectiveAuthored`) yet be absent from `authoredForwardMap`
  (which requires an AST `table` source), hitting the bare-name fallback in
  `collectLensSetLevelConstraints` and synthesizing a `NEW.<logicalName>` the basis
  row lacks. **Verified unreachable:** the round-trip bijection proof does not
  characterize a subquery-source body, so the gate stays closed and the column reds
  `lens.unrealizable-constraint` (both the UNIQUE and any CHECK). `bijectiveAuthored`
  is in practice a subset of `authoredForwardMap`'s keys; the fallback is dead for the
  authored case. The implementer's "no write reaches here" comment holds.
- **Nullable bijective UNIQUE (implementer-flagged untested gap).** Verified it is
  **unreachable by construction**, so the missing test is not a real coverage hole: a
  bijective authored column requires its basis put-target NOT NULL
  (`proveForwardInjective`), so a nullable logical key inverts to a NULL basis value
  that the NOT NULL basis column rejects — a NULL key can never be written. (And a
  nullable basis target fails the bijection proof outright → `unrealizable`.) So the
  count scan's NULL-distinct path over an authored forward image is moot. Documented
  here rather than tested.
- **`proved`-arm FD soundness for the bijective UNIQUE.** Covered transitively by the
  existing `lens-fd-contribution.spec.ts` `proved`/bijective pins (same code path);
  the transport proof requires NOT NULL, so the unconditional `proved` FD is sound.
- **Docs.** `docs/lens.md` Constraint-realizability + no-backing-index rows were read
  and accurately reflect the shipped behavior (proved-by-transport vs commit-time over
  the forward image, plus the conflict-action interaction). No other doc needed
  updating — view-updateability.md's round-trip mechanics are unchanged.
- **Lint + full test suite** green (see Validation).

### Minor — fixed in this pass

- **Multi-column UNIQUE mixing a bare and an authored-bijective column (commit-time)**
  was flagged untested. I verified it works — the synthesized predicate is
  `_u.tag = NEW.tag and _u.grp = NEW.code + 10`, distinct tuples land, a duplicate
  ABORTs — and **added sqllogic scenario 24** to `55.5-lens-authored-inverse.sqllogic`
  pinning it (the per-column NEW-side synthesis is the core of the commit-time fix, so
  it deserves explicit coverage).

### Major — filed as a new ticket

- **`fix/lens-proved-transport-key-conflict-action-drop`.** A key that classifies
  `proved` by bijection transport **silently drops** a declared `on conflict
  replace`/`ignore`: the basis key's action governs the write-through, not the logical
  key's. Confirmed at runtime — `unique(grp) on conflict replace` deploys clean and a
  collision ABORTs (`UNIQUE constraint failed: t (code)`) instead of replacing. The
  row-time (`rejectRowTimeConflictAction`) and commit-time
  (`lens.unenforceable-conflict-action`, scenario 23) paths both reject this; the
  proved-transport arm returns before any such check. **Pre-existing** (reproduces on a
  plain bare-rename proved-transport UNIQUE, independent of this ticket's gate lift —
  so not a regression here); this ticket merely added one more shape that reaches the
  arm. Filed rather than fixed inline because the remedy needs the transport proof to
  surface *which* basis key it matched (to read its `defaultConflict`), which is a
  design change, and it spans the PK transport case too.

## Deviation accepted (carried from implement)

The proved/commit-time scenarios use **NOT NULL** logical UNIQUE columns. The
prereq's `proveKeyByBijectionTransport` deliberately defers a nullable key to
row-time/commit-time (`if (!col.notNull) return false;`), so NOT NULL is the sound,
minimal choice to exercise the genuine `proved` path. The implementer's open question
— whether to relax the transport guard for authored-bijective nullable columns — is
left to a possible future `plan/` ticket; it contradicts the prereq's reasoned
decision and was correctly not smuggled in.

## Validation performed

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json`).
- `yarn workspace @quereus/quereus run test` — **6239 passing, 9 pending, 0 failing**
  (with scenario 24 added).
- Targeted: 55.5 sqllogic (passing, incl. new scenario 24), all 475 lens specs
  passing.
- `yarn test:store` NOT run (the +10 integer shapes are deliberately
  backend-agnostic, mirroring scenarios 18/19); a store pass would confirm the
  commit-time count scan and basis-UNIQUE write-through behave identically there —
  left to a store run / CI, as in the implement handoff.
