description: Remove the redundant quereus.update.* routing tags (target / exclude / delete_via) AND the policy knob, now subsumed by per-row presence/membership columns (outer-join existence column + set-op membership columns). Retain only default_for (value supply, no column equivalent). Shrinks the override surface to one mechanism: predicates rule, presence columns route per-row explicitly, default_for supplies missing insert values.
prereq: outer-join-existence-column, set-op-membership-write
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/logic/53-reserved-tags.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md, docs/schema.md
----

## Why

The view-update model controlled write routing two ways: predicate-driven branch/side
dispatch, plus a `quereus.update.*` tag override surface. Once `outer-join-existence-column`
(join sides) and `set-op-membership-write` (set-op branches) land, **routing is expressible
as explicit, per-row, writable presence columns** — strictly more precise than a
statement-level tag and self-documenting in the data shape. The routing tags become a
redundant second way to say the same thing. Per the directive to "remove most of the tag
surface," this is a clean removal (the prereqs land their replacement surface; `docs/architecture.md`
§ "Don't worry about backwards compatibility yet" → no deprecation cycle), leaving **one**
override mechanism.

## Decisions resolved in the plan stage

**1. `quereus.update.policy` — REMOVE the knob; fix the predicate-honest `lenient` default.**
`policy` governed the *unspecified-case* default for an ambiguous multi-side delete (`strict`
= reject, `lenient` = fan out). Chosen disposition: **drop it, hardwire lenient.** Rationale:
the directive is "shrink to one mechanism," and a user who wants a *specific* deletion side now
names it precisely with a per-row presence/membership column — strictly better than the blunt
statement-level "reject any ambiguity" knob. `set-op-membership-write` already assumes lenient
is the only behavior and explicitly deferred this decision here. Dropping `policy` leaves
`default_for` as the **sole** retained `quereus.update.*` key — the cleanest end state.
*Tradeoff:* the ability to *forbid* lenient fan-out is lost; a project wanting that relies on
column non-exposure (lens shape) or names the side explicitly. Acceptable per "predicates rule;
presence columns state per-row routing explicitly."

**2. View-DDL-level blanket routing (`target` / `exclude` at view DDL) — confirmed acceptable to drop.**
A per-row column does not reproduce a blanket "this view only ever writes relation X"
restriction. Replacement: **column / shape non-exposure.** A view that does not project a
relation's columns (and does not expose its presence/membership column) has no path to write
that relation through the view — the lens shape *is* the blanket-restriction control. No
replacement tag is introduced.

**3. Migration.** All `target`/`exclude`/`delete_via`/`policy` tests are converted to their
presence-column / predicate-default equivalents (see Tests), not deleted — coverage is preserved.

## Scope

**Remove (routing — replaced by presence columns):** `quereus.update.target`,
`quereus.update.exclude`, `quereus.update.delete_via`, **and** `quereus.update.policy`.

**Retain:** `quereus.update.default_for.<column>` — supplies *values* for omitted insert
columns; orthogonal to routing, no column equivalent.

## What the removal touches (verified call sites)

- **Registry (`schema/reserved-tags.ts`)** — the single source of truth for `quereus.*`.
  Drop the four specs, the `DELETE_VIA_VALUES`/`DeleteViaValue` and
  `UPDATE_POLICY_VALUES`/`UpdatePolicyValue` exports, the two `TypedValueFor` branches, and the
  `'join'` / `'union-branch'` `TagSite` members + their `siteLabel` cases (no `validateReservedTags`
  call site ever passes those sites — confirmed; they existed only for the removed specs).
  Leave `'projection'` (reserved for the retained `default_for`). Update the `unknownReservedTag`
  suggestion string (it enumerates recognized keys). After removal, any `target`/`exclude`/
  `delete_via`/`policy` occurrence becomes the standard hard `unknown-reserved-tag` error with no
  other call-site edits (lens compiler / advertisement builder / differ all validate through here).

