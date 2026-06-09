description: Seal the final FD bag-as-set over-claim producer — guard activation in FilterNode. When `activateGuardedFds` strips a guard off an implication-form CHECK's value-equality body (`{a}↔{b} [guard]` → unconditional `{a}↔{b}`), gate the folded determination on endpoint-superkey-ness against the filter's input keys, and lift the value-equality as an EC instead. Fix verified end-to-end during the fix stage (repro + control + full FD suites pass).
prereq:
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/conditional-fds.spec.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts
----

## Summary

`FilterNode.computePhysical` activates a guarded FD `{a}→{b} [guard=g]` (from an
implication-form CHECK like `status <> 'active' or a = b`) by stripping its guard
the moment the filter predicate entails `g`. It does NOT re-gate the now-unguarded
**bi-directional** value-equality pair `{a}↔{b}` against the filter's real keys. The
filter's existing site-4 gate (`fd-derived-key-bag-overclaim`) covers only
predicate-derived FDs (`extractEqualityFds` output), not FDs activated from the
source. So the activated `{a}↔{b}` flows up unguarded; a subsequent key-dropping
projection (`select distinct a, b`) makes `{a}` an all-columns-covering FD on the
narrow output, `deriveKeysFromFds` reads it as a unique key, and
`rule-distinct-elimination` drops the REQUIRED DISTINCT — leaking duplicate rows.

This is **site 7 (guarded activation)** — the last unsealed producer in the
bag-as-set over-claim class (sites 1–4 `fd-derived-key-bag-overclaim`; sites 5–6
`fd-check-assertion-key-bag-overclaim`).

### Confirmed repro (wrong results — verified during fix stage)

```sql
create table t (id integer primary key, a integer, b integer, status text,
    check (status <> 'active' or a = b));
insert into t values (1, 5, 5, 'active'), (2, 5, 5, 'active'), (3, 7, 7, 'active');
select distinct a, b from t where status = 'active';
--   BUGGY: 3 rows (5,5),(5,5),(7,7)  — DISTINCT eliminated
--   CORRECT: 2 rows (5,5),(7,7)
```

Mechanism is exactly as the fix ticket described and was reproduced: `findNodes(plan,
DistinctNode).length === 0` and rowCount === 3 before the fix.

## Verified fix (this exact diff was prototyped and passed all suites)

The Filter is the **only** guard-activation site (confirmed: `activateGuardedFds` /
`predicateImpliesGuard` / `stripGuard` are referenced only in `filter.ts`; joins
propagate guarded FDs unchanged via `shiftFds`/`propagateJoinFds` and never strip a
guard). No parallel join gate is needed.

The principled fix mirrors the table-reference gate at site 5: **gate the bi-FD but
lift the value-equality as an EC** (ECs are never read by `keysOf`, so they preserve
the fact without the over-claim). `recognizeGuardedBody` emits no equiv pair for a
guarded body, so the bi-pair is detected **structurally** — two guarded single↔single
mirror FDs (`{a}→{b}` + `{b}→{a}`) sharing a guard (via the existing `guardsEqual`).

### Edit 1 — `fd-utils.ts`: export `guardsEqual`

It is currently a private helper (defined ~line 138, used by `fdsEqual`). Add `export`:

```ts
export function guardsEqual(a: GuardPredicate | undefined, b: GuardPredicate | undefined): boolean {
```

### Edit 2 — `filter.ts`: import `guardsEqual`

Add `guardsEqual` to the existing `fd-utils.js` import (alongside `isSuperkey`,
`mergeEquivClasses`, `predicateImpliesGuard`, `stripGuard`, `closeConstantBindingsOverEcs`,
all already imported).

### Edit 3 — `filter.ts` `computePhysical`: make `constantBindings` reassignable + pass colCount + merge activated ECs

`constantBindings` is currently `const` (line 79). Change to `let`:

