description: n-way `get` synthesis for advertisement-backed logical tables — left-deep join skeleton, key-equi-join (incl. singleton `on 1 = 1`), EAV correlated-subquery pivot, surrogate equi-join, advertisement-driven override gap-fill, provenance, and the read-correct/write-rejected boundary. Reviewed + landed.
files: packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/test/lens-advertisement.spec.ts, packages/quereus/test/logic/51-lens-foundation.sqllogic, docs/lens.md
----

## What landed

The default mapper consumes a resolved primary-storage `MappingAdvertisement` to
synthesize the n-way **`get`** read body (an ordinary `SelectStmt` registered as a
`ViewSchema` — zero new runtime). A no-override table with a resolved
`slot.advertisement` routes to `compileDecompositionBody`; override tables gap-fill
uncovered columns from the advertisement via the shared `resolveAdvertisedColumn`.

Read direction only: a join body is not a single-source updatable projection, so
view-updateability rejects DML through it (`put` fan-out + IND injection are the
sibling tickets `lens-multi-source-put-fanout` / `lens-multi-source-ind-injection`).

See the implement-stage commit `5beeb4ac` and `docs/lens.md` § The Default Mapper for
the full design (left-deep anchor-first equi-join, inner/outer per `presence`,
`on 1 = 1` singleton, EAV correlated scalar subqueries, surrogate positional pairing,
provenance consistency with `annotateProvenanceWithAdvertisement`).

## Review findings

**Method.** Read the implement diff (`lens-compiler.ts` +394, the spec, the sqllogic
case, and the docs) with fresh eyes before the handoff summary, then probed the two
highest-risk behaviors the implementer flagged with scratch tests, then ran build +
lint + the full suite.

### Checked — and verified correct

- **Optional-component preservation** (the load-bearing property). `presence ===
  'mandatory' ? 'inner' : 'left'` is correct; the existing test confirms an
  anchor-only row survives with the optional column null.
- **Outer-join survival under a filter** (the implementer's flagged "highest-value
  addition"). Verified the optimizer does *not* rewrite the synthesized `left join`
  to inner under a non-null-rejecting predicate: `where maxSpeed is null` preserves
  the anchor-only row; `where maxSpeed = 180` (null-rejecting) correctly excludes it.
  **Added a regression test** pinning both directions.
- **Write-rejection of the multi-source body** (the implementer noted no test pinned
  it). Verified insert/update/delete all error (`view body operator 'Join' is not
  updateable`). **Added a regression test** covering all three DML directions so a
  future change can't silently present a multi-source table as writable.
- **Singleton `on 1 = 1`** — empty per-member key → vacuously-true literal; the
  existing test asserts the AST shape and 0/1-row cardinality across anchor-only /
  anchor+kv / no-anchor. Sound.
- **EAV correlated subquery / surrogate positional pairing / provenance consistency**
  — existing tests adequate; `resolveAdvertisedColumn` precedence (explicit mapping →
  sole EAV → name-match) matches `annotateProvenanceWithAdvertisement`'s order.
- **`requalifyColumnRefs`** — only rewrites `column` nodes' `table`/`schema`; safe
  because `validatePrimaryAdvertisement` already rejects a `basisExpr` referencing a
  column absent from its member relation, so a basisExpr can only reference its own
  member's columns.
- **`AND` operator casing** — uppercase, matching the codebase-wide convention.
- **Docs** — read the full `docs/lens.md` diff; accurate and reflects shipped reality.

### Found — fixed inline (minor)

- **Surrogate per-member key arity was unvalidated** (implementer noted, deferred).
  A malformed surrogate advertisement with mismatched per-member arity would silently
  under-join (`buildKeyEquiJoin` pairs by `Math.min`) rather than error — silent wrong
  results, not a clean failure. The `logical-tuple` path already validates arity
  against the PK; **added the symmetric check** for `surrogate` (every member's key
  arity must equal the anchor's) in `validatePrimaryAdvertisement`, with a test. This
  is a deploy-time validation (no behavior change for well-formed input).
- **EAV attribute-literal case-sensitivity** (implementer flagged for a doc note).
  Confirmed: a logical column `Nick` against a lowercase `nick` triple reads **null**
  (the attribute literal is compared by value equality, not case-folded). **Added a
  doc note** to `docs/lens.md` documenting the contract.
- **Two regression tests** (write-rejection, outer-join-under-filter) as above.

### Found — left as-is (low risk; belongs to a sibling/deferred ticket)

- **Cross-schema members untested.** Couldn't exercise (no `create schema` DDL; basis
  advertisement collection only scans the basis schema's modules). Matches the
  implementer's low-risk note. No filing — the resolver already resolves cross-schema
  members; this is a coverage gap, not a known defect.
- **Composite-key EAV.** `eavAnchor` uses only `anchorKeys[0]`, and a keyless
  (singleton) anchor + EAV member can't correlate (falls to name-match / errors). A
  latent corner; EAV entities are single-column in practice. Naturally in scope for
  the put/IND work that exercises EAV writes.
- **Multi-EAV-member decomposition.** Only a *sole* EAV member is pivoted (matches
  `annotateProvenanceWithAdvertisement`'s `soleEav`). Consistent with existing
  annotation behavior.
- **name-match validation vs synthesis inconsistency.** `validatePrimaryAdvertisement`
  admits a column via a basis table *named like the logical table*, while
  `nameMatchAgainstMembers` matches against *join members*. A column passing validation
  via a logically-named non-member basis table would throw at synthesis. Extremely
  unusual (a decomposition has no table named like the logical table), and the failure
  is a precise deploy-time error, not wrong data — not worth special-casing.

No findings rose to "major" / required a new ticket: every deferred item is either a
documented contract or naturally owned by the pending sibling tickets
(`lens-multi-source-put-fanout`, `lens-multi-source-ind-injection`).

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean (0 TS errors).
- `yarn workspace @quereus/quereus run lint` — clean.
- `lens-advertisement.spec.ts` — 25 passing (was 22; +3 review-added tests:
  surrogate-arity validation, multi-source write-rejection, outer-join-under-filter).
- Full `yarn workspace @quereus/quereus test` — **4078 passing, 9 pending** (was
  4075/9; +3 new tests, no regressions).