- **Override surface (`planner/mutation/mutation-tags.ts`)** — delete `readPolicy`,
  `readDeleteVia`, `readTargetNames`, `readExcludeNames`, the now-dead `hasRoutingTags` (defined,
  **never consumed** — confirmed), the `TARGET_KEY`/`EXCLUDE_KEY`/`DELETE_VIA_KEY`/`POLICY_KEY`
  consts, and the `DeleteViaValue`/`UpdatePolicyValue` imports. Keep `collectMutationTags`,
  `readDefaultFor`, `readCsvIdentifiers` (still used by `readDefaultFor`? no — only target/exclude
  used it; remove if it becomes unused), and the doc comment's "Effect" list (drop the routing
  mentions, keep `default_for`).

- **Consumption (`planner/mutation/multi-source.ts`)** — the *only* routing-tag consumer
  (single-source.ts uses only `readDefaultFor`; decomposition.ts reads no routing tags — both
  confirmed). Delete `applyTargetExclude` and `resolveDeleteViaSide` entirely. Simplify
  `chooseDeleteSides` to the predicate/FK truth only: candidates `[0,1]` → if an FK proves the
  child side, that single side; else fan out to both (the hardwired lenient default — no
  `readDeleteVia`, no `readPolicy`, no `applyTargetExclude`). In `decomposeUpdate`, drop the
  `applyTargetExclude`/`allowedSides` call and the per-assignment `tag-conflict` guard (each
  assignment routes to its owning side by lineage, unconditionally). Remove the
  `DeleteViaValue`/`readPolicy`/`readDeleteVia`/`readTargetNames`/`readExcludeNames` imports.

- **Diagnostics (`planner/mutation/mutation-diagnostic.ts`)** — remove the now-unemitted reason
  codes `'tag-target-not-found'`, `'tag-conflict'`, `'policy-strict-ambiguity'` from the union
  (verify no remaining emitter first; these were emitted only from the deleted multi-source
  routing code). Leave any `tag-default` provenance label untouched (it belongs to retained
  `default_for`, not a diagnostic reason).

- **Docs** — rewrite to the single override story (predicates rule; presence/membership columns
  state per-row routing; `default_for` supplies missing values):
  - `docs/view-updateability.md` § Tags: The Override Surface (lines ~254–280 — drop the
    target/exclude/delete_via/policy table rows, keep `default_for`; rewrite the "Tags compose"
    para around presence columns); § Inner Join — Deletes (~152–154, remove the
    target/exclude/delete_via/policy resolution narrative, keep FK-child default + lenient
    fan-out); § Set Operations — Deletes/Except/Intersect (~205, 213, the `delete_via`/
    `right_insert` mentions → membership-column equivalents); the diagnostic catalog line (~391)
    and the multi-source summary (~490, "delete_via=parent variant" → presence-column phrasing).
  - `docs/sql.md` — the Override-tags table + example block (~1307–1319): drop the routing rows,
    keep `default_for`; update the example to a `default_for` insert.
  - `docs/schema.md:365` — the mis-sited-key *example* uses `quereus.update.policy` on a table;
    swap it for a still-valid example (e.g. `quereus.update.default_for.x` on a `physical-table`).
  - `docs/lens.md` — grep returned no routing-tag references; confirm none crept in.

## Expected end state

- A `quereus.update.target` / `exclude` / `delete_via` / `policy` tag anywhere is an
  `unknown-reserved-tag` hard error (registry-level), at any site.
- Every routing outcome those tags expressed is reachable via an existence/membership column
  (or is the documented predicate-honest default: FK-child for a provable FK, else lenient
  fan-out for a join delete).
- `default_for` is the only retained `quereus.update.*` key, documented as such.
- No remaining reference to the removed keys in `src/`, `test/`, `docs/`, or sample schemas.

## Tests

Convert (do not delete) the existing coverage:

