description: Gate row-time covering-MV eligibility for an index-derived UNIQUE on collation. A covering MV's candidate generation re-compares under the SOURCE column's DECLARED collation, so the MV is a sound superset of index-collation matches only when, per constrained column, the index per-column collation is BINARY (reflexive ⇒ every collation is coarser-or-equal to BINARY) or equals the declared collation; otherwise the candidate set is an unsound subset (a coarser index silently misses conflicts). Decline the MV as covering in `findRowTimeCoveringStructure` when that condition fails (fall back to the already-correct per-scan path), and align memory's `checkUniqueViaMaterializedView` to re-validate under the index per-column collation (matching the store + `checkUniqueViaIndex`) so the surviving finer-index (index=BINARY) case agrees cross-module.
prereq:
files:
  - packages/quereus/src/core/database-materialized-views.ts          # findRowTimeCoveringStructure (gate locus); lookupCoveringConflicts/tryBuildCoveringPrefix (candidate gen — UNCHANGED, read for the declared-collation fact)
  - packages/quereus/src/vtab/memory/layer/manager.ts                 # checkUniqueViaMaterializedView (~1133, align to index collation); checkUniqueViaIndex (~1062, the reference); findIndexForConstraint (~1009, MV-vs-auto-index selection)
  - packages/quereus/src/util/comparison.ts                           # normalizeCollationName, BINARY/NOCASE/RTRIM (collations are opaque comparators — no subsumption lattice)
  - packages/quereus-store/src/common/store-table.ts                  # findUniqueConflictViaCoveringMv (UNCHANGED behavior; stale "coarser out of scope" comment to update)
  - packages/quereus/test/covering-structure.spec.ts                  # gate unit tests + cross-module MV-enforcement collation tests
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic       # add §10 — index-derived UNIQUE through a covering MV (runs under yarn test AND yarn test:store)
  - packages/quereus-store/test/unique-constraints.spec.ts            # update finer-index covering-MV comment; add coarser-index covering-MV case
difficulty: medium
----

# Gate covering-MV eligibility for an index-derived UNIQUE on the index collation

## Decision (settled — implements the 2026-06-13 triage choice (a))

A row-time covering MV answering a UNIQUE constraint generates its candidate set
(`MaterializedViewManager.lookupCoveringConflicts`) by re-comparing each backing
row under the **declared source-column collation** —
`sourceSchema.columns[uc.columns[k]].collation` — on both the prefix fast path
(`tryBuildCoveringPrefix` bails to a full scan on any non-BINARY collation) and
the full-scan fallback. The downstream re-validators run under the **index
per-column collation** (store `findUniqueConflictViaCoveringMv` already; memory
`checkUniqueViaMaterializedView` after this ticket).

So the MV's candidate set is a **sound superset of the index-collation matches**
— and therefore safe to filter down at re-validation — **iff, for every
constrained column, the declared collation `D` is coarser-or-equal to the index
collation `I`** (every `I`-equal pair is also `D`-equal, hence generated as a
candidate). Two cases let us prove `D ⊒ I` **without a collation lattice** (which
does not exist — collations are opaque comparators in `util/comparison.ts`):

- **`I` normalizes to BINARY** — BINARY equality is byte-identity, and every
  well-formed comparator returns 0 for byte-identical inputs (reflexivity), so
  `byte-identical ⊆ D-equal` for *any* `D`. Superset holds. (This is the
  finer-index case: index BINARY over a NOCASE column.)
- **`D == I`** (normalized names equal) — trivially `D-equal == I-equal`. (The
  common case: index collation == declared, and every non-derived UNIQUE, where
  there is no index and `I` falls back to `D`.)

Otherwise (`I` is non-BINARY and differs from `D` — e.g. a coarser NOCASE index
over a BINARY column, an RTRIM index over BINARY, or two unrelated custom
collations) the candidate set may be a **subset** and the MV must **not** be used
as a covering structure: the constraint enforces via the per-scan path, which the
landed `store-index-derived-unique-honors-index-collation` ticket already made
correct under the index collation on both modules.

This **under-claims safely**: an exotic custom-collation pair where `D ⊒ I` holds
semantically but neither the BINARY-floor nor name-equality test fires is declined
(per-scan instead of MV) — a perf loss in an already-exotic shape, never a
correctness loss. There is **no candidate-generation widening** (the triage's hard
three-site change is avoided): a finer/incomparable MV is simply never *selected*.

