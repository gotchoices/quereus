description: A typo in declarative seed data that duplicates a value on a secondary uniqueness rule (one that is not the table's primary key) used to vanish silently; it now aborts the apply with a clear "UNIQUE constraint failed" error, like every other malformed-seed case.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # matchUpsertClause (~line 233) — isPkMatch branch removed; consumer ~line 633
  - packages/quereus/src/vtab/memory/layer/manager.ts          # secondary-UNIQUE result populates existingRow (~line 1164)
  - packages/quereus/src/util/comparison.ts                    # sqlValuesEqual (raw JS equality, affinity/collation-unaware) ~line 485
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # decl_seed_dup_unique block (end of file)
  - packages/quereus/test/logic/47.1-upsert-conflict-targets.sqllogic # section 8 (target-scoped suppression)
  - docs/schema.md                                             # Seed Data § — caveat removed, preceding ¶ tightened
difficulty: medium
---

## What shipped

`matchUpsertClause` (`runtime/emit/dml-executor.ts`) decides whether a vtab-reported
`UNIQUE` violation is covered by a `DO NOTHING` / `DO UPDATE` clause. The implementer
removed the `isPkMatch` short-circuit that returned a PK-targeted clause **unconditionally**
on *any* unique conflict — the branch that silently swallowed a secondary-`UNIQUE`
collision in declarative seed data. Matching now flows entirely through the
value-comparison branch (`conflictMatch`): a clause covers the conflict only when the
proposed row equals the conflicting existing row at every one of the clause's
conflict-target columns.

- **Genuine PK conflict** (idempotent reseed): existing row shares the proposed PK →
  values equal at PK indices → match → `DO NOTHING` skips. Idempotency preserved.
- **Secondary-UNIQUE conflict** (the bug): conflicting existing row has a *different* PK →
  values unequal at PK indices → no match → `processInsertRow` throws `ConstraintError` →
  apply aborts with `UNIQUE constraint failed: …`. Fixed.

The constraint-identity-tracking alternative was deliberately rejected because strict
set-equality of declared target columns would regress the documented, tested
**partial-conflict-target** acceptance (`47.1` lines 24-29). The value-comparison branch
keeps partial targets working.

## Review findings

Reviewed the full implement diff fresh, the matcher and its sole consumer, the memory
module's secondary-UNIQUE path, the comparison util, both new test blocks, and the
`docs/schema.md` edit. Lint clean; full suite **6421 passing, 9 pending, 0 failing**;
targeted `upsert|50-declarative-schema` subset 35 passing.

**Correctness — one new corner found, dispositioned as a tripwire.**
The matcher compares with `sqlValuesEqual` (raw JS `===`), but the **proposed row reaches
the matcher pre-affinity-coercion** (the insert pipeline defers type conversion to the
vtab's storage layer — `runtime/emit/insert.ts`), while `existingRow` is the
already-coerced stored row. So beyond the collation gap the implementer already documented,
an **affinity/representation gap** also defeats the match. Empirically confirmed:
`insert into t values ('1','…') on conflict (id) do nothing` against an INTEGER PK holding
`1` now **aborts** (`UNIQUE constraint failed: t PK`) where the old `isPkMatch` branch would
have skipped. This is the same root cause and the same fix as the collation tripwire
(compare the way the constraint enforces: apply the column's affinity and use its
enforcement collation), so rather than file a separate item I **broadened the existing
`NOTE:` tripwire** at the `conflictMatch` site to name affinity alongside collation under
"representation-sensitive keys" (the only code change this review made). It is genuinely
conditional, not a latent defect on a currently-reachable seed path: well-formed seeds
re-present byte-identical literals, so seed idempotency is unaffected (proven by the
`decl_seed_idem` / `_cascade` / `_composite` pins), and the secondary-UNIQUE-targeted
branch already behaved this way before this ticket — the change merely makes PK-targeted
clauses consistent with it.

**Other aspects checked, nothing found:**
- *DO UPDATE path* — a genuine PK conflict always has equal PK values → matches → updates
  correctly; non-PK-targeted DO UPDATE (standard secondary-UNIQUE upsert) unchanged.
- *No-target clause* (`ON CONFLICT DO NOTHING` without a target, incl. the `primary key ()`
  singleton) — still returns unconditionally; behavior identical to before.
- *Index alignment* — `existingRow`/`proposedRow` are both full schema-width rows indexed by
  schema column index; `conflictTargetIndices` align with both. No off-by-one.
- *Empty-target array edge* — does not occur (untargeted clauses carry `undefined`, not
  `[]`); if it did, `[].every` matches, same as the old `isPkMatch` for an empty PK.
- *Docs* — `docs/schema.md` § Seed Data caveat correctly removed and the preceding ¶
  tightened to state suppression requires a PK value-match; wording is accurate.

**Tripwire index (per tripwire rules — analysis lives at the code site, not here):**
- Multi-constraint coincidence → `NOTE:` at `matchUpsertClause`'s `conflictMatch` site.
  Untested; conditional (needs the vtab to report all violations to fix). Unchanged from
  handoff.
- Representation-sensitive keys (affinity **and** collation) → same `NOTE:`, broadened this
  pass. Untested; conditional on type-mismatched `ON CONFLICT` writes.

**Major findings:** none — no new fix/plan/backlog tickets filed.
**Blocked decisions:** none.

## How it was validated

`yarn workspace @quereus/quereus lint` (clean) and `yarn workspace @quereus/quereus test`
(6421 passing, 9 pending, 0 failing). Regression coverage that landed with the
implementation:

- **`50-declarative-schema.sqllogic`** `decl_seed_dup_unique`: two seed rows share a
  `unique (email)` value with distinct PKs → `apply schema … with seed` fails with
  `UNIQUE constraint failed`. Headline acceptance case.
- **`47.1-upsert-conflict-targets.sqllogic`** section 8 (`scoped` table): direct UPSERT
  proof that `ON CONFLICT (<target>) DO NOTHING` suppresses only conflicts on `<target>`
  (both directions abort; genuine PK re-presentation still skips — idempotency control).

## Acceptance checklist (all met)

- [x] Secondary-UNIQUE seed duplicate aborts `apply schema … with seed` with
      `UNIQUE constraint failed`.
- [x] Reseed re-presenting an already-present PK still skipped (idempotency pins pass).
- [x] `ON CONFLICT (<target>) DO NOTHING` suppresses only conflicts on `<target>`.
- [x] Partial-conflict-target acceptance still passes.
- [x] "Caveat — secondary UNIQUE collisions" note removed from `docs/schema.md`.
- [x] Full test suite + lint green.
