description: Review the implementation that makes a logical UNIQUE over a proven-bijective authored-inverse column realizable (proved via basis-key transport, else commit-time scan over the forward image) instead of reding lens.unrealizable-constraint.
files:
  - packages/quereus/src/schema/lens-prover.ts                 # classifyKeyConstraint gate lift + doc updates
  - packages/quereus/src/planner/mutation/lens-enforcement.ts  # commit-time count-scan NEW-side forward-image fix (NOT in original ticket scope)
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic # scenarios 20-23
  - packages/quereus/test/lens-enforcement.spec.ts             # classification pins (proved vs commit-time)
  - docs/lens.md                                               # Constraint realizability + no-backing-index notes

# Review: logical UNIQUE over a proven-bijective authored inverse is realizable

## What landed

`classifyKeyConstraint` (`lens-prover.ts`) previously red the hard
`lens.unrealizable-constraint` for any `unique` over a non-bare-reconstructible
column. A column proved a **bijection** by the round-trip enumeration
(`bijectiveAuthored`) transports uniqueness to/from its basis put target, so it is
now admitted to the key:

- **Gate lift** (the ticket's stated change): in the reachability loop a key column
  that is not bare-reconstructible no longer reds when it is authored-**bijective**
  (`bijectiveAuthored.has(name)`); it falls through exactly like a bijective PK
  column. A non-bijective authored column, or a computed/opaque column, still reds
  `lens.unrealizable-constraint`. Then the existing arms classify it:
  - **`proved`** via `proveKeyByBijectionTransport` when the put-target basis
    column(s) form a declared basis key — zero runtime cost.
  - **`enforced-set-level` `commit-time` + `lens.no-backing-index`** otherwise.

- **Commit-time enforcement fix (BEYOND the original ticket scope — please scrutinize).**
  The ticket asserted the commit-time path needed *no new code* ("`synthesizeUniqueCountExpr`
  enforces it with no new code"). **That was wrong.** The synthesized count check is
  `(select count(*) from <logicalView> _u where _u.<lk> = NEW.<bk>) <= 1`. For an
  authored column the logical→basis map (`logicalToBasisColumnMap`, bare-column only)
  returns nothing, so the NEW side fell back to `NEW.<logicalName>` — a column the
  basis write row does not have — and the scan compared mismatched values and never
  fired (a duplicate inserted clean). Fixed by making the count synthesis put the
  authored column's **NEW-qualified forward `get` image** on the NEW side (e.g.
  `_u.grp = NEW.code + 10`), reusing `authoredForwardMap` + `transformExpr` exactly
  as the row-local CHECK rewrite already does for authored columns. Bare/rename
  columns are unchanged (still `NEW.<basis>`).

## Deviation from the ticket's literal scenarios — verify the call

The ticket's "Proved via basis UNIQUE" example declares the logical UNIQUE column
`grp text null`. **Under the landed prereq that classifies commit-time, not
`proved`**: `proveKeyByBijectionTransport` has a deliberate blanket
`if (!col.notNull) return false;` (its docstring: *"A nullable key column therefore
defers to row-time/commit-time rather than taking the transport shortcut"*). The
ticket's edge-case note assumed a nullable bijective UNIQUE reaches `proved`
(arguing the bijection domain excludes NULL); the prereq's author decided otherwise
and that decision is what shipped. To exercise the genuine `proved` path I used
**NOT NULL** logical UNIQUE columns in the proved/commit-time scenarios. This is the
sound, minimal choice consistent with the landed code; it does **not** modify the
prereq's transport guard.

- **Open question for the reviewer / a possible follow-up ticket:** should the
  transport guard be relaxed for authored-bijective columns specifically? It would
  be sound — `proveForwardInjective` requires the basis put-target NOT NULL
  (`lens-prover.ts:1165`) and a never-NULL forward image, so a NULL logical value
  can never round-trip even when the column is declared nullable. But it contradicts
  the prereq's explicit, reasoned decision, so I left it alone. If desired, file a
  `plan/` ticket rather than smuggling it in here.

## Behavior to validate (the scenarios I added)

`test/logic/55.5-lens-authored-inverse.sqllogic` (integer +10 affine bijection,
backend-agnostic like the prereq's scenarios 18/19):

- **20 — proved via basis UNIQUE.** Basis `code integer not null unique check`,
  logical `grp integer not null unique`, lens `code + 10 as grp with inverse (code =
  new.grp - 10)`. Clean deploy (`count(*) from quereus_lens_advisories = 0`). A
  duplicate (distinct id, colliding grp→code) ABORTs via the **basis** UNIQUE through
  the write-through — the proved logical key adds no runtime scan.
- **21 — commit-time fallback.** Same shape but basis `code` has CHECK+NOT NULL and
  **no** basis UNIQUE/PK → one active `lens.no-backing-index` (sited at `unique`), no
  `unrealizable-constraint`, no `getput-lossy`. A logical-key duplicate ABORTs via the
  commit-time count scan (INSERT *and* a key-changing UPDATE both covered).
- **22 — non-injective rejected.** Lossy `substr(code,1,1)` forward with `unique(grp)`
  → `apply schema` reds `lens.unrealizable-constraint` (the motivating safety case).
- **23 — conflict action.** A commit-time bijective authored UNIQUE with `on conflict
  replace` reds `lens.unenforceable-conflict-action` (the scan can only ABORT).

`test/lens-enforcement.spec.ts` (new describe `logical UNIQUE over a bijective
authored inverse`): pins `proved` vs `commit-time` classification for the two backing
shapes, and asserts the commit-time count-scan actually ABORTs a duplicate.

## Validation performed

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json`).
- `yarn workspace @quereus/quereus run test` — **6239 passing, 9 pending, 0 failing.**
- Targeted: 55.5 sqllogic, full `lens-enforcement.spec.ts` (143), `lens-prover.spec.ts`
  + `lens-fd-contribution.spec.ts` + `lens-ack.spec.ts` (81) — all green.

## Known gaps / where to push (treat the tests as a floor)

- **`yarn test:store` was NOT run.** The integer +10 shapes are deliberately
  backend-agnostic (mirroring scenarios 18/19's rationale about TEXT-PK NOCASE under
  the store), but a store run would confirm the commit-time count scan and the basis
  UNIQUE write-through behave identically there. Worth a store pass.
- **Nullable bijective UNIQUE is untested.** Per the deviation above it classifies
  commit-time; I added no scenario pinning that (NULL-distinct behaviour of the count
  scan over an authored forward image is therefore unverified). A reviewer wanting
  coverage should add a `grp ... null` commit-time case and confirm multiple
  NULL-key rows are allowed and a non-NULL duplicate ABORTs.
- **Multi-column UNIQUE mixing a bare and an authored-bijective column** (commit-time)
  is untested. The per-column NEW-side synthesis handles it (bare → `NEW.<basis>`,
  authored → forward image), but no test exercises the mix.
- **Capture-safety of the forward image inside the count subquery.** The forward refs
  are blanket NEW-qualified and `authoredForwardMap` admits only subquery-free
  single-source forwards, and the count subquery's only FROM alias is `_u` (distinct
  from `NEW`), so there is no collision corner like the CHECK path's subquery case —
  but a reviewer should sanity-check the rewrite on a forward referencing multiple
  basis columns.
- The `proved`-arm unconditional FD soundness for a bijective UNIQUE is covered
  transitively by the existing `lens-fd-contribution.spec.ts` `proved`/bijective-PK
  pins (same code path); no new FD pin was added for the UNIQUE case specifically.
