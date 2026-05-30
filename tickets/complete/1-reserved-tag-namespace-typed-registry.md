description: Typed registry for the reserved `quereus.*` tag namespace + PoC wiring into the lens-compile path. Additive, behavior-neutral infrastructure: validates shape + site of reserved tags (unknown / mis-sited / malformed → sited diagnostic), reads NO reserved tag's semantics. Single validation entry point, typed accessors, and the lens-ack PoC shipped; no `quereus.update.*` DML/view wiring (view-mutation Phase 2 owns that).
files: packages/quereus/src/schema/reserved-tags.ts (the registry), packages/quereus/src/schema/lens-compiler.ts (PoC wiring: validateLensTags + call in deployLogicalSchema), packages/quereus/test/schema/reserved-tags.spec.ts (31 unit cases), packages/quereus/test/logic/53-reserved-tags.sqllogic (end-to-end lens-ack), docs/view-updateability.md, docs/lens.md
----

## What shipped

A deeply-frozen, typed registry for the reserved `quereus.*` tag namespace, plus a proof-of-concept
wiring into `apply schema` for a logical schema. The namespace was previously consumed at ZERO code
sites and stored as untyped `Record<string, SqlValue>`; a typo (`quereus.update.taget`) silently
no-opped. The registry makes unknown / mis-sited / malformed reserved keys fail with a sited
diagnostic.

- **`reserved-tags.ts`** — `validateReservedTags(tags, site)` (policy-free, never throws; per key:
  non-`quereus.*` skipped, no spec → `unknown-reserved-tag`, wrong site → `tag-not-allowed-here`,
  bad value → `invalid-tag-value`; empty ack rationale is a **warning**, all other failures
  **errors**); `getReservedTag` (typed exact-key read) and `getReservedTagByTemplate` (enumerate
  `default_for.<col>` / `lens.ack.<code>` instances). `RESERVED_TAGS` — 7 frozen specs transcribed
  from the doc tables.
- **PoC wiring (`lens-compiler.ts`)** — `deployLogicalSchema` calls `validateLensTags(slot)` inside
  the compile-first loop (before catalog mutation, so a bad tag aborts atomically): validates the
  logical table's tags (`logical-table` site) and each constraint's tags (`logical-constraint`
  site). First error → `throw QuereusError`; warnings → `log(...)`.
- **Docs** — `docs/lens.md` and `docs/view-updateability.md` updated to point the `quereus.*`
  namespace at the typed registry as the single shape/site validation surface.

## How it was validated (review pass)

- `yarn workspace @quereus/quereus run build` — clean.
- Unit: `test/schema/reserved-tags.spec.ts` — **31 passing** (was 30; added a deep-freeze assertion).
- End-to-end: `test/logic/53-reserved-tags.sqllogic` via `logic.spec.ts` — **1 passing**.
- Regression: `test/schema/**`, `test/lens-foundation.spec.ts`, `test/schema-manager.spec.ts` —
  **117 passing**.
- `yarn workspace @quereus/quereus run lint` — clean (the pre-existing probe-file lint error noted
  at implement-handoff was already triaged + removed in commit a49c36cf; `.pre-existing-error.md`
  no longer exists and lint is green).

## Review findings

Read the implement diff (e4e6d0d0) with fresh eyes before the handoff summary, then scrutinized
shape/site/value logic, the template-matching, the lens-compile wiring against the actual
`LensSlot` / `LogicalConstraint` / constraint-`.tags` shapes, the apply-path routing, and the doc
citations. Lint + the unit / e2e / schema-regression suites were run and pass.

### Fixed inline (minor)

- **Stale doc-line citations.** The `quereus.update.*` specs cited `docs/view-updateability.md:274–278`,
  but the same-commit doc edit shifted that table down to lines **284–288** — the citations were
  already wrong at the moment of commit. Corrected each to its current line. (The `lens.md` citations
  166/169/176/190 and the delete_via context refs 165/220 were verified accurate and left as-is.)