### Eligibility predicate (per constrained column `i`)

```
let D = schema.columns[uc.columns[i]].collation                 // declared source-column collation
let I = (uc.derivedFromIndex                                    // index per-column collation, else declared
          ? schema.indexes?.find(ix => ix.name === uc.derivedFromIndex)?.columns[i]?.collation
          : undefined)
        ?? D
eligible_i  ⇔  normalizeCollationName(I) === 'BINARY'
            || normalizeCollationName(I) === normalizeCollationName(D)
```

(`normalizeCollationName(undefined)` → `'BINARY'`; a column with no explicit
collation is BINARY.) The MV is eligible **iff every** constrained column is
eligible — one finer/incomparable column poisons the whole MV (it covers all UC
columns or none).

Note the index↔UC positional alignment (`uc.columns[i]` ↔ `index.columns[i]`) is
guaranteed by `appendIndexToTableSchema` — the same invariant the store's
`uniqueEnforcementCollations` relies on.

## Architecture

```
                            db._findRowTimeCoveringStructure(schema, table, uc)
                                          │
                    MaterializedViewManager.findRowTimeCoveringStructure   ← ADD GATE HERE
                    (resolves THE linked MV; skips full-rebuild + stale)      decline ⇒ return undefined
                                          │ returns mv | undefined
        ┌─────────────────────────────────┼──────────────────────────────────────┐
        │                                 │                                        │
  store findUniqueConflictViaCoveringMv   memory findIndexForConstraint     lens-prover findBasisCovering
   (quereus-store/store-table.ts)          (memory/layer/manager.ts)         (schema/lens-prover.ts)
   undefined ⇒ per-scan findUniqueConflict undefined ⇒ auto-index            undefined ⇒ commit-time
   (index collation — correct)             checkUniqueViaIndex               set-level CHECK
                                           (index collation — correct)       (basis UC still per-scan-enforced)
```

Gating at the single resolver `findRowTimeCoveringStructure` is sound for **all
three** callers because declining only removes an unsound *optimization*; every
fallback (store per-scan, memory auto-index `checkUniqueViaIndex`, lens
commit-time + the basis UC's own per-scan physical enforcement) independently
honors the index collation after the landed ticket. Store and memory both consult
the same resolver, so they decline the **same** MV in lockstep — candidate
generation never runs for a declined MV, so neither module can hit the
subset-miss. The O(1) negative fast path is preserved: the gate runs only after a
positive MV match (a source with no row-time plan still pays a single map lookup).

### The two surviving live cases after the gate

| index `I` | declared `D` | MV eligible? | path taken | both modules agree? |
|-----------|--------------|--------------|------------|---------------------|
| BINARY (finer) | NOCASE | **yes** | MV used; re-validate under BINARY | yes — **needs memory alignment** |
| NOCASE (coarser) | BINARY | **no** | declined ⇒ per-scan / auto-index | yes — both via `checkUniqueViaIndex`/`findUniqueConflict` |
| NOCASE | NOCASE (equal/non-derived) | **yes** | MV used; re-validate under NOCASE | yes — unchanged (declared == index) |

The middle row is why memory's `checkUniqueViaMaterializedView` must be aligned:
when the MV stays eligible (I=BINARY) but D≠BINARY, memory currently re-validates
under D (NOCASE) and over-rejects a case-variant the BINARY index should admit,
while the store re-validates under BINARY (correct). After alignment both
re-validate under the index collation.

## TODO

### Phase 1 — the eligibility gate

- Add a small shared helper inside the **quereus** package (used by both the gate
  and memory) — e.g. `packages/quereus/src/schema/unique-enforcement.ts`:
  - `uniqueEnforcementCollations(schema: TableSchema, uc: UniqueConstraintSchema): (string | undefined)[]`
    — the index-per-column-COLLATE-else-declared resolution already duplicated in
    `store-table.ts` and `isolated-table.ts`. Memory's `checkUniqueViaMaterializedView`
    will call this (Phase 2).
  - `coveringMvHonorsIndexCollation(schema: TableSchema, uc: UniqueConstraintSchema): boolean`
    — the per-column predicate above (BINARY-floor OR name-equal, all columns).
- In `MaterializedViewManager.findRowTimeCoveringStructure`
  (`database-materialized-views.ts`), after the matched MV passes the
  full-rebuild + stale checks and *before* returning it, resolve the source table
  (`this.ctx._findTable(tableName, schemaName)`) and return `undefined` when
  `!coveringMvHonorsIndexCollation(sourceSchema, uc)`. Keep it defensive: if the
  source schema can't be resolved, fall through to the existing behavior (do not
  throw — mirror the existing `if (!index) return …` tolerance).
