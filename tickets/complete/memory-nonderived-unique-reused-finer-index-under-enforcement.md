description: COMPLETE — memory-module fix for a non-derived UNIQUE under-enforcing when a pre-existing FINER same-column-set `CREATE UNIQUE INDEX` already covered the column-set. Realization now refuses to reuse a collation-mismatched index (builds the constraint's own declared-collation `_uc_*`), and `findIndexForConstraint` resolves a non-derived UC to its OWN realizing structure BY NAME. Store was already correct; memory-only fix + cross-module sqllogic. Reviewed and accepted with one inline test addition (§13) and a docs update.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # indexCollationsMatchDeclared (~243); ensureUniqueConstraintIndexes guard (~168); addUniqueConstraint guard (~2437); findIndexForConstraint non-derived by-name resolution (~1070)
  - packages/quereus/src/schema/unique-enforcement.ts                  # reference helper (unchanged)
  - packages/quereus/src/util/comparison.ts                            # normalizeCollationName (imported into manager.ts)
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # §12 (implement) + §13 (review: OR REPLACE/IGNORE over coexisting structures); memory AND store
  - packages/quereus/test/unique-enforcement-collation.spec.ts         # conformance lock; two non-derived+finer-index shapes
  - docs/schema.md                                                     # review: documented non-derived-coexists-with-finer-index realization/resolution
----

# Complete: non-derived UNIQUE under-enforcement when realized by a pre-existing finer same-column-set index

## Summary

Under the **memory** module only, the DDL order *(finer `CREATE UNIQUE INDEX` first, then a
non-derived NOCASE `UNIQUE`)* silently admitted a NOCASE-duplicate. The implement stage fixed
this in three reinforcing spots in `manager.ts`:

1. **Realization guard** — `indexCollationsMatchDeclared(idx, uc)` gates reuse of an existing
   same-column-set index. Both reuse sites (`addUniqueConstraint`,
   `ensureUniqueConstraintIndexes`) now reuse an index only when its per-column collations are
   equivalent to the declared column collations; otherwise they build the constraint's own
   declared-collation `_uc_*` and let the user index coexist (matches SQLite — both enforce).
2. **Resolution** — `findIndexForConstraint` resolves a non-derived UC to its OWN realizing
   structure BY NAME via `getImplicitCoveringStructure(uc)` before the (defensive) column-set
   scan, so it no longer returns an earlier-listed finer index.
3. `normalizeCollationName` imported into `manager.ts`.

Store/isolation were already correct (never reused the user index; resolve BY NAME via
`uniqueEnforcementCollations`).

## Review findings

### Verified correct
- **Read the implement diff first** (commit `655ae4a4`) with fresh eyes before the handoff.
- **The fix is conservative and regression-safe.** The collation guard only *narrows* index
  reuse — it can newly *refuse* reuse but never newly *grant* it, so the common case
  (plain `create unique index` inheriting the column collation) still reuses. Confirmed
  `buildIndexSchema` (`schema/manager.ts:2402`) and `importIndex` (`:3151`) always resolve
  index-column collation to `normalizeCollationName(explicit ?? column ?? 'BINARY')` — never
  `undefined` — so `indexCollationsMatchDeclared`'s fallback chain is robust and its
  normalize-both-sides comparison is order- and case-safe.
- **Positional-alignment assumption holds.** `indexCollationsMatchDeclared` assumes
  `idx.columns[i]` ↔ `uc.columns[i]`; both `.find(...)` predicates short-circuit the column-SET
  `.every(...)` *to the left* of the helper call, guaranteeing alignment. (Preserve this order
  if either predicate is refactored.)
- **All reuse sites covered.** Audited every `col.index === uc.columns[i]` site in
  `vtab/memory`: lines 170 (ensure) and 2440 (addUnique) are guarded; line 1085 is the
  intentional *defensive* fallback (reached only when by-name resolution fails — unreachable in
  tested paths once the guard has built `_uc_*` and the covering-structures map is populated);
  1143/1221 are value-comparison loops, not reuse. No missed site.
- **Test is a genuine regression guard, not a tautology.** Temporarily neutered
  `indexCollationsMatchDeclared` to `return true`; §12a then *failed* (the `'bob'` duplicate was
  admitted). Restored the source and confirmed the working tree matches HEAD byte-for-byte.

### Edge cases / interactions
- **OR REPLACE / OR IGNORE over the two coexisting structures** — the gap the handoff flagged as
  "not directly asserted." Probed it: a conflict on the NOCASE structure must not be a false
  conflict on the BINARY index, OR REPLACE must evict exactly the conflicting row, and a
  byte-exact value (both structures conflict on the same row) must evict once. **All behave
  SQLite-correctly in BOTH memory and store.** *Disposition: minor → fixed inline.* Promoted the
  probe into committed coverage as **§13** of `102.2-unique-collation.sqllogic` (4 cases; passes
  memory + store).
- **Lifecycle (§12c)** — re-derived by hand: a *named* constraint builds an index named after the
  constraint (`uq`), so `dropConstraint` drops `uq` and leaves the user's `mif_binary` intact;
  the surviving derived UC keeps enforcing BINARY. Correct.

### Docs
- `docs/schema.md` previously claimed "a non-derived … UNIQUE always enforces under the declared
  column collation" — *correct as an aspiration, but the memory module violated it pre-fix in one
  DDL order.* Added a sentence documenting the realization/resolution mechanism that now backs
  that guarantee (no reuse of a finer index; by-name resolution via
  `getImplicitCoveringStructure`; both indexes coexist). Doc now reflects reality.

### Not done (with reasons)
- **No row-time covering-MV variant in §12/§13.** Genuinely out of scope and not a regression
  risk: `coveringMvHonorsIndexCollation` for a *non-derived* UC always returns true (`I == D`,
  the declared collation), so an MV would re-validate under the correct declared collation. The
  covering-MV path is unchanged by this fix. No bug found; no test added.
- **Named-constraint name collision** (a pre-existing user index named like the new constraint)
  remains untested — a pre-existing edge unrelated to collation and not touched/regressed by this
  fix (the named constraint already named its own index after the constraint). Left as-is.
- **Defensive fallback (manager.ts:1085) is collation-blind.** Could in principle return a
  wrong-collation first-listed index, but is unreachable once by-name resolution lands (which the
  §12 tests prove it does). Hardening it to filter by collation would change its best-effort
  contract in untested edge paths for no demonstrated benefit. Noted, not changed.
- **Conformance-lock coupling** — `resolveLiveIndex` mirrors the source rather than locking it
  directly; the *behavioral* guard against a source revert is §12 (verified above to fail on
  buggy source). Acceptable.

### Validation (all green)
- `yarn workspace @quereus/quereus run test` → **6285 passing, 9 pending** (full memory suite).
- `yarn workspace @quereus/quereus run lint` → clean (eslint + test-file tsc).
- `102.2-unique-collation` (incl. new §13) → passing under **memory AND store**.
- `unique-enforcement-collation.spec.ts` → 11 passing (incl. the two non-derived+finer shapes).