- **`test/property.spec.ts` Family B** (lines ~3267–3357: `delete_via=parent` deterministic +
  fuzzed): the join-delete-routes-to-FK-parent behavior is no longer a tag. Re-express as the
  predicate/FK default + an explicit presence-column route where a non-default side is wanted
  (the outer-join existence column from `outer-join-existence-column`). The shared-parent fuzz
  invariant (deleting the parent hides all its dependents) is preserved via the equivalent
  existence-column write or the FK-child-default delete, per which side the test now exercises.
- **`test/logic/93.4-view-mutation.sqllogic`** (~706, 945–1116: target/exclude/delete_via/policy
  join-delete cases): convert each to its presence-column equivalent or the predicate default;
  the `policy='strict'` ambiguity-reject cases (~722, 1061–1077) are **removed** (lenient is now
  unconditional) — replace with the lenient fan-out assertion or an explicit presence-column
  route. The `right_insert`/`tag-conflict` join cases (~1102–1116) drop with `delete_via`.
- **`test/schema/reserved-tags.spec.ts`** (~25, 65–122, 170–296): every assertion that the
  removed keys are *accepted* at a site flips to expecting `unknown-reserved-tag`; the
  `getReservedTag('quereus.update.policy')` typed-read tests are removed; keep/extend the
  `default_for` acceptance tests. Add: each removed key raises `unknown-reserved-tag` at
  `view-ddl` and `dml-stmt`.
- **`test/schema-differ.spec.ts`** (~267–269): the "accepts `quereus.update.policy` on a declared
  view" test inverts to expecting the unknown-tag error (or is repointed at `default_for`).
- **`test/logic/53-reserved-tags.sqllogic`** (~45–52): the `policy='strict'` view-DDL case now
  errors; convert to a `default_for` legal-site case or assert the unknown-tag diagnostic.
- **Registry-level:** a removed-key occurrence raises the `unknown-reserved-tag` diagnostic at
  every site (the standard hard error), and the View Round-Trip Laws families that previously
  exercised `delete_via` (multi-source delete, `except` right-insert, `intersect` single-side)
  pass via their presence-column equivalents (delivered by the two prereq tickets).

## TODO

### Phase 1 — registry
- Remove the four specs (`target`, `exclude`, `delete_via`, `policy`) from `RESERVED_TAG_SPECS`.
- Remove `DELETE_VIA_VALUES`/`DeleteViaValue`, `UPDATE_POLICY_VALUES`/`UpdatePolicyValue`, the two
  `TypedValueFor` branches, the `'join'`/`'union-branch'` `TagSite` members + `siteLabel` cases.
- Update the `unknownReservedTag` suggestion string and the module doc header (lines 9–12).

### Phase 2 — override surface + consumers
- `mutation-tags.ts`: delete `readPolicy`/`readDeleteVia`/`readTargetNames`/`readExcludeNames`/
  `hasRoutingTags` + the four key consts + dead imports; trim `readCsvIdentifiers` if now unused;
  fix the doc-comment Effect list.
- `multi-source.ts`: delete `applyTargetExclude` + `resolveDeleteViaSide`; simplify
  `chooseDeleteSides` to FK-child-default-else-fan-out; strip the `allowedSides` guard from
  `decomposeUpdate`; remove dead imports.
- `mutation-diagnostic.ts`: remove `tag-target-not-found`/`tag-conflict`/`policy-strict-ambiguity`
  reason codes (after confirming no remaining emitter).

### Phase 3 — docs
- Rewrite `view-updateability.md` § Tags + the per-operator (Inner Join delete, Set Operations,
  Except, Intersect) and catalog/summary references; `sql.md` override-tags table/example;
  `schema.md:365` example; confirm `lens.md` clean.

### Phase 4 — tests + gate
- Convert/remove the test cases listed under Tests.
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`
- `yarn workspace @quereus/quereus lint`
- Final sweep: `grep -rn "update\.target\|update\.exclude\|delete_via\|update\.policy" src test docs`
  returns nothing (outside this ticket's own prose) — the expected-end-state gate.
