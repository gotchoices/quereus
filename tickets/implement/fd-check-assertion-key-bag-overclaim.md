description: Gate the CHECK-derived and assertion-hoist-derived bi-directional determination FD `{a}↔{b}` at the `TableReferenceNode` consumption site so it is folded onto the node's physical FDs only when one endpoint is a genuine declared key. This closes the fifth (CHECK) and sixth (assertion-hoist) producers of the FD-derived-key bag-over-claim wrong-results bug — the same class fixed for four producers in ticket `fd-derived-key-bag-overclaim`, mirroring its filter site (site 4).
prereq:
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/src/planner/analysis/assertion-hoist-cache.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/check-derived-fds.spec.ts
----

## Confirmed bug (wrong results)

```sql
create table tc (a integer, b integer, c integer, check (a = b));
insert into tc values (1,1,10),(1,1,20),(2,2,30);
select distinct a, b from tc;   -- RETURNS 3 rows; CORRECT answer is 2
```

Reproduced during the fix stage: the `DistinctNode` is eliminated (count 0) and the
query returns 3 rows instead of 2.

### Mechanism (verified)

`check (a = b)` makes `getCheckExtraction(tc)` emit the bi-directional determination
FDs `{a}→{b}` and `{b}→{a}` plus the equiv pair `[a,b]` (`handleEquality` in
`check-extraction.ts:161`). `TableReferenceNode.computePhysical`
(`reference.ts:143-145`) folds **every** `checkExt.fds` entry onto the node's physical
FDs unconditionally; the assertion-hoist path (`reference.ts:164-166`,
`getAssertionHoistedConstraints`) does the same for `hoisted.fds`.

`tc` has no declared PK, so its only key is the implicit all-columns key `{a,b,c}` —
`superkeyToFd` returns `undefined` for an all-columns key, so the declared-key FD set is
**empty**. At the 3-column TableReference, `closure({a}) = {a,b} ≠ all 3 cols`, so the
over-claim does **not** yet surface there. It surfaces after `select a, b` projects away
`c`: `projectFds` carries `{a}↔{b}` onto the 2-column output, where now
`closure({a}) = {a,b} = all cols`. `deriveKeysFromFds` reads `{a}` as a unique key,
`keysOf` reports the body as a set, and `rule-distinct-elimination` drops the REQUIRED
DISTINCT — leaking the duplicate `(1,1)` row.

A 2-column base table does not exhibit this: the implicit all-columns key forbids
duplicate full rows, so the bug hides until a column is projected away. The
assertion-hoist path hoists `create assertion … not exists (select 1 from T where a <> b)`
into the identical `{a}↔{b}` FDs (sixth producer, same defect).

This is the same root cause and reader (`keysOf` → `deriveKeysFromFds`) as ticket
`fd-derived-key-bag-overclaim`; that ticket fixed the four producers it enumerated and
left the CHECK / assertion-hoist producers out of scope.

## Fix: gate at the TableReference consumption site (mirror filter site 4)

The shipped filter gate (`filter.ts:103-126`) is the exact pattern to mirror: fold a
two-column determination FD only when one endpoint is a genuine superkey of the source's
**real** keys (the FDs present **before** the equality FDs are added); keep the EC merge
unconditional. The join site (`join-utils.ts:289-310`) and project site
(`project-node.ts:248-261`) use the same discipline with a probe set built before the
loop mutates `fds`.

For the TableReference, `realKeyFds` is the FD set built from declared PK/UNIQUE keys —
i.e. the `fds` array as it stands **immediately after** the declared-key loop
(`reference.ts:115-125`), captured before any check / partial-unique / hoisted FD is
folded. `addFd` returns a fresh array and never mutates its input, so
`const realKeyFds = fds;` at that point is a valid immutable snapshot. `computeClosure`
(and therefore `isSuperkey`) skips guarded FDs (`fd-utils.ts:45`), so guarded
partial-unique FDs cannot pollute the probe even if present — but capturing right after
the declared-key loop keeps the probe to declared keys only and is cleanest.

