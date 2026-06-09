description: Review the TableReference-site gate that stops CHECK-derived and assertion-hoist-derived bi-directional value-equality FDs (`{a}↔{b}`) from being folded onto a non-keyed table's physical FDs, closing the 5th (CHECK) and 6th (assertion-hoist) producers of the FD-derived-key bag-over-claim wrong-results bug. Mirrors the shipped filter-site gate (site 4) from `fd-derived-key-bag-overclaim`.
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts, packages/quereus/test/optimizer/binding-extractor.spec.ts, packages/quereus/test/optimizer/check-fold-gated-by-capability.spec.ts
----

## What changed

`TableReferenceNode.computePhysical` (`reference.ts`) previously folded **every**
`checkExt.fds` and `hoisted.fds` entry onto the node's physical FDs unconditionally. A
`check (a = b)` (or an equivalent hoisted `not exists (select 1 from T where a <> b)`)
emits the bi-directional determination FD `{a}↔{b}`. On a table with no declared key
covering an endpoint, that pair is read by `deriveKeysFromFds` as a phantom unique key
once a projection narrows the relation to the equality columns — `keysOf` reports the
body as a set and `rule-distinct-elimination` drops a REQUIRED DISTINCT, leaking
duplicate rows.

The fix adds a consumption-site gate, exactly mirroring the shipped filter gate
(`filter.ts:114-126`) and the join/project sites:

- A new module-local helper `foldGatedProducerFds(fds, producerFds, equivPairs, realKeyFds, colCount)`
  folds a producer's FDs but **skips** an unguarded single↔single FD `{a}→{b}` whose
  unordered pair `{a,b}` is in that producer's `equivPairs`, **unless**
  `isSuperkey([a]) || isSuperkey([b])` against `realKeyFds`. Everything else passes
  through unchanged: `∅→col` constant FDs, one-way `other→col` expression FDs
  (`check (b = a + 1)` ⇒ `a→b`, which carries no equiv pair), and guarded
  implication-form FDs.
- `realKeyFds` is captured as `const realKeyFds = fds;` immediately after the
  declared-key loop — an immutable snapshot of the PK/UNIQUE-derived FDs only (`addFd`
  never mutates its input). Both `checkExt.fds` (probing `checkExt.equivPairs`) and
  `hoisted.fds` (probing `hoisted.equivPairs`) are folded through the gate against this
  shared probe.
- The EC merge stays **unconditional** (value-equality is always sound and ECs are not
  read by `keysOf`), and the checkExt-before-hoisted folding order is preserved (so
  structurally-identical entries keep `declared-check` provenance).

### Why `equivPairs` is the exact bi-pair signal

`handleEquality` (`check-extraction.ts:172-178`) pushes an equiv pair **iff** both sides
are columns (`col = col`) — the same branch that emits both `{a}→{b}` and `{b}→{a}`. So
bi-FD ⟺ equiv-pair membership, 1:1, for both the CHECK and (via the shared
`extractCheckConstraints`) the assertion-hoist path. A one-way expression FD
(`b = a + 1`) and the `∅→col` constant FDs never get an equiv pair, so they are never
gated. Verified `negateAst('a <> b') → 'a = b'`, so the hoisted synthetic check drives
`handleEquality`'s col=col branch and the equiv pair is present for the hoisted shape.

## Use cases / validation

End-to-end repros + controls added to `test/fd-derived-key-bag-overclaim.spec.ts` as
sites 5 and 6 (the suite already had sites 1–4 for the prior ticket):

- **Site 5 (CHECK), repro:** `create table tc (a,b,c, check (a=b))` (no PK);
  `select distinct a, b from tc` over data `(1,1,10),(1,1,20),(2,2,30)` → DISTINCT
  survives, **2 rows** (was 3, wrong).
- **Site 5 control:** `a integer primary key` ⇒ `{a,b}` is a real key ⇒ DISTINCT
  eliminated.
