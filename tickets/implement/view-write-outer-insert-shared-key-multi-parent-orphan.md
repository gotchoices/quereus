description: Reject (at plan time) a multi-source outer-join INSERT whose single shared key column spans >1 presence-gated (optional) parent — the shape that today silently loses data and orphans a parent. Detected as `keyGate.groups.length >= 2` in `analyzeMultiSourceInsert`; raise a structured diagnostic instead of attaching the broken AND-gated key thread.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## Decision (design resolved in plan)

Of the three candidate semantics in the source plan ticket, **Option 1 — reject** is the
chosen v1:

- It is the smallest honest fix and matches the file's existing "reject what the
  single-column shared-key envelope can't express cleanly" precedent (the sibling
  `composite shared key` reject right beside it, `unsupported-decomposition-key`).
- Option 2 (all-or-none materialization) still *silently* loses the supplied value — it
  only suppresses the orphan, which fails half of the acceptance bar.
- Option 3 (per-parent key columns) is the real n-way generalization and a much larger
  change that does not belong in this fix.

**Reject point: plan time, when `keyGate.groups.length >= 2`.** That condition is
fully static (it is computed from the column-supply set + the FK schema, not from
per-row values), so the reject fires during `analyzeMultiSourceInsert` before any row is
evaluated — the same build-time stage every other view-mutation diagnostic raises at.

**Why `groups.length >= 2` is exactly the broken shape.** `groups` is the AND-of-(OR)
list assembled per active side: one inner group per *active, presence-gated FK-parent
partner the side declares an FK onto*. Only an FK-child accumulates groups (parent/anchor
sides declare no FK onto partners). `groups.length >= 2` therefore means one child threads
its **single** shared key column across two-or-more optional parents — `cc.pr references
p1(pp) references p2(qq)` with both `p1`/`p2` LEFT-joined and both their columns supplied.
The plan ticket confirms this is the *only* shape that reaches it (the distinct-FK-columns
sibling is already rejected upstream as a composite shared key in
`extractJoinKeyColumns`).

