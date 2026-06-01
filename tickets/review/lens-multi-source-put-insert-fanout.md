description: Review the decomposition put INSERT fan-out — anchor-first one-insert-per-member off the shared-surrogate envelope (surrogate mint per-row/per-statement, logical-tuple PK threading, optional/EAV/singleton handling). Built in `view-mutation-builder.ts` off `analyzeDecompositionInsert` (the multi-source-insert split, generalized n-way). DELETE/UPDATE fan-out (parent ticket) unchanged. Predicate-honest non-anchor writes and optional/EAV UPDATE transitions remain deferred onto absent substrate.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/lens-advertisement.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What shipped (Phase A + D)

The substrate-gated **INSERT** half of the decomposition put fan-out. An insert
through a decomposition-backed logical table now fans out to **one insert per
member, anchor first** (FK-order root), riding the shared-surrogate mutation
envelope that `view-mutation-shared-surrogate-insert` (the prereq) built. It is the
**dual of the multi-source insert**, generalized from two FK-ordered sides to an
n-way member fan-out with optional / EAV / singleton handling.

### Architecture (mirrors the multi-source insert split)
- **`analyzeDecompositionInsert(ctx, view, storage, stmt)`** (`decomposition.ts`) —
  pure, plan-agnostic. Routes each supplied logical column to its backing member
  (columnar identity mapping, or an EAV pivot detected off the get body's non-column
  projection), resolves the shared key (surrogate mint vs supplied logical-tuple PK),
  and emits per-member `DecompInsertOp[]` (target columns + per-row presence gates),
  anchor first. Raises precise diagnostics for the deferred shapes.
- **`buildDecompositionInsert(ctx, view, stmt)`** (`view-mutation-builder.ts`) — turns
  the analysis into plan nodes: one `EnvelopeScanNode` per member op (sharing a
  descriptor), an optional presence `FilterNode` (`<col> is not null or …`) for
  optional/EAV ops, a `ProjectNode` selecting the member's columns (envelope columns
  or an EAV attribute literal), each re-planned through `buildInsertStmt`
  (`preBuiltSource` seam) so every constraint/conflict/FK/default rule is reused. The
  surrogate seed (`coalesce(max(anchor.key),0)`) and the `MutationEnvelope` are built
  here. Routed from `buildViewMutation` before `propagate` runs (a decomposition
  insert can't be expressed as `BaseOp[]`).
- **Per-statement cadence** — added `MutationEnvelope.mint.cadence` (`view-mutation-node.ts`);
  the emitter (`emit/view-mutation.ts`) mints `seed + ordinal` (per-row, default) or
  `seed + 1` (per-statement, bound once). `withChildren` preserves cadence. The
  multi-source insert is unaffected (cadence undefined ⇒ per-row).
- `propagateDecomposition`'s insert arm is now an unreachable **internal guard**
  (mirrors `propagateMultiSource`).

### Key invariants to spot-check in review
- **Evaluate-once-and-thread**: a surrogate is minted once per produced row and the
  *same* value threaded into every member's key column(s). Diverging would shatter
  the row. (Test: surrogate per-row multi-row asserts Doc_core and Doc_body share the
  minted sid per row.)
- **Optional absence is row-level**: a row whose optional component is all-null
  materializes **no** optional member row (per-row `FilterNode`, not statement-level).
- **EAV attribute literal case**: an EAV write stores the attribute as the logical
  column is **declared** (case preserved via `declaredColumnNames`), because the get
  body matches the literal by exact value (no case-fold). Mixed-case EAV columns are
  *not* covered by a test (the fixtures use lowercase `p`/`q`) — **worth an adversarial
  probe** (declare a `City` EAV column, insert, read back).
- **Anchor key not double-inserted**: for logical-tuple, the anchor's key column is
  threaded once; the supplied column that maps to it is skipped.

## How to exercise (use cases)

All in `packages/quereus/test/lens-put-fanout.spec.ts` (25 passing) — memory + store:

```sql
-- logical-tuple fan-out (split T over T_core/T_b/T_c, optional T_c)
insert into x.T (id, a, b, c) values (3, 30, 300, 3000);     -- all three members
insert into x.T (id, a, b) values (4, 40, 400);              -- no T_c row (optional omitted)
insert into x.T (id,a,b,c) values (5,50,500,null),(6,60,600,6000); -- row 5 no T_c; row 6 has it
insert or replace into x.T (id,a,b,c) values (1,999,9990,99900);   -- on-conflict composes per member

-- surrogate (Doc over Doc_core(sid)/Doc_body(doc_sid), integer-auto)
insert into x.Doc (docKey,title,body) values ('k3','T3','B3'),('k4','T4','B4'); -- per-row: sids 102,103
-- per-statement: single row mints seed+1; multi-row binds one key → PK collision (atomic)

-- EAV (E over E_core(id)/E_eav triples)
insert into x.E (id,p,q) values (3,33,34);   -- anchor + 2 triples
insert into x.E (id,p,q) values (4,44,null); -- 'p' triple only (null value → no triple)

-- singleton (Cfg over Cfg_a/Cfg_b, primary key ()) — unconditional over the empty key
insert into x.Cfg (theme,lang) values ('dark','en');
```

Diagnostics covered: unbacked column (`no-inverse`), omitted logical-tuple key
(`no-default`). The `lens-advertisement.spec.ts` Car test was flipped from
asserting-deferred to asserting the insert fans out.

## Honest gaps / deferrals (treat tests as a floor)

- **Phase B — optional/EAV/key UPDATE transitions: DEFERRED, diagnostic kept.** A
  null↔non-null optional/EAV write is a per-row insert-or-delete *inside* an update
  group, which the static base-op fan-out cannot branch. Still raises
  `unsupported-decomposition-update`. The INSERT path that materializes an optional
  component *at insert time* ships; the *update*-time transition does not. Needs a
  per-row conditional op substrate — candidate follow-up ticket.
- **Phase C — predicate-honest non-anchor-member WHERE: DEFERRED, diagnostic kept.**
  The snapshot-consistent multi-member execution substrate has **not** landed (the
  lenient multi-side join delete still defers onto it too). `unsupported-decomposition-predicate`
  unchanged. Per the ticket: not invented here.
- **non-integer / declared-default surrogate generators** (`uuid7`, `callback`) →
  `no-default`. v1 mints `integer-auto` only (reuses the multi-source mint).
- **composite shared keys** → `unsupported-decomposition-key` (v1 single-column).
- **Lens row-local CHECK enforcement is NOT threaded onto a decomposition insert**
  (`buildDecompositionMemberInsert` passes `[]` to `buildInsertStmt`), matching the
  multi-source insert path — a logical check cannot be unambiguously routed to one
  member's basis terms. This is a *new capability gap*, not a regression (insert was
  fully rejected before). DELETE/UPDATE through a decomposition DO thread row-local
  checks (existing behavior, possibly itself over-broad — worth a look).