- **Shallow "frozen" registry.** `RESERVED_TAGS` was only `Object.freeze`d at the array level; each
  spec object and its `sites` Set were still mutable (`RESERVED_TAGS[0].sites.add(...)` succeeded),
  and JS `Object.freeze` on a `Set` does **not** lock its contents — so the documented "frozen"
  claim and the `Object.isFrozen(RESERVED_TAGS)` test gave false confidence on a shared module
  singleton. Converted `ReservedTagSpec.sites` from `ReadonlySet<TagSite>` to a frozen
  `readonly TagSite[]` (membership via `includes`), and now deep-freeze the array **and** each spec
  entry. Strengthened the unit test to assert each spec and its `sites` are frozen. Verified
  empirically that `RESERVED_TAGS[0].sites.push(...)` now throws.

### Filed as new ticket (major)

- **`backlog/reconcile-reserved-tag-registry-with-schema-differ`** — the implementer's known gap #1.
  Two disjoint notions of "known `quereus.*` keys" now exist: the registry's 7-key/hard-error set on
  the lens path, and `schema-differ.ts`'s 2-key (`quereus.id`, `quereus.previous_name`)/soft-warn
  set on the physical path. Confirmed disjoint today (`emitApplySchema` routes a logical schema to
  `deployLogicalSchema` and never invokes `computeSchemaDiff`), so no current conflict — but once
  view-mutation Phase 2 makes `quereus.update.*` legal on a **physical** view/DML, a reserved-key
  typo there would only soft-warn (silent), reintroducing the exact silent-no-op the registry
  exists to kill. Reconciliation is a design decision (unify the key registries; settle severity +
  new physical `TagSite`s) → backlog, closely tied to Phase 2.

### Observed, not actioned (minor — documented for downstream)

- **Column-level tags are not validated in the lens path.** `validateLensTags` checks the logical
  table's tags and constraint tags, but not per-column tags (`ColumnSchema.tags`). There is no
  `column` `TagSite`, so a reserved key mistakenly placed on a column (e.g.
  `vin text with tags ("quereus.lens.ack.x" = '')`) silently escapes validation rather than being
  flagged. No reserved key is column-sited today, so this is harmless now; the completeness work
  that adds physical sites should decide whether a reserved key on a column is `tag-not-allowed-here`.

### Confirmed acceptable (implementer's documented gaps/decisions — no action)

- **`quereus.update.*` validated by the entry point but wired into no DML/view path** (gap #2) — by
  design; `view-mutation-plan-node-substrate` Phase 2 owns the real sites. Covered by the pure
  function's unit tests.
- **Warnings only `log(...)` (DEBUG-gated)** (gap #3) — no deploy-summary channel yet; `3-lens-prover`
  Phase C owns it. The sqllogic correctly asserts only that the empty-rationale deploy *succeeds*.
- **Rationale severity is lenient** (gap #4) — every `required-nonempty-rationale` failure (incl.
  non-text) is a warning, never a hard block, matching the doc intent "ack suppresses the warning
  only; never blocks." Deliberate; left as-is.
- **`csv-of-identifiers` token grammar is a heuristic** (gap #5) — not exercised by any wired path;
  refine when view-mutation consumes it.
- **Accessors trust the caller validated first** (gap #6) — documented contract; `getReservedTagByTemplate`
  coerces via `String(value)`. Consumers must `validateReservedTags` first.
- **PoC errors carry no line/column** (gap #7) — consistent with existing lens-compile `QuereusError`s;
  the tag AST has no per-key loc.

### Empty categories

- **No correctness bugs** found in the shipped validation/matching/accessor logic: template prefix
  matching (exact-before-template, empty-remainder → unknown), enum/CSV/rationale/string-expression
  value checks, and severity routing all behaved as specified and are covered by the 31 unit cases.
- **No regressions**: the wiring adds a pre-mutation throw path inside `deployLogicalSchema`; all
  117 existing schema/lens/schema-manager tests still pass, including tag-bearing lens and
  constraint-tag cases.

## Downstream consumers (documentation only)

- `3-lens-prover-and-constraint-attachment` Phase C — consumes `validateReservedTags` +
  `getReservedTagByTemplate` for its reserved-tag parser + escalation policy. Add this slug as a
  prereq when both are scheduled.
- `view-mutation-plan-node-substrate` Phase 2 — validates/reads `quereus.update.*` through this
  registry at the real DML/view sites; should also carry or depend on
  `reconcile-reserved-tag-registry-with-schema-differ`.