- **First, confirm the premise** with a throwaway assertion in
  `covering-structure.spec.ts`: that *pre-gate* `_findRowTimeCoveringStructure`
  returns the MV for a coarser-index shape (index NOCASE over a BINARY column with
  an `order by` covering MV). If the covering-link prover already declines to link
  such an MV, the silent-miss can't occur and the gate is pure defense-in-depth —
  document that in the gate comment, but the gate stays correct either way. (The
  symmetric finer-index shape is already known to link + be used: see the store
  `unique-constraints.spec.ts` "FINER index … through the covering MV path" test.)

### Phase 2 — align memory's covering-MV re-validation

- In `MemoryTableManager.checkUniqueViaMaterializedView` (`manager.ts:~1133`),
  replace the per-column `schema.columns[col].collation` re-validation with the
  index per-column collation via `uniqueEnforcementCollations(schema, uc)` —
  mirroring `checkUniqueViaIndex` (`manager.ts:~1062`), the store, and the
  isolation overlay. Update the surrounding comment to state it honors the index
  collation (and why: the store already does, and the gate guarantees only the
  BINARY-floor or equal-collation MVs reach here).
- Leave `checkUniqueByScanning` (`manager.ts:~1156`, declared collation) as-is for
  this ticket: a derived UNIQUE always has a matching auto-index, so
  `findIndexForConstraint` routes a declined-MV derived UNIQUE to
  `checkUniqueViaIndex` (index collation), never the cold scan. Note this in the
  edge-cases verification rather than changing it.

### Phase 3 — tests

- **`covering-structure.spec.ts`** (memory; runs under `yarn test`):
  - Gate unit tests on `_findRowTimeCoveringStructure` for an index-derived UC with
    a covering MV: returns the MV for **finer** (I=BINARY/D=NOCASE) and **equal**
    (I=NOCASE/D=NOCASE) and **non-derived**; returns `undefined` for **coarser**
    (I=NOCASE/D=BINARY) and **RTRIM-over-BINARY** and a **composite** UC whose one
    member is coarser.
  - End-to-end memory enforcement through the covering MV: finer-index admits both
    case-variants (`'Bob'`/`'bob'`) — this is the memory-alignment assertion that
    fails before Phase 2; coarser-index rejects the NOCASE-equal/BINARY-different
    dup (`'Bob'` then `'BOB'` → UNIQUE failed) via the declined-MV per-scan path.