```ts
let constantBindings = closeConstantBindingsOverEcs(mergedBindings, equivClasses);
```

Replace the `activateGuardedFds(...)` call (lines 93–101) and the `let fds = ...`
assignment with:

```ts
const activation = activateGuardedFds(
    sourcePhysical?.fds ?? [],
    this.predicate,
    equivClasses,
    constantBindings,
    attrIdToIndex,
    isColumnNonNullable,
    isColumnNumeric,
    sourceAttrs.length,
);
let fds: ReadonlyArray<FunctionalDependency> = activation.fds;
// A value-equality body activated by the guard contributes its equality as an EC
// unconditionally (sound regardless of key-ness, and not read by `keysOf`),
// mirroring the table-reference gate. Re-close bindings over the enlarged EC set.
if (activation.activatedEquivPairs.length > 0) {
    equivClasses = mergeEquivClasses(equivClasses, activation.activatedEquivPairs);
    constantBindings = closeConstantBindingsOverEcs(constantBindings, equivClasses);
}
```

(The downstream site-4 `predFds` loop already recomputes `inputFds`/`colCount` from
`sourcePhysical?.fds`/`sourceAttrs.length`; leave it untouched.)

### Edit 4 — `filter.ts`: rewrite `activateGuardedFds`

```ts
function activateGuardedFds(
    sourceFds: ReadonlyArray<FunctionalDependency>,
    predicate: ScalarPlanNode,
    ecs: ReadonlyArray<ReadonlyArray<number>>,
    bindings: ReadonlyArray<ConstantBinding>,
    attrIdToIndex: ReadonlyMap<number, number>,
    isColumnNonNullable: (col: number) => boolean,
    isColumnNumeric: (col: number) => boolean,
    colCount: number,
): { fds: FunctionalDependency[]; activatedEquivPairs: Array<[number, number]> } {
    // Identify mirror bi-pairs among the guarded single↔single FDs: a guarded
    // value-equality body `a = b` emits BOTH `{a}→{b} [g]` and `{b}→{a} [g]`
    // with the same guard (recognizeGuardedBody). When activation strips the
    // guard, that unconditional `{a}↔{b}` pair is a uniqueness claim only when an
    // endpoint is a genuine key — otherwise `deriveKeysFromFds` reads a phantom
    // all-columns key on a narrow projection (a bag as a set) and a REQUIRED
    // DISTINCT gets dropped. `recognizeGuardedBody` emits no equiv pair for a
    // guarded body, so we detect the bi-pair STRUCTURALLY (mirror FDs sharing a
    // guard) rather than via the producer's equivPairs marker the other gates
    // use. (ticket fd-guarded-activation-key-bag-overclaim, site 7)
    const biPairMembers = new Set<FunctionalDependency>();
    const guardedSingles = sourceFds.filter(fd =>
        fd.guard !== undefined && fd.determinants.length === 1 && fd.dependents.length === 1);
    for (let i = 0; i < guardedSingles.length; i++) {
        for (let j = i + 1; j < guardedSingles.length; j++) {
            const x = guardedSingles[i];
            const y = guardedSingles[j];
            if (x.determinants[0] === y.dependents[0]
                && x.dependents[0] === y.determinants[0]
                && x.determinants[0] !== x.dependents[0]
                && guardsEqual(x.guard, y.guard)) {
                biPairMembers.add(x);
                biPairMembers.add(y);
            }
        }
    }

    const out: FunctionalDependency[] = [];
    const activatedEquivPairs: Array<[number, number]> = [];
    for (const fd of sourceFds) {
        if (fd.guard === undefined) {
            out.push(fd);
            continue;
        }
        if (predicateImpliesGuard(predicate, fd.guard, ecs, bindings, attrIdToIndex, isColumnNonNullable, isColumnNumeric)) {
            // Gate the over-claiming bi-directional value-equality pair against the
            // filter's INPUT keys (`sourceFds`; `isSuperkey`/closure skip guards, so
            // only the genuine unguarded keys count). Fold the unconditional twin
            // only when an endpoint is a superkey; otherwise drop it. The value
            // equality is instead surfaced as an EC (lifted unconditionally by the
            // caller), so the fact survives without `keysOf` reading it as a key.
            if (biPairMembers.has(fd)) {
                const a = fd.determinants[0];
                const b = fd.dependents[0];
                activatedEquivPairs.push([a, b]);
                if (!isSuperkey(new Set([a]), sourceFds, colCount)
                    && !isSuperkey(new Set([b]), sourceFds, colCount)) {
                    continue;
                }
            }
            out.push(stripGuard(fd));
        } else {
            out.push(fd);
        }
    }
    return { fds: out, activatedEquivPairs };
}
```

