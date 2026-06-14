description: A logical UNIQUE over a proven-bijective authored-inverse column becomes realizable instead of reding lens.unrealizable-constraint — the bijection transports uniqueness of the basis key to the logical image. Builds on the bijection-transport machinery the PK ticket lands.
prereq: authored-bijection-pk-reconstructible
difficulty: medium
files:
  - packages/quereus/src/schema/lens-prover.ts            # classifyKeyConstraint reachability gate (the !isPrimaryKey unrealizable block), bijection-transport proof reuse
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic # new logical-UNIQUE-over-authored-bijective scenarios
  - packages/quereus/test/lens-enforcement.spec.ts        # classification pins (proved vs commit-time)
  - docs/lens.md                                          # Constraint realizability / no-backing-index notes

# Logical UNIQUE over a proven-bijective authored inverse

## Problem

`classifyKeyConstraint` (`lens-prover.ts:1374`) treats a column with no
bare-column write path as unreachable. For a **unique** (`!isPrimaryKey`) that
branch reds the hard `lens.unrealizable-constraint`
(`lens-prover.ts:1394-1402`): a logical `unique` over an authored
(`with inverse`) column cannot today be proved or enforced, so it blocks the
deploy — even when the prover has proved the forward/inverse pair a **bijection**.
Semantically the bijection transports uniqueness: if the basis put-target column
is unique, its bijective image is unique; absent a basis key, the logical UNIQUE
is still enforceable by the same commit-time scan / `lens.no-backing-index`
machinery any non-proved logical key uses, over the forward image.

The non-injective (lossy) case must keep reding `lens.unrealizable-constraint`:
a collapsed image is not a key, and there is no sound enforcement.

## Design

The prereq ticket (`authored-bijection-pk-reconstructible`) already lands:

- the `bijectiveAuthored` set computed up front and threaded into
  `classifyKeyConstraint` via `classifyObligations`/`classifyConstraint`;
- the **bijection-transport `proved`** branch in `classifyKeyConstraint`
  (every key column bare-reconstructible or authored-bijective, mapped to its
  put-target basis column, those columns exactly a declared basis key →
  `proved`);
- `columnsFormDeclaredKey(table, indices)` in `schema/table.ts`.

This ticket only **lifts the UNIQUE-specific block** so a bijective authored
UNIQUE reaches that shared machinery:

> In the reachability loop, a key column that is not bare-reconstructible no
> longer reds `lens.unrealizable-constraint` when it is authored-**bijective**
> (`bijectiveAuthored.has(name)`). It is added to the key's basis-column mapping
> just like a bijective PK column. A non-bijective authored column (or a
> computed/opaque column) still reds `lens.unrealizable-constraint` — uniqueness
> over a value with no proven write path is neither provable nor enforceable.

