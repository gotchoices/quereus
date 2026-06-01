description: Decomposition put INSERT fan-out — anchor-first one-insert-per-member off the shared-surrogate envelope (surrogate mint per-row/per-statement, logical-tuple PK threading, optional/EAV/singleton handling). Built in `view-mutation-builder.ts` off `analyzeDecompositionInsert`. Reviewed and completed.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped

The substrate-gated **INSERT** half of the decomposition put fan-out. An insert
through a decomposition-backed logical table fans out to **one insert per member,
anchor first** (FK-order root), riding the shared-surrogate mutation envelope
(`view-mutation-shared-surrogate-insert`). It is the dual of the multi-source
insert, generalized from two FK-ordered sides to an n-way member fan-out with
optional / EAV / singleton handling.

- `analyzeDecompositionInsert` (`decomposition.ts`) — pure, plan-agnostic. Routes
  each logical column to its backing member (columnar identity or EAV pivot),
  resolves the shared key (surrogate mint vs supplied logical-tuple PK), emits
  per-member `DecompInsertOp[]` (target columns + per-row presence gates), anchor
  first; precise diagnostics for the deferred shapes.
- `buildDecompositionInsert` (`view-mutation-builder.ts`) — turns the analysis into
  plan nodes (one `EnvelopeScanNode` per op sharing a descriptor, an optional
  presence `FilterNode`, a `ProjectNode`, each re-planned through `buildInsertStmt`).
- Per-statement cadence (`MutationEnvelope.mint.cadence`) added; the emitter mints
  `seed + ordinal` (per-row) or `seed + 1` (per-statement).

DELETE/UPDATE fan-out unchanged. Predicate-honest non-anchor writes and
optional/EAV/key UPDATE transitions remain deferred onto absent substrate, each
with a precise diagnostic.

## Review findings

Method: read the implement diff (637462bf) with fresh eyes first, then the handoff.
Scrutinized routing, key-threading, presence gates, surrogate cadence, atomicity,
DRY, type safety, and docs. Re-ran build + lint + typecheck + full memory suite.

### Correctness — no bugs found
Wrote three adversarial probes targeting the boundaries the implementer flagged as
untested, then promoted them to permanent regression tests (the implementer's tests
are a floor):

- **Mixed-case EAV column round-trip** (handoff flagged "worth an adversarial
  probe"): declared a `City` EAV column, inserted, read back. The write stores the
  attribute spelled as declared (`'City'`, case preserved via `declaredColumnNames`)
  and the case-sensitive read literal match recovers it. **Correct** — the
  `declaredColumnNames` ⇄ `buildEavSubquery` literal pairing holds. Now covered by
  `'an EAV write stores the declared (mixed) case attribute and reads it back'`.
- **Mid-fan-out failure atomicity** (handoff: "not directly asserted for the
  decomposition path"): pre-seeded only the second member at a key so the anchor
  insert succeeds but the member insert collides mid-fan-out. The whole statement
  rolls back — the already-written anchor row does **not** persist. **Correct**
  (rides the shared `ViewMutationNode`/emitter atomicity). Now covered by
  `'a mid-fan-out member failure rolls the whole statement back'`.
- **Omitted mandatory-member NOT NULL column** (derived edge case): omitting a
  member's required column is caught at analysis time (`assertNoMissingNotNull` →
  precise `no-default`) **before any base op fires** — no partial anchor write. Now
  covered by `'omitting a mandatory member NOT NULL column is rejected…'`.

### Quality — one finding, fixed inline (minor)
- **DRY**: `buildDecompositionInsert` and `buildMultiSourceInsert` duplicated ~45
  lines of envelope-shape (attrs / type / descriptor) + seed-mint construction
  verbatim. Extracted `buildEnvelopeShape(suppliedColumns, hasMint)` and
  `buildSeedMint(ctx, mintSpec)`; both insert builders now call them. Behavior
  identical (full suite green); the cadence threads through `buildSeedMint`'s
  optional field, leaving the multi-source path on its implicit `per-row`.

### Docs — checked, accurate
Read every doc the change touched (`docs/lens.md` § The Default Mapper + coverage
checklist, `docs/view-updateability.md` § Mutation Context + file map). All reflect
the new reality (INSERT shipped, the four remaining deferrals named with their
diagnostics). No doc drift; no doc edits needed.

### Major findings → no new tickets filed
None. Every deferral in the handoff is a genuine substrate dependency already
tracked, not an oversight:
- **Phase B** optional/EAV/key UPDATE transition — `unsupported-decomposition-update`,
  needs per-row insert-or-delete branching inside an update group.
- **Phase C** predicate-honest non-anchor-member WHERE — `unsupported-decomposition-predicate`,
  needs the snapshot-consistent multi-member execution substrate (shared with the
  lenient multi-side join delete).
- non-integer / declared-default surrogate generators (`no-default`), composite
  shared keys (`unsupported-decomposition-key`) — explicit v1 boundaries.
- Lens row-local CHECK is not threaded onto a decomposition insert (matches the
  multi-source insert path) — a capability gap, not a regression (insert was fully
  rejected before).
- per-statement surrogate is well-defined only for single-row inserts (multi-row
  collides atomically — asserted, honest).
- `select * from <eav> where id = N` throws "No row context found" — a **get**-path
  issue untouched by this ticket (tests sidestep via `order by`). Pre-existing,
  out of scope; a candidate fix ticket if it bites, but not filed here as the read
  path is outside this diff and already noted in the handoff.

### Pre-existing test failure
The store-suite MV row-time failure the implementer flagged was already triaged and
fixed by the runner (commit ddc9071d, `quereus-isolation` / `quereus-store`);
`.pre-existing-error.md` is gone. Not re-run here (slow, already resolved).

## Validation
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — **4178 passing, 9 pending, 0 failing**
  (+3 review regression tests over the implement pass's 4175).