- **`102.2-unique-collation.sqllogic`** — add **§10** "Index-derived UNIQUE through
  a covering MV" (parallels §9's per-scan shapes but with a row-time covering MV
  linked), so it runs on **both** memory (`yarn test`) and store (`yarn test:store`):
  - 10a finer index (BINARY) over a NOCASE column + covering MV → both `'Bob'` and
    `'bob'` insert; a genuine BINARY dup still rejected; `count = 2`.
  - 10b coarser index (NOCASE) over a BINARY column + covering MV → `'BOB'` after
    `'Bob'` is rejected; a distinct value inserts; `count` reflects the rejection.
  - 10c equal/plain index + covering MV → unchanged folding (sanity, mirrors §4).
  - Update the file header note (currently "covering-MV §4 uses a non-derived
    NOCASE column") to mention §10 exercises the index-derived shapes through the MV.
- **`packages/quereus-store/test/unique-constraints.spec.ts`**:
  - Update the "FINER index … through the covering MV path" test's comment — store
    and memory now agree (drop the "store-only … memory differs" caveat).
  - Add a **coarser-index covering-MV** store test: index NOCASE over a BINARY
    column with a covering MV → the NOCASE-equal/BINARY-different dup is rejected
    (declined-MV per-scan), proving the silent-miss is closed on the store too.

### Phase 4 — comments & docs

- Update the stale note in `store-table.ts` `findUniqueConflictViaCoveringMv`
  ("a COARSER-index covering MV is out of scope … its narrowed candidate set can
  be a subset") — a coarser/incomparable MV is now declined upstream by the gate,
  so this re-validation only ever sees BINARY-floor or equal-collation MVs (the
  superset it can soundly filter).
- `docs/materialized-views.md` § Covering structures — document the collation
  eligibility gate (an index-derived UNIQUE whose index collation is finer than /
  incomparable to the declared column collation is enforced via per-scan, not the
  covering MV).
- `docs/lens.md` § enforced-set-level row-time — note that the row-time
  classification inherits the gate (a finer/incomparable index-derived basis UC
  classifies commit-time, not row-time).

## Edge cases & interactions

- **Coarser index (NOCASE) over BINARY column + covering MV** — MV declined;
  per-scan / `checkUniqueViaIndex` rejects the NOCASE-equal/BINARY-different dup.
  This is the silent-miss the ticket exists to fix; assert rejection on **both**
  modules.
- **Finer index (BINARY) over NOCASE column + covering MV** — MV eligible
  (BINARY floor); both case-variants admitted; memory re-validates under BINARY
  after Phase 2 (the assertion that fails pre-fix). A genuine BINARY dup still
  rejected.
- **Equal collation / non-derived UNIQUE + covering MV** — eligible, byte-for-byte
  unchanged behavior (existing §4 and all non-derived covering-MV tests stay green).
- **Composite UNIQUE, mixed members** — gate is per-column with AND semantics: a
  composite whose one member is coarser/incomparable declines the whole MV. Test a
  composite `(a, b)` where `a`'s index is BINARY-over-NOCASE (ok) and `b`'s index is
  NOCASE-over-BINARY (bad) → declined.
- **RTRIM and custom collations** — RTRIM index over BINARY → declined (coarser);
  RTRIM index over RTRIM → eligible (equal). Custom index == declared → eligible;
  custom index ≠ declared and ≠ BINARY → declined (safe under-claim, perf-only).
- **Partial UNIQUE (`where` predicate) + collation gate** — orthogonal; the gate
  decides MV eligibility, the predicate still filters candidates. Both must hold.
- **Lens layer** — a logical UNIQUE whose basis derived-UNIQUE is declined
  classifies `enforced-set-level commit-time` instead of `row-time`; the basis UC's
  own physical per-scan enforcement still fires, so detection stays correct.
  Existing lens row-time tests use a **non-derived** `unique(email)` (always
  eligible) — confirm they don't regress.
- **ALTER COLUMN SET COLLATE** that re-collates the derived index (store-module &
  memory `alterColumn` propagate the new collation into the index columns) — the
  gate re-evaluates from current schema each call (no caching), so eligibility
  tracks the post-ALTER index/declared collations. Confirm an ALTER that flips a
  column from BINARY to NOCASE (making a previously-eligible BINARY-index MV now
  index=BINARY/declared=NOCASE — still eligible) and one that changes the index
  collation behaves correctly.
- **full-rebuild / stale MV** — gate is independent of and ordered after those
  checks; a deferred/stale MV is already declined regardless of collation.
- **O(1) negative fast path** — the source-schema lookup + per-column compare run
  only on a positive MV match; a source with no row-time plan is untouched.
- **Cross-module lockstep** — store and memory call the same resolver, so a
  declined MV is declined identically; candidate generation is never invoked for a
  declined MV, eliminating the subset-miss on both.

## Out of scope

- Widening candidate generation (`lookupCoveringConflicts` / `tryBuildCoveringPrefix`
  stay exactly as-is — the triage explicitly avoids this).
- Unifying the four copies of the enforcement-collation resolution
  (`store-table.ts`, `isolated-table.ts`, memory, and the new gate helper) into a
  single engine-exported helper imported across packages — a nice DRY follow-up,
  but it spans three packages and risks import cycles; the new helper is shared
  within the quereus package only. File a backlog ticket if desired.
- The relation-key promotion gate (`enforcementCollationCoversDeclared`) — audited
  sound, unchanged.
- Non-derived UNIQUE enforcement collation (declared == enforcement == output) —
  already sound and consistent on both modules.