Then classification proceeds through the existing arms:
- **`proved`** — the put-target basis columns form a declared basis key
  (bijection-transport, the prereq's branch). Zero runtime cost.
- **`enforced-set-level commit-time` + `lens.no-backing-index`** — bijective but
  the put-target is not a basis key. The O(n) commit-time count scan runs over
  the **logical forward image** (the logical relation the scan already reads), so
  the existing `synthesizeUniqueCountExpr` path enforces it with no new code. The
  advisory recommends a basis covering structure exactly as for a bare logical key.

(Authored keys do not reach the `row-time` covering path: `findBasisCovering` maps
columns via the bare-column `mappedBasisColumn`, which returns `undefined` for an
authored projection — so the basis-UNIQUE + covering-MV row-time branch is
unreachable for them, and a basis UNIQUE instead surfaces as `proved` via
transport. This is intentional and keeps the FD/plan-time path untouched.)

## Edge cases & interactions

- **Non-injective authored UNIQUE still reds** `lens.unrealizable-constraint`
  (the motivating safety case) — the column is not in `bijectiveAuthored`.
- **Degrade-to-safe body** (out-of-fragment join / no lineage / negation residual):
  empty `bijectiveAuthored`, so a UNIQUE over an authored column on such a body
  still reds `lens.unrealizable-constraint` (matches scenario 12/15's posture that
  an authored column on a join body is conservatively rejected for constraints).
- **Conflict-action rejection**: a bijective authored UNIQUE classified
  `commit-time` with `on conflict replace/ignore` must still red
  `lens.unenforceable-conflict-action` (the commit-time scan can only ABORT) — the
  existing `effectiveKeyDefaultConflict` block at `lens-prover.ts:1438` fires
  because a UNIQUE carries its own `defaultConflict`. Verify it is reached after
  the gate is lifted.
- **`proved` UNIQUE FD soundness**: a bijective UNIQUE proved via a basis key
  contributes an **unconditional** key FD (`assertedFdForObligation` `proved` arm).
  Sound because the bijection's enumerable CHECK domain excludes NULL and
  `proveForwardInjective` requires the basis put-target NOT NULL — so the logical
  column is non-null over its domain and the UNIQUE is unconditional, not
  NULL-skipping. Pin this; a guarded-FD downgrade is unnecessary but not wrong.
- **Commit-time UNIQUE contributes no FD** (the `enforced-set-level commit-time`
  arm is excluded from `assertedFdForObligation`) — unchanged, sound.
- **Mixed table** (a bijective authored UNIQUE alongside the real PK): the table
  is writable via its PK; the UNIQUE classifies independently. Exercise both a
  basis-keyed (proved) and non-basis-keyed (commit-time) put-target.
- **Read-only table**: when the table is read-only for another reason, the UNIQUE's
  `lens.no-backing-index` is suppressed (`!readOnly` gate at `lens-prover.ts:1422`)
  — unchanged.

## Key tests (expected outputs)

New scenarios in `55.5-lens-authored-inverse.sqllogic`:

- **Proved via basis UNIQUE**: basis `( id integer primary key, code text not null
  unique check (code in ('a','b','c')) )`; logical
  `( id integer primary key, grp text null check (grp in ('A','B','C')), unique (grp) )`;
  lens `select id, upper(code) as grp with inverse (code = lower(new.grp)) from …`.
  Deploys clean (no `lens.unrealizable-constraint`, no `lens.no-backing-index`).
  A duplicate write is forbidden by the basis UNIQUE through the write-through
  (insert a second row whose `grp` maps to an existing `code` → basis UNIQUE
  ABORTs). `select count(*) from quereus_lens_advisories('…')` → `[{"n": 0}]`.
- **Commit-time fallback**: same logical UNIQUE but the basis put-target column has
  a CHECK + NOT NULL yet **no** basis UNIQUE/PK. Deploys with `lens.no-backing-index`
  (not `lens.unrealizable-constraint`); a logical-key duplicate ABORTs via the
  commit-time count scan. `select code, status from quereus_lens_advisories('…')
  where code = 'lens.no-backing-index'` → one active row.
- **Non-injective UNIQUE rejected**: scenario-1-shaped lossy `substr` forward with
  a logical `unique (grp)` → `apply schema …` → `-- error: lens.unrealizable-constraint`.
- **Conflict action**: a bijective authored UNIQUE that is commit-time with
  `on conflict replace` → `-- error: lens.unenforceable-conflict-action`.

`lens-enforcement.spec.ts`: pin the proved vs commit-time classification for the
two backing shapes (mirrors the existing `setLevelModes` / `proved` pins).

## TODO

- Lift the `!isPrimaryKey` `lens.unrealizable-constraint` block in
  `classifyKeyConstraint` to admit authored-**bijective** columns (add them to the
  basis-column mapping); keep reding for non-bijective / computed columns.
- Confirm a bijective authored UNIQUE flows to `proved` (basis key over put-target)
  or `commit-time` + `lens.no-backing-index` (no basis key), and that
  `lens.unenforceable-conflict-action` still fires for a commit-time UNIQUE with
  `on conflict replace/ignore`.
- Add the proved / commit-time / non-injective-rejected / conflict-action scenarios
  to `55.5-lens-authored-inverse.sqllogic`; add classification pins to
  `lens-enforcement.spec.ts`.
- Update `docs/lens.md` (Constraint realizability + `lens.no-backing-index` notes)
  to state that a logical UNIQUE over a proven-bijective authored inverse is
  realizable (proved via basis key, else commit-time scan over the forward image).
- `yarn lint` + `yarn test`; stream output with `tee`.