- **per-statement surrogate is well-defined only for single-row inserts** — a
  multi-row per-statement insert binds one key for all rows and collides on the
  second member's PK (asserted; matches the "base constraint pass catches collisions"
  stance). Semantically dubious for a unique surrogate but honest.
- **Pure-existence singleton anchor (no value columns, not-null no-default PK)**: an
  insert raises a precise `no-default` (the anchor's PK has no value source — Quereus
  is key-based, no rowid auto-assign). The shipped singleton test uses value-carrying
  members. Not separately tested; the diagnostic is the boundary.
- **Atomicity**: relied on the shared `ViewMutationNode`/emitter (3.6-reviewed). The
  per-statement-collision test asserts nothing persists after the abort, but a
  general mid-fan-out failure (e.g. FK violation on member 3 of 4) is **not** directly
  asserted for the decomposition path — worth an adversarial probe.

## Discovered, out-of-scope (read path)

- `select * from x.E where id = N` over an **EAV** logical table throws
  "No row context found for column p" (the EAV correlated subquery + a WHERE on the
  logical view). The `order by` form works; the basis writes are correct. This is the
  **get** path (`compileDecompositionBody` EAV subquery + filter), untouched by this
  ticket — a candidate fix ticket. Tests use the `order by` read pattern to sidestep it.

## Validation run
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus test` — **4175 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test:store` — 1077 passing, 3 pending, **1 failing pre-existing** in
  `53-materialized-views-rowtime.sqllogic` (MV row-time under the store, table `ltc`,
  outside this diff — reproduced on the stashed clean tree; see
  `tickets/.pre-existing-error.md`).
