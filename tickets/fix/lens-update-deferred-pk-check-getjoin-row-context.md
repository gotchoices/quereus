----
description: |
  Updating a row through a logical (lens) view and committing throws an internal "no row context"
  error and silently discards the update, while the same operation as an insert or delete works
  fine. The committed change is lost; the data on disk is left unchanged.
files:
  - packages/quereus/src/planner/mutation/lens-enforcement.ts        # synthesizes the deferred lens:pk count(*) check (INSERT|UPDATE mask)
  - packages/quereus/src/runtime/emit/join.ts                        # conditionMet → throws while evaluating the logical-view get-join
  - packages/quereus/src/runtime/emit/column-reference.ts            # the rowId column ref that fails to resolve
  - packages/quereus/src/runtime/context-helpers.ts                  # resolveAttribute raises "No row context found for column rowId"
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # decomposes a lens UPDATE into per-member ops; attaches the deferred check
----

# Lens UPDATE commit trips "No row context found for column rowId" in the deferred `lens:pk` count(*) get-join

> Filed from the Lamina board (`lamina-committed-mutation-readback-gap`, plan stage). The symptom
> surfaces end-to-end through Lamina's lens adapter, but the failing plan/runtime is entirely
> Quereus's. A standalone repro and the full localization are below; nothing here is Lamina-specific.

## Symptom

Deploy a name-match logical schema over a single basis (the `store` / `app` / empty-lens triple),
`lensWrites` on (`nondeterministic_schema`). Then:

| Operation (through the lens view `app.widget`) | Result |
| --- | --- |
| `INSERT`, autocommit, read back | **works** |
| `DELETE … where id = 3`, autocommit, read back | **works** |
| `UPDATE … set name='B' where id = 2`, **autocommit** | **throws** at the implicit commit; the row is left **unchanged** (`name` still `'b'`) — the update is lost |
| `BEGIN; UPDATE …;` (visible in-tx) `COMMIT` | the in-tx read shows `name='B'`, then **`COMMIT` throws** and the whole tx is discarded |
| `BEGIN; UPDATE …; DELETE …; ROLLBACK` | **works** (never commits an UPDATE) |
| basis-direct `UPDATE store.widget …` | **works** (both basis and lens reads reflect it) |

The throw:

```
QuereusError: No row context found for column rowId. The column reference must be evaluated
within the context of its source relation.
  at resolveAttribute (runtime/context-helpers.ts:213)
  at column-reference.ts:9
  at conditionMet (runtime/emit/join.ts:92)
  at driveFromLeft (runtime/emit/join.ts:109)
  at join.run (runtime/emit/join.ts:190)
  at project.run (runtime/emit/project.ts:34)
```

It is a **plan/runtime** error, not a data error: the committed cell bytes are intact; the failing
operation is the *evaluation of the logical-view get-join*, and the engine rolls the episode back so
the UPDATE never lands.

## Root cause (localized)

`collectLensSetLevelConstraints` / `synthesizeUniqueCountExpr`
(`planner/mutation/lens-enforcement.ts`) attach a **deferred, commit-time** set-level uniqueness
CHECK to a lens write when the logical PK has no basis covering structure (the name-match lens over a
surrogate-keyed basis is exactly that case):

```sql
(select count(*) from app.widget as _u where _u.id = NEW.id) <= 1
```

with `operations: RowOpFlag.INSERT | RowOpFlag.UPDATE`. The subquery FROM is the **logical view**,
i.e. the default-mapper-synthesized n-way get-join over the per-column `(rowId, value)` basis
members (joined on `rowId`). The scalar subquery makes the constraint auto-defer to commit.

This explains the asymmetry exactly:

- **DELETE works** — the check is masked to INSERT|UPDATE, so a DELETE never fires it.
- **INSERT works** — the check fires and its get-join evaluates cleanly on the insert path.
- **UPDATE fails** — the check fires at commit, runs `count(*)` over the logical-view get-join, and
  *that inner get-join's own ON condition* (`leftMember.rowId = rightMember.rowId`) throws in
  `conditionMet`: the `rowId` column reference resolves to no populated row context.