Update the JSDoc above the function to note it now also returns activated EC pairs
and gates the bi-directional value-equality pair.

### Why this is sound

- `isSuperkey(new Set([a]), sourceFds, colCount)` probes against `sourceFds`, whose
  guarded FDs are skipped by `computeClosure` — so the probe sees only the genuine
  unguarded input keys (PK/UNIQUE FDs). Matches the site-4 `inputFds` probe.
- **Repro** (`id` is PK; `a`/`b` not keys): neither endpoint is a superkey → bi-FD
  dropped → `select distinct a, b` keeps no phantom key → DISTINCT survives → 2 rows.
- **Control** (`a` is PK in table `tg`): closure of `{a}` covers all cols → endpoint
  is a superkey → both directions folded → DISTINCT correctly eliminated.
- Conservative by construction: the gate only ever DROPS FDs (never adds a key claim),
  so even a false-positive "mirror" detection can only lose an optimization, never
  cause wrong results. The lifted EC is unconditionally sound (value-equality holds
  over the filtered rows) and `keysOf` never reads ECs — this is the exact precedent
  set by site 5 (`check (a = b)` → EC `[a,b]` lifted, bi-FD gated, DISTINCT survives).

## Tests

### `test/fd-derived-key-bag-overclaim.spec.ts` — add "site 7 (guarded activation)"

Mirror sites 4–6. In `beforeEach`'s `db.exec`, add:

```sql
-- Site 7 (guarded activation): implication-form CHECK guard activated by the
-- filter strips to a bi-FD {a}↔{b}; id is the PK so a/b are not keys.
create table tgact (id integer primary key, a integer, b integer, status text,
    check (status <> 'active' or a = b));
insert into tgact values (1, 5, 5, 'active'), (2, 5, 5, 'active'), (3, 7, 7, 'active');
-- Site 7 control: a IS the PK, so the activated {a}↔{b} is a real key.
create table tgactpk (a integer primary key, b integer, status text,
    check (status <> 'active' or a = b));
insert into tgactpk values (1, 1, 'active'), (2, 2, 'active'), (3, 3, 'active');
```

And add the two `it(...)` cases (matching the site 4/5/6 shape):

```ts
// ---- Site 7: guard activation in Filter strips a value-equality bi-FD ----
it('site 7 — DISTINCT over `select a,b` of a guard-activated bi-FD (NON-key) is RETAINED', async () => {
    const sql = `select distinct a, b from tgact where status = 'active'`;
    expect(findNodes(db.getPlan(sql), DistinctNode), 'DISTINCT must survive (a/b not keys)')
        .to.have.length.greaterThan(0);
    expect(await rowCount(db, sql), 'two distinct (a,b) pairs').to.equal(2);
});

it('site 7 control — DISTINCT where the activated endpoint a is the PK is ELIMINATED', () => {
    const sql = `select distinct a, b from tgactpk where status = 'active'`;
    expect(findNodes(db.getPlan(sql), DistinctNode), 'a unique ⇒ {a,b} a real key ⇒ set')
        .to.have.length(0);
});
```