- **Site 6 (assertion-hoist), repro:** `create assertion eq_ab check (not exists (select 1 from ta where a <> b))`
  over a no-PK `ta` ⇒ `select distinct a, b from ta` → **2 rows**, DISTINCT survives.
- **Site 6 control:** `a integer primary key` ⇒ DISTINCT eliminated.

Goldens updated (both asserted the *old over-claiming* behavior on **non-keyed** tables;
updated to the gated expectation with explanatory comments):

- `binding-extractor.spec.ts` — "emits 'row' …": `t(a,b) CHECK(a=b)` no longer derives the
  sub-PK key `[0]`; binding falls back to the implicit all-columns key `[0,1]`. (Dropping
  is sound: `{a}` was unique there only because the all-columns key co-held, but the FD
  would survive a projection that strips it — the bug.)
- `check-fold-gated-by-capability.spec.ts` — "default … equality CHECK (a = b) DOES lift":
  re-pointed at the **EC** `{a,b}` (which lifts unconditionally and is still suppressed by
  the `permitsGrandfatheredCheckViolators` cap), and now asserts the bi-FD is gated for
  the non-keyed table. The capability-gate intent is preserved via the EC surface; the
  bi-FD can no longer be the witness because the only PK-free way to produce a↔b FDs from
  the CHECK is precisely the over-claim.

Regression guard confirmed: `check (b = a + 1)` still exposes the one-way `a → b` FD at
the TableReference (`check-derived-fds.spec.ts:275`, both the unit and end-to-end tests
pass unchanged).

Commands run:
- `yarn workspace @quereus/quereus test` (full memory-backed suite): **5517 passing, 9
  pending, 0 failing**. The `property.spec.ts` Key Soundness over-claim differential (the
  wrong-results catcher the ticket called out) passes.
- `yarn lint` (quereus): clean.
- Did NOT run `test:store` (no store-specific change; the gate is pure planner logic).

## Known gaps / for the reviewer

1. **A 7th producer of the SAME bug class is confirmed-real and NOT fixed here** — filed
   as `tickets/fix/fd-guarded-activation-key-bag-overclaim.md`. An implication-form CHECK
   `check (status <> 'active' or a = b)` emits *guarded* `{a}↔{b}` FDs; `FilterNode`
   activation (`activateGuardedFds` → `stripGuard`) drops the guard when the predicate
   entails it **without re-gating against keys**, so `select distinct a, b from t where
   status='active'` returns 3 rows instead of 2 (DISTINCT eliminated). Reproduced with a
   throwaway spec during implement (then deleted). The filter site's existing gate only
   covers predicate-derived FDs, not activated/inherited ones. This is out of scope for
   the TableReference fix (different node, different code path) — the fix ticket has the
   full mechanism, the repro+control, and a fix direction. The reviewer should NOT try to
   fold it in here; verify the ticket is accurate and let it flow.

2. **`isUnique` closure branch** (`fd-utils.ts:840`) is the soundness-critical reader that
   converts a leaked FD into an eliminated DISTINCT. It is left unchanged — the fix keeps
   the over-claim out of the FD set at the producer, so the reader stays sound by
   construction for the table-reference path. (The guarded-activation path in gap 1 is the
   one place a leaked FD still reaches it.)

3. **Test altitude:** the new site 5/6 tests assert DISTINCT-node presence + materialized
   row counts (the wrong-results floor). They do not directly assert the TableReference
   physical FD set shape; the `check-fold-gated-by-capability` golden covers that surface.
   A reviewer wanting belt-and-suspenders could add a `query_plan(...)` assertion that the
   3-col non-keyed TableReference omits the `{a}↔{b}` FDs.

4. **Gate scope is intentionally narrow:** only unguarded single↔single FDs whose pair is
   in `equivPairs`. If a future producer emits a bi-directional value-equality as a
   *multi-column* determination or without an equiv pair, this gate would not catch it.
   Not a concern for the current producers (verified 1:1 with equiv pairs), but worth a
   sanity check if the reviewer knows of other `getCheckExtraction` callers.