So the bug is **not** in the count/uniqueness logic and **not** in Lamina's member writes (those
stage correctly and are own-write visible in-tx). It is in how the deferred `lens:pk` subquery's
logical-view get-join is evaluated **on the UPDATE path**, where the inner join's `rowId` key
reference fails to find its source-relation row context — a context/attribute-binding problem unique
to the UPDATE decomposition (where the outer member op carries OLD+NEW row contexts that the INSERT
path does not).

## Leading hypothesis (for the fix author to confirm)

The deferred check is gated onto the member UPDATE op that owns the referenced basis column (`id` →
the anchor member `store.widget__col_id`). At commit-drain the check evaluates with that member
UPDATE's OLD/NEW row slots on the runtime context stack. The inner logical-view get-join re-introduces
`rowId`-bearing member relations; the `rowId` attribute reference inside the join's ON condition
appears to resolve against a torn-down / unpopulated outer context (the member relation's `rowId`
column) rather than the inner join's live slot — an attribute-id collision / context-shadowing
between the outer UPDATE member row context and the inner get-join's `rowId` join keys. On INSERT the
outer op carries only a NEW context (no OLD), so the collision does not manifest.

Candidate fix surfaces:
- `view-mutation-builder.ts` — ensure the deferred set-level check's subquery is scoped/isolated so
  its inner get-join does not alias the outer member op's `rowId` attribute context on UPDATE
  (the INSERT path already does the right thing).
- `runtime/emit/join.ts` + `context-helpers.ts` — confirm whether `conditionMet` should be resolving
  against the inner slots only; if an outer descriptor's `rowId` attribute id is shadowing the inner
  member's, the fix may be a descriptor/attribute-id disambiguation at plan-build for the deferred
  subquery.

A `debug('planner:lens-enforcement')` plus dumping the plan of the deferred subquery for an UPDATE vs
an INSERT (compare the `rowId` attribute ids in the inner join descriptors vs the outer member op's)
should pinpoint the collision quickly.

## Standalone repro

No Lamina-specific harness is required beyond the lens adapter that deploys the triple; reproduce
with the name-match `store`/`app` widget table (`id integer primary key, name text`), `lensWrites`
on:

```
deploy store (basis) + app (logical) + empty lens over store
insert into app.widget (id,name) values (1,'a'),(2,'b'),(3,'c');   -- ok
update app.widget set name='B' where id=2;                          -- THROWS at (implicit) commit
-- row unchanged afterward: select shows id=2,name='b'
delete from app.widget where id=3;                                  -- ok (no lens:pk fired)
```

(The end-to-end repro currently lives as a **skipped** regression test on the Lamina board —
`packages/lamina-quereus-test/src/lens-committed-update-readback-e2e.test.ts`, citing this slug — and
flips green once this lands.)

## Acceptance

- A lens-view `UPDATE` (autocommit and explicit-tx) commits and reads back through both the lens view
  and the basis, with the deferred `lens:pk` set-level check still rejecting a genuine logical-PK
  duplicate introduced by a key-changing UPDATE.
- Regression coverage in `packages/quereus/test/` (e.g. alongside `lens-enforcement.spec` /
  `lens-put-fanout.spec`) exercising: UPDATE commit over a surrogate-keyed name-match lens; the
  deferred `lens:pk` still firing on a real key collision; DELETE/INSERT unaffected.
- No regression to the existing `operations: INSERT|UPDATE` masking (DELETE must still skip the
  set-level check).

## TODO

- Reproduce in a pure Quereus test (no Lamina) using a memory/store-backed surrogate-keyed lens whose
  logical PK has no basis covering structure, so `collectLensSetLevelConstraints` emits the deferred
  `lens:pk`.
- Dump + diff the deferred-subquery plan / row descriptors for INSERT vs UPDATE; confirm the `rowId`
  attribute-context collision.
- Fix the scoping/attribute-binding so the inner logical-view get-join resolves `rowId` against its
  own member slots on the UPDATE path.
- Add the Quereus regression tests above; confirm the Lamina skipped e2e flips green against this
  working tree.
