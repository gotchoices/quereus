description: Relaxed MV recompile gate — backing-PK superkey check for ADD CONSTRAINT UNIQUE that subsumes the compound key (reviewed)
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic
  - docs/materialized-views.md
---

# MV recompile superkey/PK gate relaxation — complete

## What was done (implement stage)

`tryRecompileMaterializedViewLive`'s gate 3 was relaxed from strict backing-PK
equality to a two-part superkey check:

- **`BackingShape.allProvedKeys`** — new optional field, populated in
  `deriveBackingShapeUnguarded` with `keys.map(k => Array.from(k))` when `keysOf`
  proved at least one key (absent on coarsened-lineage / all-columns paths).
- **`backingColumnsStructurallyMatch`** — per-column type/not-null/collation match
  without comparing the physical PK.
- **`isBackingPkASuperkeyInShape`** — true iff some proved minimal key ⊆ the
  backing's physical PK column set.
- **Gate 3** now takes a relaxed path: when columns match structurally AND the
  backing PK is still a superkey, it re-registers the EXISTING backing (unchanged
  PK) instead of marking the MV stale. The tighter key is adopted only by REFRESH.
- Docstring, `docs/materialized-views.md`, and a new sqllogic test §14 added.

## Review findings

### Logic / correctness — checked, sound

- **Soundness of the superkey check.** `keysOf` (`planner/util/fd-utils.ts`) is
  documented as sound-but-incomplete: every *listed* minimal key genuinely holds.
  `isBackingPkASuperkeyInShape` returns `true` only when a listed key ⊆ backing PK,
  so the kept backing PK is genuinely unique → **no false positives**, no risk of
  keeping a live MV over a non-unique backing. False *negatives* (a real superkey
  proven only via FD closure, not in the minimal list) fall back to stale — the
  safe direction, consistent with the gate's stale-on-doubt philosophy. No bug.
- **AND-gate interaction.** When `describeBackingShapeMismatch` reports a *column*
  diff (type/not-null/collation/count), `backingColumnsStructurallyMatch` re-scans
  and returns `false`, short-circuiting the relaxed path to stale. The relaxed path
  can only be taken on a pure PK-shape difference. Correct.
- **PK direction / collation skip.** The relaxed path bypasses `describeBackingShapeMismatch`'s
  PK direction/collation checks. Safe for MV backings: `buildBackingTableSchema`
  sets each PK component's collation from the column collation (guarded by the
  structural column check), and PK direction (`desc`) does not affect uniqueness or
  maintenance correctness — only clustering.
- **Ordering-seeded physical PK.** `computeBackingPrimaryKey` prepends ORDER BY
  columns to the physical PK. The superkey check tests against the FULL physical PK
  set, which is a superset of the logical key — strictly permissive, never
  over-restrictive. Safe.
- **Empty-key edge.** A `[]` proved key (≤1-row body) makes `[].every(...)` true →
  relaxed path eligible; correct, since any PK is a superkey of a ≤1-row relation
  (still also requires the structural-column gate).

### Findings dispositioned

- **MINOR (fixed inline):** `docs/materialized-views.md` line 619 prose summary
  still said re-registration happens "on a full match" — stale after the
  relaxation. Updated to describe the structural-columns + PK-superkey condition.
  (The implementer had updated the §623 bullet but not this summary.)
- **MINOR (fixed inline):** test §14 asserted liveness via an INSERT only. Added a
  DELETE-propagation assertion so the test proves maintenance fully works under the
  unchanged (wider) backing PK, not just inserts.
- **NON-ISSUE (handoff focus area #1 — resolved):** the handoff worried whether
  `keys.map(k => Array.from(k))` yields sorted arrays because "`keysOf` returns
  `Set<number>[]`". `keysOf` actually returns already-sorted `number[][]` (via
  `normalizeKeys`), and the superkey membership check (`k.every(idx => set.has(idx))`)
  is order-independent regardless. No problem on either count.
- **OBSERVATION (no action — acceptable):** a dedicated soundness primitive
  `isUnique(cols, rel)` already exists in `fd-utils.ts` and is *more complete* than
  the hand-rolled subset check (it adds an FD-closure branch that can prove a
  superkey absent from the minimal `keysOf` list). The implementer could not call
  it directly: at recompile time only the serialized `BackingShape` (not the live
  body root node) is available, and the old backing PK to test against is unknown
  until then. The chosen `allProvedKeys`-subset approach is sound and conservative;
  using closure would only let *more* MVs stay live, never change correctness. Not
  worth a follow-up ticket at this time.

### Coverage notes

- Not added (acceptable): a test where the columns mismatch but the PK would be a
  superkey (exercising the AND short-circuit). Constructing a body-irrelevant change
  that simultaneously changes a column's structural attributes is contrived; §8
  already covers the body-relevant column-retype → stale path, and the
  short-circuit is verified by inspection.

### Validation

- `yarn lint` (packages/quereus) — **pass**.
- Full quereus logic corpus (243 sqllogic files) via mocha — **pass**.
- All 6 materialized-view logic files including the strengthened §14 — **pass**.
- No unit spec asserts on `BackingShape` shape, so the additive `allProvedKeys`
  field breaks no snapshot/equality assertions.

No major findings → no new tickets filed.
