description: |
  A cascade-driven child DML (cascade DELETE/UPDATE, SET NULL, SET DEFAULT) must be distinguishable from a
  direct user DML on the same child table, so a host vtab can suppress child-side FK re-validation only when
  the write is Quereus's own cascade re-entry. Add a per-write, nesting-safe _fkCascadeReentry flag on
  Database (mirroring _fkRestrictSuppressed) and wrap the cascade child-DML sites in foreign-key-actions.ts.
files:
  - packages/quereus/src/core/database.ts                 # add _fkCascadeReentry field + _set/_is accessors; mirror _fkRestrictSuppressed (~:1959-1981)
  - packages/quereus/src/runtime/foreign-key-actions.ts   # wrap the 8 cascade child-DML re-entry sites in withFkCascadeReentry(...)
difficulty: medium
----

## Problem

When a cascade action re-enters the DML executor to modify a child row (cascade DELETE, cascade UPDATE,
SET NULL, SET DEFAULT — physical + lens variants), a host vtab module cannot currently tell that write apart
from a direct user `UPDATE child SET parent_id = …`. Quereus already owns the analogous distinction for the
RESTRICT-suppression case via `_fkRestrictSuppressed` (`core/database.ts:~1959-1981`) but has no counterpart
for cascade re-entry (`grep FkCascadeReentry packages/quereus/src` → 0 hits).

The cascade walker lives in Quereus (`runtime/foreign-key-actions.ts`); only Quereus knows an UPDATE is its
own cascade re-entry, so the flag must be set and read here — a host cannot synthesize it.

## Downstream consumer (why this matters)

The lamina host (sibling `../lamina`, `packages/lamina-quereus/src/table.ts:1009`) already has its half
committed and reads the flag through a view-cast:

```ts
const cascadeReentry = (this.db as unknown as QuereusFkCascadeReentryReader)._isFkCascadeReentry();
```

Because Quereus `main` never grew `_isFkCascadeReentry`, that call currently throws
`TypeError: this.db._isFkCascadeReentry is not a function` on every UPDATE that reaches the lamina vtab —
two lamina golden-vector fixtures (`general-body-mv-maintenance`, `overflow-leaf-inplace-update`, the two
whose corpus scripts issue an UPDATE) crash before any byte compare. The lamina side was landed by its
`r2-fk-cascade-action-suppresses-child-checks` ticket, which specified this Quereus counterpart; it was live
in the portal working tree when the fixtures were generated but never committed to Quereus. Re-landing it
here clears both.

Nothing *inside* Quereus reads the flag, so this change is behavior-neutral for Quereus's own suite — it only
exposes the signal the host consumes.

## Expected behavior

- `Database` exposes a private `_fkCascadeReentry = false`, a public `_setFkCascadeReentry(value): boolean`
  that returns the **prior** value (for nesting-safe restore), and a public `_isFkCascadeReentry(): boolean`.
- Every cascade child-DML site sets the flag before re-entering the executor and restores the prior value in a
  `finally`, via a `withFkCascadeReentry(db, () => …)` helper — so nested cascades restore correctly and a
  thrown cascade cannot leave the flag stuck on.
- A direct (non-cascade) user DML sees the flag `false`.

## Edge cases & interactions

- **Nesting** — cascade A triggers cascade B on another child: inner restore must return to `true` (A still
  active), outer restore to `false`. Use save-prior/restore, not set-false.
- **Throwing cascade** — child DML throws mid-cascade: `finally` must still restore the prior value; the flag
  must never latch on across statements.
- **All 8 sites** — cascade DELETE, cascade UPDATE, SET NULL, SET DEFAULT, each in physical + lens form. R-2
  review noted "grep confirms zero bare sites" once wrapped — verify no cascade child-DML re-entry bypasses
  the wrapper.
- **Interaction with `_fkRestrictSuppressed`** — the two flags are independent; setting one must not touch the
  other. A cascade path may legitimately have both semantics in play.

## Design constraints

- **Mirror** `_fkRestrictSuppressed` exactly: field + `_set`/`_is` accessors, set/restore in `finally`. Do NOT
  invent a new mechanism and do NOT make it a config-time or connection-level flag — it is a per-write,
  nesting-safe, transient flag.
- Keep the host-facing contract to the two members (`_setFkCascadeReentry` / `_isFkCascadeReentry`); do not
  widen it.

## TODO

- `core/database.ts`: add `private _fkCascadeReentry = false;`, `_setFkCascadeReentry(value): boolean` (returns
  prior), `_isFkCascadeReentry(): boolean` — modeled on `_fkRestrictSuppressed`.
- `runtime/foreign-key-actions.ts`: add a `withFkCascadeReentry(db, fn)` helper (set flag → run → restore prior
  in `finally`) and wrap all 8 cascade child-DML re-entry sites in it.
- Verify via grep that zero cascade child-DML sites re-enter the executor outside the wrapper.
- Add a test: a cascade DELETE/UPDATE observes `_isFkCascadeReentry() === true` inside the child write and
  `false` after; a direct user UPDATE observes `false` throughout; a nested cascade restores to `true` then
  `false`.

## Note for the downstream host (not this repo's work)

After this lands, the two lamina fixtures will reach the byte-compare and are expected to show a byte-hash
mismatch — lamina's committed bytes for them are pre-edition-13 (they crashed the generator before the
edition-13 refcount-coalescer regeneration). That drift is lamina-side (id-roster / catalog version stamp) and
is the lamina owner's re-bless, not a Quereus concern.
