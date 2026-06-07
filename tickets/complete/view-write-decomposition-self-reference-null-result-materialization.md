description: Decomposition optional-columnar UPDATE classified `self` (every value leaf is the owning member's own column) was matched-update-only — the materialize INSERT was suppressed on the assumption that an absent row "has no prior value to transform, so stays absent". That holds only for **null-propagating** self-expressions (`c + 1` → null on an absent row); a self-expression that maps null → non-null (`coalesce(c, 0) + 1`) should materialize the absent row, and the suppression silently dropped that write. Fixed: `emitOptionalMemberUpdate`'s `hasSelf` branch now keeps the matched UPDATE for present rows **and** adds a materialize INSERT for absent rows that projects the self-expression with the owner's own columns substituted to NULL, filters to a non-empty image (so null-propagating expressions create no phantom row), and cedes matched rows via `on conflict (<memberKey>) do nothing`.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/property.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped

`emitOptionalMemberUpdate`'s `hasSelf` branch (decomposition.ts) emits **two** ops instead of one:

1. The matched UPDATE over present rows (real prior member value, owner qualifier stripped) — unchanged.
2. A new `buildSelfMaterializeInsertSelect` materialize INSERT for absent rows that:
   - projects each cell's value with the owner's own column refs substituted by a NULL literal
     (`substituteOwnerColumnsWithNull`) — an absent row's prior member value is null;
   - threads `<anchorKey>` into `<memberKey>` over the anchor scan (like the constant/anchor insert-selects);
   - filters to a non-empty image (`where <pred> and (<v1> is not null or <v2> is not null …)`) over
     the null-substituted values — a null-propagating self-expression yields a constant-false filter
     (no phantom row); a null→non-null one is constant-true (materializes);
   - uses `on conflict (<memberKey>) do nothing` to cede present rows to the matched UPDATE (which
     runs first — `drainBaseOps` executes base ops in push order, sequentially);
   - reuses the two soundness gates of the constant/anchor path — the unassigned-value-column widen
     guard (extracted to the shared `assertNoUnassignedValueColumnWiden` helper) and `assertNoMissingNotNull`.

The `self` classifier (`lowerMaterializedValue`) is unchanged — the materialize is gated at runtime
by the non-empty filter, not by narrowing the classifier. Prose updated in decomposition.ts,
docs/lens.md, docs/view-updateability.md.

## Review findings

**Adversarial pass over the implement diff (`13c0cd48`). Verdict: implementation is correct and
sound; one conservative-reject capability regression filed as backlog; coverage floor is strong with
a few low-risk untested compositions noted.**

### Verified correct (checked, found sound)

- **Op order is load-bearing and honored.** The matched UPDATE *must* precede the materialize INSERT
  (else the INSERT would materialize an absent row, which the UPDATE's `<memberKey> in (<anchor
  subquery>)` would then re-match and double-apply). Confirmed end-to-end: `emitOptionalMemberUpdate`
  pushes UPDATE-then-INSERT; `runtime/emit/view-mutation.ts` `drainBaseOps` runs base ops
  **sequentially in list order, awaiting each** (this sequencing is explicitly documented as
  load-bearing there); and `ViewMutationNode.withChildren` slices children in order, so the optimizer
  cannot reorder a member's ops. No double-apply path exists.
- **AST node shapes are valid.** The `IS NOT NULL` filter uses `{ type: 'unary', operator: 'IS NOT
  NULL', expr }` — matches `parser.ts:1343` and is handled by `runtime/emit/unary.ts`. The null
  substitution uses `{ type: 'literal', value: null }` — the canonical null-literal shape used
  throughout the builders.
- **Non-empty filter logic is sound across cell compositions.** Reasoned through: pure
  null-propagating self (no row); null→non-null self (materializes); self + non-null constant sibling
  (materializes `(null, value)`); two self cells with mixed propagation (per-cell null-substitution +
  OR filter → `(null, 1)`); self + explicit-null constant (no row). After null-substitution every self
  cell loses all column refs, so the filter is a true constant — either all pred-matching absent rows
  materialize or none do, which is exactly right for a self-expression. `IS NOT NULL` is two-valued, so
  the OR-chain never goes unknown.
- **Two ops, not an upsert** — the rationale holds: the matched value is computed over the member
  scan (real prior `c`) while the materialize value is computed over the null-substituted anchor scan;
  they disagree row-for-row, so `do update set c = excluded.c` would feed matched rows the
  null-substituted value. The `do nothing` + separate UPDATE is required.
- **Shared widen guard** (`assertNoUnassignedValueColumnWiden`) is a clean, behavior-preserving DRY
  extraction — the constant-path body and the new self-path body are byte-identical to the inlined
  original; both builders also call `assertNoMissingNotNull` at their target-column site.
- **Lint + tests green.** `eslint` clean. Full `@quereus/quereus` suite: **5034 passing, 9 pending, 0
  failing**. lens-put-fanout.spec.ts (91 passing) and property.spec.ts (153 passing) — including the
  new `update-c-coalesce-self` PutGet oracle arm — verified individually. No pre-existing failures
  surfaced; no `.pre-existing-error.md` written.

### Test coverage (starting point assessed; happy path, edges, errors, regression, interactions)

- **Happy path / edges / regression** — well covered by the 8 new lens-put-fanout tests
  (null-propagating `c + 1` regression pin; `coalesce(c,0)+1`; `iif`/`case` else-non-null; self +
  non-null-constant sibling; two self cells mixed propagation; present-but-null matched arm) plus the
  fuzzed `update-c-coalesce-self` oracle arm (numRuns 100) covering the absent-materialize transition
  the null-propagating `update-c-self` arm cannot reach. Oracle `(cMap.has(K) ? cMap.get(K) : 0) + 1`
  matches the implementation exactly.
- **Error path** — the partial-self-update widen reject is pinned (`/silently widening|base default/`,
  asserts atomicity via `count(*) = 0`).
- **Low-risk untested compositions** (flagged, no action — sound by construction, compose with the
  already-tested constant/anchor paths): surrogate-keyed (distinctly-spelled member key)
  self-materialize; a no-`WHERE` self-update (`pred` undefined → `combineAnd` returns the bare filter);
  RETURNING through a self-materialize (the re-query path reads post-mutation state after the same
  ordered base ops). None change the new code's logic; all reuse threading already exercised elsewhere.

### Finding — conservative-reject capability regression (MAJOR → filed backlog)

A **null-propagating** partial self-update that leaves a NOT-NULL / non-null-defaulted sibling value
column unassigned (`set e1 = e1 + 1` on a member whose `e2` carries `default 7`) now **rejects** at
plan time via `assertNoUnassignedValueColumnWiden` (and the `assertNoMissingNotNull` analogue), even
though its materialize filter folds constant-false and therefore can never materialize an absent row,
hence can never widen anything. The pre-materialize matched-update-only path called neither gate and
silently accepted these writes (present rows updated, absent untouched) — so this is a real behavior
regression. It is **sound** (never wrong data) and was a deliberate, documented, test-pinned tradeoff
at implement time (the planner could not cheaply distinguish `e1 + 1` from `coalesce(e1, 0) + 1`).

Disposition: a self cell's null-substituted value has no column refs (the classifier guarantees it),
so it is a plan-time constant — the materialize's non-empty filter *can* be folded statically to
decide whether the INSERT is dead, recovering the previously-working null-propagating case without
giving up soundness. That is a bounded enhancement, not a same-pass fix (it needs deterministic
constant-folding of the filter and a test flip), so filed as backlog
`view-write-decomposition-self-update-conservative-widen-reject` rather than fixed inline. The current
reject is the correct conservative floor until then.

### Docs

Read every changed doc against the new reality: `docs/lens.md` (§ The Default Mapper UPDATE bullet,
Current limitations) and `docs/view-updateability.md` (LEFT-deferred note, decomposition fan-out test
summary) all accurately describe the two-op self path, the null-substitution, the runtime non-empty
filter, and the null-propagating-vs-null→non-null distinction. In-file doc blocks (file header,
`ValueKind`, `lowerMaterializedValue`, `emitOptionalMemberUpdate`, `buildSelfMaterializeInsertSelect`,
`substituteOwnerColumnsWithNull`) are consistent with the code. No doc drift found.

### Adjacent behavior (unchanged, confirmed still rejecting)

`hasAnchor && hasSelf` mixed groups and EAV self-references (which lower to a subquery → `arbitrary`)
still reject. Existing tests for those still pass.

## Validation

`yarn workspace @quereus/quereus lint` → clean.
Full suite (`node test-runner.mjs`) → **5034 passing, 9 pending, 0 failing**.
lens-put-fanout.spec.ts → 91 passing; property.spec.ts → 153 passing.
