description: An application-schema table whose primary key column may be left empty used to accept two rows with an empty key when written through its lens; both lens enforcement paths for primary keys now treat two empty keys as the same key and reject the second row.
architecture: docs/lens-constraints.md#set-level-unique-primary-key
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts # SetLevelKeyColumn, synthesizeUniqueCountExpr, collectLensSetLevelConstraints, setLevelCommitOnly
  - packages/quereus/src/planner/mutation/capture-correlation.ts # captureKeyEquality doc lists the new caller
  - packages/quereus/src/schema/lens-prover.ts # classifyKeyConstraint — nullablePrimaryKey gate + diagnostic wording
  - packages/quereus/src/planner/building/view-mutation-builder.ts # rejectUpsertOnCommitTimeSetLevelKey suggestion text
  - packages/quereus/test/lens-enforcement.spec.ts # two regression tests in the set-level commit-time describe
  - docs/lens-constraints.md
  - docs/lens-prover.md
  - docs/mv-constraints.md
difficulty: medium
repro: verified
----

# Lens-enforced primary keys treat NULL as equal to NULL

## Summary

docs/schema.md § Primary-key nullability: primary-key comparison treats NULL as equal to itself; `UNIQUE` treats NULLs as distinct. A logical (lens-backed) primary key the lens could not prove unique was enforced with `UNIQUE`'s NULL-distinct semantics on both enforcement paths, so a nullable logical PK admitted duplicate NULL-keyed rows. Landed in `ticket(implement): bug-logical-primary-key-allows-two-null-keyed-rows`:

- **Commit-time count** (`lens-enforcement.ts`): each key column of the `(select count(*) from <logical> as _u where …) <= 1` check is built with `captureKeyEquality(_u.col, newSide, nullSafe)`, `nullSafe` true only for a primary-key column not declared NOT NULL. `unique` keys and NOT NULL PK columns keep plain `=`. The commit-only refusal remedy tells a nullable PK to declare its columns NOT NULL first.
- **Row-time classification** (`lens-prover.ts`): `classifyKeyConstraint` never classifies a primary key with a nullable column row-time (the basis UNIQUE that would enforce it is NULL-distinct), so it falls to the commit-time count. `lens.no-backing-index` / `lens.unenforceable-conflict-action` messages and the upsert-refusal suggestion explain the NOT NULL prerequisite.
- Docs updated in lens-constraints.md, lens-prover.md, mv-constraints.md.

## Review findings

**Checked**
- Read the full implement diff, then `captureKeyEquality`, `collectLensSetLevelConstraints`, `setLevelCommitOnly`, and `classifyKeyConstraint` in context.
- Correctness of the count predicate: per-column NULL-safety (a composite PK mixing a NOT NULL and a nullable column only disjoins the nullable one); AND-of-OR structure is AST-structural, and the composite test (`(1,null)` and `(2,null)` coexist, second `(1,null)` aborts) would fail if precedence were lost anywhere, so it is pinned. Self-match on UPDATE of a NULL-keyed row counts 1 (no false abort); re-keying another row to NULL counts 2.
- Classification soundness for paths before the new gate: a nullable logical PK over a nullable basis UNIQUE is not body-proved (the arm-2 test exercises exactly that schema and lands commit-time); a nullable logical PK over a NOT NULL basis UNIQUE is body-proved, which is sound since the basis never holds NULL; bijection transport requires NOT NULL key columns. So the only unsound route was the row-time one the fix closes.
- Unresolvable column defaults to nullable in both the prover gate and the enforcement flag, consistent with `keyColumnInfo`.
- Docs: all three touched docs read and match the code; the `schema.md#columnschema` anchor resolves to the section holding "Primary-key nullability".
- Tests: both new tests are bug reproductions (one per arm) at the spec layer the bug was observed at; kept. The reworded row-time-PK test comment is accurate.
- `yarn workspace @quereus/quereus test` — 11196 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus lint` — exit 0. `yarn test:store` not run (the change is in planner/prover, not the store path).

**Minor — fixed inline**
- `captureKeyEquality`'s doc comment enumerates its callers (capture readers, decomposition stitch keys) and did not list the new set-level count caller; added it, noting the NULL-safe form applies only to primary keys there.

**Major** — none found.

**Tripwires** — none added. The implementer's note that the NULL-safe disjunction may cost the count an index seek is already covered by the existing `NOTE:` on `captureKeyEquality` (declared vs. reachable nullability) and the count is an O(n) scan by design.

**Considered, no action**
- Behaviour change: a nullable logical PK that previously classified row-time is now commit-time (new `lens.no-backing-index` warning; declared `on conflict replace/ignore` now a deploy error; `or …` statement clauses and upserts refused). This is the intended consequence of the fix — the previous row-time enforcement was unsound for such keys.
- Warning opening "has no basis covering structure" reads slightly off for the shape where a covering view exists but cannot be used; the appended sentence explains it. Left as-is — rewording the shared opening would fork the message for little gain.
- Advisory fingerprint excludes nullability; acknowledgements carry across. Acceptable — the warning's identity is the key, not its nullability.
- File sizes: lens-enforcement.ts 1552 lines, lens-prover.ts 2528 lines (`wc -l`); the change added ~40 lines net and no new extraction opportunity of note.
