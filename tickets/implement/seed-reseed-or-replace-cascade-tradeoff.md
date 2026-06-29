description: Re-seeding a table on every database reopen currently re-writes each seed row even when nothing changed, which can trigger cascade-deletes of child rows that hang off a seeded parent. Decide whether that is acceptable or whether re-seeding should leave unchanged rows alone.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts            # emitApplySchema seed branch — the INSERT OR REPLACE per seed row (L278-281)
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts          # case (d) pins "seed values re-asserted over user edits"
  - packages/quereus/test/logic/50-declarative-schema.sqllogic          # in-engine upsert-semantics section (EOF)
  - docs/schema.md                                                      # ### Seed Data — documents the upsert contract + the cascade consequence
difficulty: easy
---

## Decision needed (human sign-off)

The reopen-PK-collision fix (`declarative-seed-reopen-pk-collision`, now in
`complete/`) made `apply schema … with seed` idempotent by writing each seed row
with **`INSERT OR REPLACE`**. That fix is correct and shipped; this ticket is the
**deferred design call** the original ticket explicitly flagged ("default to
`OR REPLACE`; note the tradeoff and let the dev confirm").

`OR REPLACE` is **delete-then-insert** on a conflicting row. So when a host keeps
passing `withSeed: true` on every open (SiteCAD does), every reopen re-replaces
each seed parent row — and if that parent is referenced by `ON DELETE CASCADE`
children, the cascade **fires on every reopen, even when the replaced values are
byte-for-byte identical**. Seed tables are commonly referenced parents (the
SiteCAD case is `tablemetadata`), so this is a concrete consequence, not a
theoretical one. Secondary effects: each reopen also emits delete+insert change
events / FK-cascade work proportional to the seed-row count.

### The alternative

Swap `OR REPLACE` → **`INSERT OR IGNORE`** (keep the existing row, skip the seed
row). When seed values are unchanged the end state is identical, and **no cascade
fires** because no row is deleted. The cost: it drops the "seed values are
re-asserted over a user's edit on reopen" behavior — i.e. a user who edited a
seeded row keeps their edit instead of having the declared seed value restored.

This is a genuine product decision (re-assert seed truth vs. preserve user edits
and avoid cascade churn), which is why it needs the dev's call rather than a
reviewer's.

### Disposition options for the dev

- **Keep `OR REPLACE`** (status quo): accept cascade-on-reseed; possibly mitigate
  by documenting that hosts should pass `withSeed: false` on reopen (the SiteCAD
  defense-in-depth ticket already does this), or by making seed re-application a
  value-diff (only replace rows whose values actually changed — avoids the
  identical-row cascade but is more work than a one-line swap).
- **Switch to `OR IGNORE`**: one-line change at `schema-declarative.ts:280`, plus
  - update store spec case (d) (`seed value re-asserted over the edit` →
    `user edit preserved`),
  - update the sqllogic upsert-semantics section at the EOF of
    `50-declarative-schema.sqllogic` (the re-apply currently expects
    `id=2 → 'Other'`; under IGNORE it would stay `'Edited'`),
  - update `docs/schema.md` § Seed Data (drop the cascade caveat, restate the
    on-conflict = keep-existing contract).

No code is changed by filing this ticket; it captures the decision so it isn't
lost. If the dev picks `OR IGNORE` (or value-diff), promote to `fix/` (or
`plan/` for value-diff) with the chosen option.

** Human decision **: switch to `or ignore`
