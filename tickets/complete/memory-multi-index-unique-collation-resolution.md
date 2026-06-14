description: Memory module under-enforced a UNIQUE constraint when two UNIQUE indexes covered the same column-set with different collations — `findIndexForConstraint` resolved the enforcing index BY COLUMN-SET (first match), so both same-column-set UCs enforced under the first-listed index's collation, silently under-enforcing a coarser-declared UNIQUE in an order-sensitive way. Fixed by resolving an index-derived UC BY NAME via `uc.derivedFromIndex`, keeping the column-set scan as the non-derived/defensive fallback. Implemented, tested, and reviewed.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/schema/unique-enforcement.ts
  - packages/quereus/test/unique-enforcement-collation.spec.ts
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic
  - docs/schema.md
----

# Complete: memory under-enforced UNIQUE with multiple same-column-set indexes of differing collation

## What shipped

`MemoryTableManager.findIndexForConstraint` now resolves an **index-derived** UNIQUE
constraint by name (`uc.derivedFromIndex`) before the column-set scan, so each derived UC
enforces under ITS OWN index's collation and candidate set. With two UNIQUE indexes over the
same column-set, a coarser-declared (NOCASE) UNIQUE now rejects a case-variant duplicate
regardless of index creation order — matching SQLite and the store module's by-name
`uniqueEnforcementCollations`. Non-derived UCs keep the column-set scan (their auto-built
`_uc_*` carries the declared collation). Companion changes: reworded the three doc-comments
that described this as a "KNOWN gap / pre-existing memory bug" (`manager.ts`,
`unique-enforcement.ts`, the spec header), and added an explicit multi-index guarantee to
`docs/schema.md`'s "Index-derived UNIQUE enforcement collation" section.

## Review findings

### Verification performed (all green)

- **Lint:** `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`) →
  EXIT=0.
- **Full memory suite:** `node test-runner.mjs` → **6283 passing, 9 pending**, EXIT=0 (no
  regressions; matches the implementer's claim).
- **Targeted:** `unique-enforcement-collation.spec.ts` → **9 passing** (incl. both new
  multi-index shapes); `102.2-unique-collation.sqllogic` under memory AND store
  (`--grep "102.2"`) → both passing.

### What was checked

- **The fix itself (correctness):** `findIndexForConstraint` by-name branch sits correctly
  after the `allowMvCovering` MV check and before the column-set scan; returns the UC's own
  `MemoryIndex`, so both the final `compareSqlValues` (`index.specColumns[i].collation`) and
  candidate generation (`getPrimaryKeys` over the index's own BTree) use the right per-column
  collation. The `getSecondaryIndex?.(...)` optional-call correctly falls through on an
  unresolved name. Sound for the targeted two-derived-index scenario.
- **Test coverage:** the sqllogic §11 exercises the real end-to-end path under BOTH modules in
  BOTH creation orders — the meaningful regression lock. (Caveat noted below: the spec's
  `resolveLiveIndex` reimplements the resolver rather than invoking it.)
- **Docs:** read `docs/schema.md` §"Index-derived UNIQUE enforcement collation" — it already
  asserted memory's `checkUniqueViaIndex` matched the store, which was actually *false* on
  `main` for the multi-index shape and is now true; added an explicit clause documenting the
  per-index by-name resolution and its order-independence.

### Findings

- **MAJOR — filed as a new fix ticket** (`memory-nonderived-unique-reused-finer-index-under-enforcement`):
  the implementer's flagged gap #1 is **real and reproducible**. A NON-derived UNIQUE
  (`derivedFromIndex` unset) is NOT rerouted by this fix, and when a finer same-column-set
  `CREATE UNIQUE INDEX` already exists at the time the constraint is realized
  (`CREATE UNIQUE INDEX … (b COLLATE binary)` then `ALTER TABLE … ADD CONSTRAINT … UNIQUE (b)`
  on a NOCASE column), the constraint is physically realized by — and `findIndexForConstraint`
  resolves to — that finer index, so it enforces under BINARY and silently admits both `'Bob'`
  and `'bob'` (verified: count=2, second insert NOT rejected; the mirror DDL order rejects
  correctly). Memory diverges here from both the shared helper (declared collation) and the
  store. **Pre-existing** (the non-derived path was unchanged by this fix), order-sensitive,
  data-integrity-affecting — hence a new ticket rather than an inline fix, since the proper
  remedy touches index-realization (`ensureUniqueConstraintIndexes` reuse) and has covering-MV
  / DROP-lifecycle implications warranting its own design pass.

- **MINOR — accepted, no action:**
  - **Conformance-lock strength.** `unique-enforcement-collation.spec.ts`'s `resolveLiveIndex`
    *reimplements* `findIndexForConstraint`'s resolution rather than calling the (private)
    method, so it does not guard against the production resolver drifting from the
    reimplementation. Acceptable: the sqllogic §11 covers the real path end-to-end under both
    modules, which is the load-bearing regression test. Exposing the private method just for
    the spec wasn't judged worth it.
  - **§11 can't isolate a BINARY-only rejection** (gap #2): any re-insert of an existing
    byte-value is also a NOCASE duplicate, so the finer index's independent enforcement can't
    be exercised alone; §11 instead demonstrates "keeps byte-distinct apart" via the `'Carol'`
    insert succeeding. Acceptable.
  - **Defensive fallback** (gap #3): `derivedFromIndex` set but `getSecondaryIndex` returns
    undefined → column-set scan. Not directly covered; an inconsistent-schema defensive path,
    not expected in practice. Acceptable.
  - **Full `yarn test:store` not run** (gap #4): only `102.2` was exercised under store
    (passing). The shared helper path the broader store suite depends on was unchanged by this
    fix. Acceptable for an agent run (full store suite is the slower out-of-band path).

### Net

The fix is correct and well-tested for the scenario it targets (two derived indexes, both
creation orders, both modules), lint + full suite green, docs reconciled. The one substantive
gap — a sibling under-enforcement on the *non-derived* path — is reproduced and handed off as a
new fix ticket rather than left as prose.
