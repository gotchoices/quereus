description: A logical UNIQUE/PK that classifies `proved` by bijection transport silently drops a declared `on conflict replace`/`ignore` — the basis key's action governs the write-through, not the logical key's. The row-time and commit-time paths reject this (lens.unenforceable-conflict-action); the proved-transport path does not.
files:
  - packages/quereus/src/schema/lens-prover.ts          # classifyKeyConstraint proved-transport arm; rejectRowTimeConflictAction (the existing analog)
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic # scenario 23 is the commit-time analog that DOES reject
  - packages/quereus/test/lens-enforcement.spec.ts      # classification pins

# Proved-by-transport key silently drops a declared conflict action

## Symptom

A logical key (`unique` or `primary key`) that classifies `proved` via
`proveKeyByBijectionTransport` (every key column bare-reconstructible or
authored-bijective, mapping onto a declared **basis** key) deploys clean even when
it declares `on conflict replace` / `on conflict ignore`. At write time the
declared action is **silently dropped**: a duplicate resolves via the *basis* key's
own `defaultConflict` (e.g. plain ABORT), not the logical key's declared action.

Repro (bare-reconstructible — shows it is **pre-existing**, not specific to the
authored-bijective gate lift):

```sql
declare schema y { table t (id integer primary key, code integer not null unique check (code in (1,2,3))) }
apply schema y;
declare logical schema x {
  table t (id integer primary key, grp integer not null check (grp in (1,2,3)),
           unique (grp) on conflict replace)
}
declare lens for x over y { view t as select id, code as grp from y.t }
apply schema x;                       -- deploys CLEAN (no advisory, no error)
insert into x.t (id, grp) values (1, 1);
insert into x.t (id, grp) values (2, 1);
-- EXPECTED (declared): replace → id 2 row, code 1
-- ACTUAL: `UNIQUE constraint failed: t (code)` (ABORT) — the declared `replace` is dropped
```

The authored-bijective shape (this is the ticket that surfaced it) reaches the same
arm and exhibits the same drop:

```sql
declare logical schema x {
  table t (id integer primary key, grp integer not null check (grp in (11,12,13)),
           unique (grp) on conflict replace)
}
declare lens for x over y { view t as select id, code + 10 as grp with inverse (code = new.grp - 10) from y.t }
apply schema x;   -- proved by transport (basis UNIQUE over `code`); deploys clean, action dropped
```

## Why it is a defect

The `proved`-by-transport key relies on the **basis** key for write-time
enforcement (the bijection is injective, so distinct logical keys map to distinct
basis keys — the basis key forbids the collision). But the write-through honors the
**basis** key's conflict action, never the logical key's declared one — exactly the
hazard the two other lens key paths already guard:

- **row-time** (`rejectRowTimeConflictAction`, `lens-prover.ts:1589`): rejects a
  logical REPLACE/IGNORE that differs from the backing basis UC's `defaultConflict`,
  because "the row-time write path honors the basis UC's action, not the logical
  key's, so the declared action would be silently dropped."
- **commit-time** (the block at `lens-prover.ts:1543`): rejects REPLACE/IGNORE with
  `lens.unenforceable-conflict-action` because the count scan can only ABORT
  (sqllogic scenario 23 in `55.5-lens-authored-inverse.sqllogic` pins this).

The `proved`-transport arm (`classifyKeyConstraint`, the
`proveKeyByBijectionTransport(...)` → `return { kind: 'proved' }` branch around
`lens-prover.ts:1515`) returns **before** any conflict-action check. So a key whose
uniqueness is enforced by a basis key with a *different* action silently drops the
declared action — the same class of bug `rejectRowTimeConflictAction` exists to
prevent, just on the path that proves rather than enforces.

A *body*-proved key (e.g. `unique(x,y)` over `group by x,y`) is genuinely
intrinsically unique and its `on conflict` is vacuous — dropping it there is fine.
The defect is specific to the **transport** sub-case, where a real basis key (with
its own action) does the enforcing.

## Expected behavior

Mirror `rejectRowTimeConflictAction` for the proved-by-transport case: when a
transport-proved key declares an effective REPLACE/IGNORE that differs from the
**declared basis key's** `defaultConflict`, reject at deploy with
`lens.unenforceable-conflict-action` (or whichever diagnostic the team prefers),
naming the basis key whose action actually governs. When the basis key already
carries the matching action, accept (it is honored for free — the documented
remediation, same as the row-time path).

The fix needs `proveKeyByBijectionTransport` (or a sibling) to surface *which* basis
key it matched, so the rejecter can read that key's `defaultConflict` — the
row-time path already has this via `BasisCovering.uc.defaultConflict`; the transport
proof currently returns only a boolean (`columnsFormDeclaredKey`).

## Scope notes

- Pre-existing (reproduces on a plain bare-rename proved-transport UNIQUE), so it is
  **not** a regression from `authored-bijection-unique-realizable` — that ticket only
  added one more shape (authored-bijective) that reaches the same arm. Filed during
  its review.
- Applies to both `unique` and `primary key` (a PK can declare `on conflict` too);
  confirm the PK transport case (`authored-bijection-pk-reconstructible`) behaves the
  same and cover it.
- Body-proved (non-transport) keys must remain unaffected — only gate on the
  transport sub-case.