With one shared key value `K`, a valid both-create row needs **both** `p1(pp=K)` and
`p2(qq=K)` to exist (two FK constraints on one column). The current AND-gate
(`case when (pv is not null) and (qv is not null) then K else null end`) handles only the
all-non-null sub-case; a partial-supply row (one parent's value null) nulls `pr` entirely,
yet the present parent still materializes via its own independent presence `FilterNode` —
the orphan + silent loss the ticket describes. We cannot statically prove every row will
supply all parents, so the shape as a whole is under-determined and is rejected.

**Scope: minted-key path only.** The reject lives inside the existing
`if (needsSharedKey && suppliedKeyIndex < 0)` block, so it touches only the engine-minted
key. A **supplied** shared key (`suppliedKeyIndex >= 0`) is never gated and needs no new
reject: with FK enforcement on, a partial-supply row dangles one FK and errors loudly
(acceptance "errors clearly" — no orphan persists, the statement rolls back); with FK off,
the supplied key + null-extended partner is the user's explicit, non-silent intent.

**Diagnostic reason: reuse `unsupported-decomposition-key`** (`mutation-diagnostic.ts`)
— same family as the composite-shared-key reject ("the single-column shared-key envelope
can't express this n-way shape"). No new reason code is required; broaden that reason's
doc comment to mention the multi-parent case. The human message must carry a stable
substring for the sqllogic `-- error:` assertion (see test below).

## Fix location

`analyzeMultiSourceInsert` in `packages/quereus/src/planner/mutation/multi-source.ts`, the
per-row conditional key-thread loop (currently ~lines 622-637):

```ts
if (needsSharedKey && suppliedKeyIndex < 0) {
    for (const sideIndex of activeIndices) {
        const groups: number[][] = [];
        for (const partnerIndex of activeIndices) {
            ...
            groups.push([...partner.presenceGateIndices]);
        }
        // NEW: a single shared key cannot reference one optional parent but not the
        // other — partial per-row supply is under-determined. Reject the shape.
        if (groups.length >= 2) {
            raiseMutationDiagnostic({
                reason: 'unsupported-decomposition-key',
                table: view.name,
                message: `cannot insert through view '${view.name}': the FK-child side '${sides[sideIndex].schema.name}' threads a single shared key into ${groups.length} optional (outer-joined) parents; one key column cannot reference some-but-not-all of them per row (a multi-parent shared-key insert is not yet supported — supply all parents, or split into per-parent key columns)`,
            });
        }
        if (groups.length > 0) {
            const spec = specByIndex.get(sideIndex)!;
            specByIndex.set(sideIndex, { ...spec, keyGate: { keyTargetIndex: 0, groups } });
        }
    }
}
```

Keep the existing `groups.length > 0` (single-parent) path exactly as-is — the `ojv2`
single-optional-parent gate is the shipped, tested behavior and must stay working.

## Edge cases & interactions

- **`groups.length === 1` (single optional parent) — unchanged.** The `ojv2` FK-on block
  (test ~line 2209) must still pass: minted key threaded gated on the one parent's
  presence, null pv ⇒ pr null, no dangle, no orphan. Do **not** regress this.
- **Both parents supplied with all-non-null values.** Still rejected (the over-rejection
  tradeoff): the condition is static, so even `values (2,200,30,40)` errors. Documented and
  acceptable for v1; the alternative (per-row runtime assertion) is deferred to the Option-3
  generalization.
- **Only one parent's *columns* listed** (e.g. `insert into v (c, cv, pv)`, `qv` omitted):
  `p2` is statically inactive ⇒ `groups.length === 1` ⇒ **not** caught by this reject. Under
  FK enforcement the child's `pr=K` dangles the `p2` FK and errors loudly at runtime (no
  silent loss). This is pre-existing behavior; confirm it still errors (it is not this
  ticket's silent-loss bug). Note it in the test as a comment, optionally assert it.
- **Supplied shared key (`suppliedKeyIndex >= 0`) with the multi-parent shape.** Not
  reached by the new reject (block is minted-key-only). Verify it is unaffected: FK-on
  partial supply dangles + errors; this matches the existing `skv` supplied-key reasoning.
- **FK enforcement off (`pragma foreign_keys = false`).** The reject is shape-based, not
  enforcement-based, so it fires regardless of the pragma — the silent-loss/orphan bug
  exists with FK off too (the ticket's read-back loses `pv`). The regression test should
  cover the FK-**on** shape (the plan ticket's acceptance names the FK-on block); a brief
  FK-off variant is optional but documents that the reject is pragma-independent.
- **≥3 sides / FULL outer / RIGHT outer.** A FULL join is already rejected upstream
  (`unsupported-join`, no preserved anchor). A child referencing 3 optional parents on one
  key yields `groups.length === 3` ⇒ same reject. RIGHT mirrors LEFT — the same shape under
  a right join (preserved/non-preserved swapped) must reject identically; add a sanity check
  if cheap, but the routing is alias/preserved-keyed so the same code path applies.
- **Static updateability surface (`view_info` / `deriveViewInfo`) — out of scope.** It will
  still report this view insertable (it does not simulate the full insert analysis, same as
  every other build-time reject like `no-default`). Do not extend it here; consistent with
  precedent. If desired, file a backlog ticket — not required for acceptance.

## Regression test (test/logic/93.4-view-mutation.sqllogic)

Add to the **FK-on** region (after the `ojv2` block, ~line 2235, before the supplied-key
`skv` block). Note: two inline `references` clauses on one column parse into two FK
constraints (verified — `columnConstraintList` loops on `REFERENCES`).

```sql
-- ===================================
-- Multi-parent shared key (one child FK column references TWO optional parents on the
-- same value). A single shared key cannot reference one parent but not the other, so a
-- partial-supply row would silently lose the supplied value AND orphan the present
-- parent. The shape is rejected at plan time (was: silent wrong result + orphan).
-- ===================================
pragma foreign_keys = true;
create table mpp1 (pp integer primary key default (coalesce((select max(pp) from mpp1), 0) + mutation_ordinal()), pv integer null);
create table mpp2 (qq integer primary key default (coalesce((select max(qq) from mpp2), 0) + mutation_ordinal()), qv integer null);
create table mpc (c integer primary key, pr integer null references mpp1(pp) references mpp2(qq), cv integer null);
create view mpv as
  select x.c as c, x.cv as cv, a.pv as pv, b.qv as qv
  from mpc x left join mpp1 a on a.pp = x.pr
             left join mpp2 b on b.qq = x.pr;

-- Partial supply (p1 only): rejected — no orphan, no silent loss.
insert into mpv (c, cv, pv, qv) values (2, 200, 30, null);
-- error: single shared key

-- No parent row leaked from the rejected insert.
select count(*) as n from mpp1;
→ [{"n":0}]
select count(*) as n from mpp2;
→ [{"n":0}]
select count(*) as n from mpc;
→ [{"n":0}]
pragma foreign_keys = false;
```

Adjust the `-- error:` substring to match the final message text chosen above (keep a
short, stable fragment such as `single shared key`).

## TODO

- Broaden the `unsupported-decomposition-key` doc comment in
  `mutation-diagnostic.ts` to mention the multi-parent single-shared-key insert case.
- Add the `groups.length >= 2` reject in `analyzeMultiSourceInsert`
  (`multi-source.ts`), inside the existing `needsSharedKey && suppliedKeyIndex < 0`
  loop, before the `keyGate` attach. Use a message with a stable substring.
- Add the regression test above to `93.4-view-mutation.sqllogic` (FK-on region);
  confirm the `-- error:` fragment matches the message.
- Verify the `ojv2` single-optional-parent FK-on block and the `skv` supplied-key block
  still pass (no regression to `groups.length === 1` / supplied-key paths).
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vm.log` (or the targeted
  sqllogic runner) and confirm green; stream output (do not silently redirect).
- Update `docs/view-updateability.md` (§ Outer Joins — Inserts) with a one-line note that
  a single shared key spanning >1 optional parent is rejected (`unsupported-decomposition-key`),
  with the per-parent-key-columns generalization named as future work.
