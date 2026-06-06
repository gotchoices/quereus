description: Regression tests + clarifying comments pinning the (already-correct) NOT NULL error attribution for column-reference DEFAULTs. No runtime behavior changed — tests + comments only. Reviewed and completed.
files: packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/planner/building/constraint-builder.ts
----

## Summary

The originally-suspected "misattribution" bug does not exist: a NOT NULL
violation is reported against the FIRST NOT-NULL column (declaration order) with
a NULL effective value, independent of which column any `new.<col>` DEFAULT
references. Because `default_column_nullability='not_null'` is the engine default
(`core/database.ts:240`), a bare sibling `a` is itself NOT NULL, so the repro's
`c1.a` message is correct.

The implement stage added a regression section to `03.4-defaults.sqllogic` plus
two clarifying comments (`constraint-check.ts`, `constraint-builder.ts`). **No
runtime code path was changed.** This ticket reviewed that work, verified the
semantics against the actual runtime, strengthened one under-specified test, and
ran both the memory and store modules.

## Review findings

### What was checked

- **Harness semantics of `-- error:`** — confirmed it is a *real* assertion, not
  a comment. `logic.spec.ts:723-730` triggers `executeExpectingError`, which
  does a case-insensitive substring match (`actualError.message.toLowerCase()
  .includes(...)`, line 602). `c1.a` vs `c1.b` are genuinely distinguished.
- **Block accumulation / statement-split flow** — traced every block. The
  bundling of a trailing `DROP TABLE` into the next block's setup (existing
  pattern) is benign; each `→` / `-- error:` flushes and resets correctly. No
  vacuous passes: `→ []` compares row counts (line 663), so a wrongly-inserted
  IGNORE/positive row would fail.
- **Attribution claim vs code** — `checkNotNullConstraints`
  (`constraint-check.ts:264-298`) walks columns in declaration order, throws on
  the first NOT-NULL column whose NEW value (`numCols + i`) is NULL, naming
  `column.name`. Matches the comment exactly.
- **Throw-site claims** — verified the three distinct sites the comments
  reference all name the same column: plain ABORT → `throwForAction` (line 297);
  OR REPLACE with no DEFAULT to substitute → `ConstraintError` (line 284, the
  `c1` REPLACE form, `a` has no default); OR REPLACE whose DEFAULT resolves NULL
  → `ConstraintError` (line 289, the `c2`/`c_ord` forms). All accurate.
- **Linchpin default** — `default_column_nullability` defaultValue is `'not_null'`
  (`core/database.ts:240`), and `core-api-features.spec.ts` already asserts it.
  Without this the whole `c1.a` premise collapses; confirmed solid.
- **Positive substitution case** (`c2` id=3, a=7, b=null OR REPLACE → stored
  b=7) genuinely exercises `buildNotNullDefaults` substitution + `replacedRow`
  surfacing; a broken substitution would error or store NULL → mismatch.
- **Docs** — no behavior changed, so no doc was out of date. `docs/` describes
  DEFAULT/NOT NULL semantics that remain accurate; nothing required updating.
  (Stated explicitly per review rules, not skipped silently.)

### What was found — and done

- **MINOR (fixed inline).** The IGNORE comment claims *"IGNORE is handled before
  DEFAULT substitution"*, but the existing IGNORE test (`c2` id=5, `a` omitted →
  NULL) could **not** prove it: with `new.a` NULL either way, the row is skipped
  whether IGNORE bails first or substitutes-then-rechecks. The comment asserted a
  mechanism the test left unverified — a hole in the "lock in the semantics"
  goal. **Fix:** added a distinguishing case (`c2` id=6, **a=7**, b=null,
  OR IGNORE → `select id … = 6 → []`). With a non-NULL sibling, substitution
  *would* satisfy NOT NULL and insert the row; its absence proves IGNORE skips
  before substituting. This pins the REPLACE-vs-IGNORE asymmetry the comment
  describes. The asymmetry is SQLite-compatible (REPLACE substitutes a NULL'd
  NOT-NULL column from its DEFAULT; IGNORE skips the row).

- **MAJOR.** None. No new tickets filed.

### Validation performed

- Targeted memory: `test:single … --grep "03.4-defaults"` → **1 passing** (after
  the inline edit).
- Targeted **store** (`QUEREUS_TEST_STORE=true … --grep "03.4-defaults"`) →
  **1 passing**. This closes the implementer's largest flagged gap (store parity
  was previously unverified). OR REPLACE substitution + `replacedRow` surfacing
  behaves identically under the LevelDB store module.
- `yarn workspace @quereus/quereus run lint` → clean (exit 0). TS edits are
  comments only.
- Per-file `beforeEach` creates a fresh `Database`, so the additive edit to a
  single `.sqllogic` file cannot affect other files; full-suite re-run not
  required for isolation (implement stage already recorded 4853 passing).

### Residual notes (no action required)

- `c_ord` asserts only the OR REPLACE form of the ordering case. One assertion is
  sufficient to demonstrate first-violator wins; the plain-`insert` path would
  name the same column via `throwForAction`. Left as-is.
- The row-expansion `isn't a column` path is deliberately kept distinct from the
  materialised-row `buildNotNullDefaults` path (the new cases use OR REPLACE /
  explicit NULLs to stay on the latter). The comments call this out; the
  separation reads clearly and the existing `t_newref` cases cover the former.