Also extend the file's top-of-file doc comment to mention site 7.

### `test/optimizer/conditional-fds.spec.ts` — update one existing test

The test `"filter with status='active' activates the guard: assigned_region
determined by customer_region"` (~line 1501) currently asserts the bi-FD `{1}→{2}`
and `{2}→{1}` are PRESENT unguarded on the Filter — that is exactly the over-claim now
gated. Update it to assert the bi-FD is GATED and the value-equality is lifted as an EC
(the `PhysicalProps` shape used in this file exposes `equivClasses`):

```ts
it("filter with status='active' activates the guard: assigned_region equivalent to customer_region", async () => {
    await setupRegionTable();
    const rows = await planRows(db, "SELECT * FROM t WHERE status = 'active'");
    const filterProps = physicalOf(rows, r => r.op === 'FILTER');
    expect(filterProps, 'expected Filter physical props').to.not.equal(undefined);
    // Columns: id=0, customer_region=1, assigned_region=2, status=3.
    // After activation, the value-equality body `assigned_region = customer_region`
    // surfaces as an EC {1,2} — NOT as the bi-directional determination FD. Neither
    // endpoint is a key (PK is id), so folding `{1}↔{2}` would let a later narrow
    // projection read a phantom key (ticket fd-guarded-activation-key-bag-overclaim).
    expect(fdHas(filterProps!.fds, [1], [2]), 'bi-FD {1}->{2} gated').to.equal(false);
    expect(fdHas(filterProps!.fds, [2], [1]), 'bi-FD {2}->{1} gated').to.equal(false);
    const ecs = filterProps!.equivClasses ?? [];
    const hasEc = ecs.some(c => c.includes(1) && c.includes(2));
    expect(hasEc, 'value-equality lifted as EC {1,2}').to.equal(true);
});
```

The sibling tests `"table reference carries guarded FDs..."` and `"without
status='active' the guarded FD does not activate"` pass unchanged (verified).

## Validation (done during fix stage with the prototype — re-run during implement)

- Repro → 2 rows + DISTINCT survives; PK control → DISTINCT eliminated. ✅
- `conditional-fds.spec.ts` (incl. the updated test): all pass. ✅
- `fd-derived-key-bag-overclaim.spec.ts` (sites 1–6): all pass. ✅
- `optimizer/check-fold-gated-by-capability.spec.ts`: all pass (the EC-lift /
  bi-FD-gate semantics already match site 5). ✅
- `optimizer/keysof-isunique.spec.ts`: all pass. ✅
- The `isUnique` closure branch (`fd-utils.ts:840`) needs **no change** — the fix is
  producer-side; once the activation gate keeps the over-claim out of the FD set, the
  closure reader is sound by construction (consistent with sites 1–6).

## TODO

- Edit 1: `export` `guardsEqual` in `fd-utils.ts`.
- Edit 2: import `guardsEqual` into `filter.ts`.
- Edit 3: `constantBindings` → `let`; thread `sourceAttrs.length` into the call;
  merge `activatedEquivPairs` into `equivClasses` + re-close bindings.
- Edit 4: rewrite `activateGuardedFds` (structural bi-pair detection + gate + return
  `{ fds, activatedEquivPairs }`); update its JSDoc.
- Add site 7 repro + control to `fd-derived-key-bag-overclaim.spec.ts` (+ doc-comment).
- Update the `conditional-fds.spec.ts` activation test to assert gate + EC lift.
- Run the targeted suites above, then full `yarn workspace @quereus/quereus test` + lint.
- Sweep the `property.spec.ts` Key Soundness differential; if cheap, add a
  guarded-implication + filter + DISTINCT shape to strengthen it (noted as optional in
  the fix ticket — only if it fits without large effort).
- Update `docs/optimizer.md` FD-tracking section to list guard activation as a gated
  producer (site 7) alongside the existing sites, if that section enumerates them.
