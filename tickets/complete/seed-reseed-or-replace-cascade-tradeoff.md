description: Switch seed re-application from OR REPLACE to OR IGNORE so reopening a database with seed data does not fire ON DELETE CASCADE on unchanged rows or overwrite user edits.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts     # seed insert uses INSERT OR IGNORE
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts   # case (d) expects user-edit preserved
  - packages/quereus/test/logic/50-declarative-schema.sqllogic   # idempotency + NEW cascade-avoidance section
  - docs/schema.md                                               # § Seed Data documents the OR IGNORE contract
---

## What was done (implement stage)

Swapped `INSERT OR REPLACE` → `INSERT OR IGNORE` for seed row application in
`emitApplySchema` (`schema-declarative.ts:268`). On a reopen reseed, an existing
row (matching PK) is left untouched: user edits survive, and no `ON DELETE
CASCADE` fires for an unchanged seed parent (OR REPLACE was delete-then-insert,
which fired cascades even on byte-identical replacement). A freshly-created
table has no existing rows, so OR IGNORE seeds all rows on first apply.

Supporting changes: `seed-reopen-idempotent.spec.ts` case (d) now expects the
user edit on `id=2` to survive; `50-declarative-schema.sqllogic` idem section now
expects `id=2 → 'Edited'`; `docs/schema.md` § Seed Data rewritten for the
OR IGNORE contract; the rationale comment block was trimmed to the final form.

## Review findings

### Scope reviewed
Read the full implement diff (commit `64ba666b`) before the handoff summary.
Scrutinized: the one-line semantic change and its conflict-resolution path,
the rewritten comment/doc rationale, the three test edits, and the call-site
sweep for any missed seed `OR REPLACE` references. Checked SPP/DRY/error
handling/type safety, and — most importantly — the *untested headline property*
(cascade avoidance) and the *masking side effect* of `OR IGNORE`.

### What was checked and found

- **Call-site completeness — OK.** Grepped every `OR REPLACE`/`OR IGNORE`/seed
  reference across `.ts`/`.md`/`.sqllogic`. The only seed-related occurrences are
  in the four touched files; all other hits are unrelated upsert/FK tests. No
  missed seed call site.

- **Docs accuracy — OK.** `docs/schema.md` § Seed Data is accurate and now
  matches the new test. `docs/todo.md:189` ("Idempotent seeds with PK/UNIQUE
  upsert logic") is a roadmap checkbox using the now-imprecise word "upsert";
  left as-is (out of scope, a wishlist file, not a behavioral doc).

- **Implementer "known gap": stale OR REPLACE comment block — already resolved.**
  The handoff warned lines 234–264 still described the OR REPLACE rationale. The
  committed diff already trimmed them to the concise OR IGNORE rationale +
  historical note (`schema-declarative.ts:234–249`). No action needed.

- **MAJOR coverage gap: cascade-avoidance was unverified — FIXED INLINE.** The
  central value proposition ("no cascade fires on reopen") had **no test**. I
  added a `decl_seed_cascade` section to `50-declarative-schema.sqllogic`: a
  seeded `parent`, a `child` with `references parent(id) on delete cascade`, a
  user-inserted child, then a reseed — asserting the child survives. Verified it
  is **not vacuous**: temporarily reverting the source to `OR REPLACE` (rebuild +
  run) makes the file fail (the reseed deletes-then-inserts the parent, firing
  the cascade; also flips the idem `id=2` assertion). The displaced-parent
  cascade-on-REPLACE is documented at `isolated-table.ts:711`. Restored OR IGNORE
  and reconfirmed green. This was fixed inline (minor → in-pass) rather than
  filed, since it pins existing behavior with no code change.

- **MAJOR behavioral side effect: OR IGNORE masks malformed seed rows — FILED.**
  Quereus's `OR IGNORE` follows SQLite semantics and skips a row on **any**
  constraint failure, not just PK/UNIQUE (`constraint-check.ts:376` returns
  `{skip:true}` for an IGNORE CHECK failure; NOT NULL and child-FK likewise). So
  a seed row violating a `CHECK`/`NOT NULL`/FK is now **silently dropped on first
  apply**, whereas `OR REPLACE` still aborted those (REPLACE only relaxes
  UNIQUE/PK + NOT-NULL-with-default). This trades away seed-data error
  visibility. Not blocking (seed data is trusted, hand-authored), but a real
  footgun. Filed `tickets/backlog/seed-or-ignore-masks-malformed-rows.md`, which
  notes a more surgical `on conflict (<pk>) do nothing` alternative that would
  keep cascade-avoidance while restoring constraint-error visibility.

- **Type safety / error handling / resource cleanup — OK.** No type changes; the
  seed try/catch wraps each table's exec and rethrows a `QuereusError` with SQL +
  cause. Multi-row `seedSql` joined by `;` — each row is an independent
  OR IGNORE, so a skip never aborts the batch. No new resources/handles.

### Categories with no findings
- **DRY / modularity / scalability:** no findings — a single-token change to one
  emitted statement template; nothing duplicated or restructured.
- **Performance:** no findings — OR IGNORE is a point-key probe (no scan), strictly
  no worse than the prior OR REPLACE probe.

### Disposition
- Minor (fixed in this pass): added the cascade-avoidance regression test.
- Major (filed): `seed-or-ignore-masks-malformed-rows` (backlog) for the
  constraint-masking visibility regression.

## Validation
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test typecheck).
- `yarn build` — clean.
- `yarn workspace @quereus/quereus run test` — 6410 passing, 9 pending, 0 failing
  (includes the new `decl_seed_cascade` assertions).
- `yarn workspace @quereus/store run test` — 675 passing, 0 failing.
- Adversarial check: OR REPLACE flip → file fails; OR IGNORE restored → green.
