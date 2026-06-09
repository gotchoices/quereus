description: Widen the 1:1 `'join-residual'` MV arm to accept a partial `WHERE`. The arm no longer blanket-rejects a body WHERE; it classifies the predicate by which base table(s) it references. A `T`-only predicate just relaxes the gate (the forward residual already carries it; the lookup side stays upsert-only). A predicate referencing the lookup `P` (or both sides) switches the lookup side to a **delete-capable** reverse residual — a WHERE-stripped membership residual deletes every currently-referencing `T.pk` backing key, then the in-scope residual re-upserts the survivors. Inner/cross + 1:1 only; outer/fanning still floor. Ready for review.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md, docs/materialized-views.md
----

## What landed

After the eligibility flip (`mv-eligibility-floor-fallthrough`), a partial-`WHERE` 1:1 join was *covered* by the full-rebuild floor — correct but unbounded. This ticket gives it a **bounded-delta** arm.

`buildJoinResidualPlan` (`database-materialized-views.ts`) previously rejected any `WHERE` (`if (mv.selectAst…where !== undefined) return null`). That blanket reject is gone. The new flow, after `T`/`P` are identified and the forward (`T`) + in-scope reverse (`P`) residuals are compiled:

1. **Determinism gate (new).** `bodyWhereIsNonDeterministic(analyzed)` walks the analyzed body's `FilterNode` predicates; a volatile WHERE → `return null` → the floor's **pragma-gated** whole-body determinism reject. This preserves the exact pre-widening behavior (a volatile-WHERE join was previously floored): rejected without `pragma nondeterministic_schema`, accepted as a wholesale rebuild with it. *(I chose `return null` → floor over a hard throw specifically to avoid regressing the pragma-on path, which the floor already handles. The arm's projection determinism check, by contrast, throws unconditionally — a pre-existing, untouched inconsistency.)*

2. **WHERE classification.** `bodyWhereReferencesLookup(analyzed, tAttrToCol, producingByAttrId)` collects every `ColumnReferenceNode` attribute id inside any `FilterNode` predicate (the body WHERE; the join's `ON` condition lives in the `JoinNode`, not a Filter, so it is excluded — confirmed by a pre-physical plan dump) and resolves each against `T`'s attribute→source-column map. **Conservative:** a reference that does not provably resolve to `T` ⇒ lookup-referencing, so the cheaper upsert-only path is taken only when *every* filter column is a `T` column.

3. **Delete-capable lookup (P-referencing only).** When the WHERE references `P`, `compileLookupMembershipResidual` builds `lookupMembershipResidualScheduler`: the WHERE is **stripped at the AST level** (`{ ...selectAst, where: undefined }`), the body re-built + re-analyzed (fresh node ids ⇒ `P` re-located by base name), then `injectKeyFilter` on `P`. `applyLookupResidual` becomes delete-then-upsert: per affected `P` key, run the membership residual → `delete-key` every currently-referencing `T.pk`; then run the in-scope residual (WHERE retained) → `upsert` the survivors. Ordering (deletes before upserts) refreshes an unchanged in-scope row rather than dropping it. The field is `undefined` for a no-WHERE / `T`-only-WHERE body (upsert-only, unchanged).

The forward (`T`) path is unchanged — it already embeds the full WHERE (incl. `P` columns), so a `T` write / FK-move that flips scope recomputes to zero rows and the delete-without-upsert removes the backing row.

## Why it's sound (the cases to scrutinize)

- **`T`-only WHERE, `P` write** — upsert-only stays sound: a `T`-column predicate can't move the membership set `{T : T.fk = P.id}`, and the `P` write doesn't change `T.fk`. The in-scope reverse residual re-derives the projected columns of the in-scope rows.
- **`P`-referencing WHERE, `P` write flips membership** — the membership residual (WHERE stripped) returns *all* `T` rows joined to the changed `P` regardless of scope; deleting their backing keys then re-upserting only the in-scope survivors converges both directions (leave-scope ⇒ deleted-not-re-added; enter-scope ⇒ delete-noop-then-added).
- **Membership delete keys come from live `T` via the join** (`row[backingPkDefinition[i].index]` = `T.pk`), so they match existing backing keys and a delete of an absent key is a layer no-op — no false deletes across `P` rows sharing nothing (each `T.fk` → one `P`).
- **Both-sides WHERE** classifies as P-referencing (delete-capable); the `T`-portion rides the forward path, the `P`-portion the reverse delete-capable path.
- **Cascade note (worth a look):** a delete-then-upsert of an *unchanged* in-scope row emits a `delete` + `insert` pair to the MV-over-MV cascade (the layer tombstones then re-inserts), not a single `update`. This is identical to the existing forward path's delete-then-upsert and is exercised by the existing MV-over-MV join suites — correct, just slightly more cascade churn.

## Tests (a floor, not a ceiling)

`test/incremental/maintenance-equivalence.spec.ts` — the `read(MV) == evaluate(body)` oracle:
- Three new property suites (80 runs each) over `where t.amt > 5` (T-only), `where p.score > 5` (P-ref), and `where t.amt > 5 and p.score > 5` (both-sides), driven by a shared generator that mutates **both** sources with predicate columns (`amt`, `score`) straddling the boundary 5 — t-insert/update(fk+amt)/updateKey/delete, p-insert/update(name+score)/delete, with FK violations tolerated.
- Deterministic membership-flip edges (P-ref body): a `p.score` update pushing rows OUT of scope removes their backing rows (the delete pass — upsert-only could not); pulling them IN adds them; an in-scope payload update refreshes without add/remove.
- White-box plan-selection: T-only ⇒ `join-residual` with **no** membership residual; P-ref / both-sides ⇒ `join-residual` **with** one; a volatile WHERE is declined → floor → rejected (UNSUPPORTED, "non-deterministic").

`test/logic/53-materialized-views-rowtime.sqllogic` — new **§24.5** exercises both classifications under SQL writes end-to-end (T-side scope flips via the forward residual; P-side membership flips via delete-then-upsert; FK-move re-evaluating the P-side predicate; mid-txn flip + rollback). The stale §7 `ok_join_where` comment ("the join-residual arm declines a partial join body → floor") was corrected — it is now a bounded-delta join-residual MV.

Docs: `docs/incremental-maintenance.md` § join-residual rewritten (WHERE handling + delete-capable reverse residual); `docs/materialized-views.md` line 294 made precise (the eligibility-shape-4 WHERE-handling paragraph at ~132 and the detail-section paragraph at ~304 were already authored by the plan ticket and match the implementation).

## Known gaps / reviewer attention

- **Classification robustness.** It relies on (a) the join `ON` condition living in the `JoinNode` (not a Filter) and (b) all WHERE conjuncts surfacing as `FilterNode`s pre-physical (verified via a plan dump; predicate-pushdown distributes them but keeps them Filters; comma-joins are unsupported syntax). The conservative "not-provably-`T` ⇒ lookup-referencing" default means even a mis-classification can only *over*-build the delete-capable path (sound, just less efficient), never silently take the unsound upsert-only path. Worth an adversarial read for a WHERE shape that could merge a membership-affecting conjunct into the `JoinNode` condition — I argued any such merge breaks `proveOneToOneJoin` (extra equi-pair fails the FK→PK cover) so the body never reaches classification, but a reviewer should pressure-test that claim.
- **P PK-changing updates** are not specially handled (consistent with the pre-existing no-WHERE join arm; the property generators never change a `P` PK, since it would either violate RI or require ON UPDATE CASCADE → a `T.fk` write that fires the forward path). Not a regression, but unexercised.
- **Compound-PK `P` lookups** are supported in principle (`pPkCols` is multi-column-capable) but the suites use single-column PKs only.
- **Re-planning cost.** `compileLookupMembershipResidual` re-builds + re-optimizes the stripped body once at registration. One-time, but it is a second full plan build per P-referencing-WHERE MV.
- `yarn test:store` not run (memory-backed default only); the logic lives in the shared `Database`/manager path.

## Validation performed

- `yarn typecheck` (quereus) — clean.
- `yarn lint` on `database-materialized-views.ts` + the spec — clean.
- `yarn build` — clean (exit 0).
- Full quereus package mocha suite: **5455 passing, 9 pending, 0 failing** (incl. the new equivalence suites, §53, and all prior MV/covering/optimizer specs).
- Full monorepo `yarn test` — exit 0, 0 failing across all packages.