Gate condition for a candidate FD `{a}→{b}` from a producer (`checkExt` or `hoisted`):
fold it only when
`isSuperkey(new Set([a]), realKeyFds, colCount) || isSuperkey(new Set([b]), realKeyFds, colCount)`.
`colCount` is the table's column count; `a`/`b` and the equiv-pair indices are all
table-column indices, so they are consistent.

### CRITICAL refinement — gate only the BI-DIRECTIONAL value-equality pair, not all single↔single FDs

Unlike the filter site (where `extractEqualityFds` only ever emits single↔single FDs as
`col=col` bidirectional pairs), the CHECK extractor **also** emits legitimate **one-way**
single↔single FDs for expression equalities: `check (b = a + 1)` produces a single
`{a}→{b}` FD (`handleEquality`, `check-extraction.ts:187-193`). The existing test
`check-derived-fds.spec.ts:275` ("table with check (b = a + 1): TableReference exposes
FD a → b") asserts this FD survives, and there `a` (col 1) is **not** a key. A blanket
single↔single gate would wrongly drop it and break that test.

So the gate must distinguish the over-claiming bi-directional pair from one-way
expression FDs. The producer's own `equivPairs` list is the exact 1:1 signal:
`handleEquality` pushes an equiv pair **only** for the `col = col` case (the bidirectional
pair), never for `col = literal` (∅→col) or `col = expr(otherCol)` (one-way). Therefore:

- Gate an **unguarded** FD `{a}→{b}` with `determinants.length === 1 && dependents.length === 1`
  **iff** the unordered pair `{a,b}` appears in that producer's `equivPairs`
  (`checkExt.equivPairs` for `checkExt.fds`; `hoisted.equivPairs` for `hoisted.fds`).
  Such gated pairs are folded only when an endpoint is a real key; otherwise dropped.
- The `∅ → col` constant FDs (`determinants.length === 0`), one-way `other → col`
  expression FDs (no matching equiv pair), and **guarded** FDs (implication-form check
  bodies — they carry a `guard` and never participate in key derivation until Filter
  activation) must all pass through **unchanged**.

(An equivalent signal is "the mirror FD `{b}→{a}` also exists in the same producer's fd
array"; the `equivPairs` check is preferred as it is the producer's authoritative
value-equality marker and won't accidentally gate a coincidental one-way mirror.)

### Constraints / contracts to preserve

- Keep the **EC merge unconditional** (`reference.ts:168-174`): value-equality is always
  sound, carries constant propagation, and ECs are not read by `keysOf` — same rationale
  as the four shipped sites.
- Apply the gate to **both** `checkExt.fds` and `hoisted.fds`, each against its own
  `equivPairs` and against the shared `realKeyFds` probe.
- Do **not** edit `extractCheckConstraints` / `walkConjunction` / `handleEquality` — they
  are shared with `assertion-hoist-cache.ts` and unit-tested directly
  (`check-derived-fds.spec.ts:69-77` asserts the raw bi-FD output). Gate at consumption,
  exactly as ticket 4 left `extractEqualityFds` untouched.
- Preserve the existing ordering/dedup contract (`reference.ts:156-160`): declared-check
  facts merge before assertion-hoist so structurally-identical entries keep
  `declared-check` provenance. The gate filters which FDs are folded but must not reorder
  the checkExt-before-hoisted folding.
- The `permitsGrandfatheredCheckViolators` path already substitutes `EMPTY_CHECK_EXTRACTION`
  for `checkExt`, so the gate naturally no-ops there (empty `fds`/`equivPairs`).

### Why the controls pass

- `tc` (no PK): `realKeyFds = []` ⇒ neither `a` nor `b` is a superkey ⇒ both `{a}↔{b}`
  FDs dropped ⇒ projection has no spurious key ⇒ DISTINCT survives ⇒ 2 rows. ✓
- `a` is PK: `realKeyFds = [{a}→{b,c}]` ⇒ `isSuperkey({a})` true ⇒ pair kept ⇒ `select a,b`
  projects `{a}→{b}` and the real key ⇒ `{a}` is a 2-col key ⇒ DISTINCT correctly
  eliminated. ✓

## Assertion-hoist repro shape

Canonical hoistable form (see `assertion-as-premise.spec.ts:274`,
`06.3.3-introspection-tags.sqllogic:201`):

```sql
create table ta (a integer, b integer, c integer);
create assertion eq_ab check (not exists (select 1 from ta where a <> b));
insert into ta values (1,1,10),(1,1,20),(2,2,30);
select distinct a, b from ta;   -- must return 2 rows once gated
```

`classifyAssertionForHoisting` extracts inner predicate `a <> b`; `negateAst` produces the
per-row synthetic check whose equality form drives `handleEquality` to the same bi-FD +
equiv-pair output. Confirm during implementation that the negation lands as a recognized
`=`/`==` equality (so `checkExt`-style `equivPairs` are produced for the hoisted path); if
the negated shape is `not (a <> b)` rather than `a = b`, verify `extractCheckConstraints`
still recognizes it and the `equivPairs` signal is present — adjust the gate's
bidirectional detection accordingly (fall back to the mirror-FD signal if no equiv pair is
emitted for the hoisted form).

## Untested adjacent concern to verify (flag, don't necessarily fix here)

The `isUnique` closure branch (`fd-utils.ts:840`,
`colSet.size < columnCount && isSuperkey(...)`) and the guarded-FD **activation** path
(`FilterNode.activateGuardedFds` strips a guard from an implication-form check FD without
re-gating) could in principle over-claim on activated check-derived bags for a
DISTINCT-after-filter query (`(¬g) OR (a=b)`-shaped check, filter entails `g`, then
`select distinct a,b`). This is a distinct path from the unguarded table-reference fix
here. Verify whether it actually produces wrong results; if it does, file a separate
fix/ ticket rather than expanding this one (the implementer of ticket 4 flagged the
closure branch as untested but believed unreached by the DISTINCT path).

## TODO

- In `reference.ts` `computePhysical`, capture `const realKeyFds = fds;` immediately after
  the declared-key loop (before the `checkExt.fds` fold).
- Add a small local helper (or inline loop) that folds a producer's `fds` with the gate:
  skip an unguarded single↔single FD `{a}→{b}` whose `{a,b}` is in that producer's
  `equivPairs` unless `isSuperkey([a]) || isSuperkey([b])` against `realKeyFds`/`colCount`;
  fold everything else (∅→col, one-way expr FDs, guarded FDs) unchanged.
- Apply the gate to both `checkExt.fds` (probe `checkExt.equivPairs`) and `hoisted.fds`
  (probe `hoisted.equivPairs`). Keep the EC merge and checkExt-before-hoisted ordering
  intact.
- Add end-to-end repros to `test/fd-derived-key-bag-overclaim.spec.ts` (extend the existing
  suite — sites 5 and 6):
  - site 5 (CHECK): `check (a=b)` 3-col DISTINCT repro must survive → 2 rows; control where
    `a` is the PK → DISTINCT eliminated.
  - site 6 (assertion-hoist): `not exists (select 1 from ta where a <> b)` repro → 2 rows;
    control where `a` is the PK → DISTINCT eliminated.
- Add a guard/regression test that `check (b = a + 1)` still exposes the one-way `a → b`
  FD at the TableReference (the existing `check-derived-fds.spec.ts:275` test must keep
  passing — confirm it does).
- Check for any plan/FD golden or propagation test (NOT the `extractCheckConstraints` unit
  test) asserting the TableReference physical FDs include the now-gated `{a}↔{b}` for a
  non-keyed table; update to the gated expectation with an explanatory comment. (Sweep
  `check-derived-fds.spec.ts`, `fd-propagation.spec.ts`, `keysof-isunique.spec.ts`,
  `covering-structure.spec.ts`, `property.spec.ts`.)
- Run `yarn workspace @quereus/quereus test` (the full quereus suite) and the
  distinct-elimination fuzz differential — this is a wrong-results bug, exactly the class
  that differential is meant to catch. Stream output with `Tee-Object` / `tee` per
  AGENTS.md.
- Run lint (`eslint`, single-quoted globs on Windows).
- Verify the `isUnique` closure branch / guarded-activation concern above; file a separate
  ticket if it reproduces wrong results.
