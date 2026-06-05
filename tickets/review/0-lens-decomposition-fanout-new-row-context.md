description: |
  Review the extension of the `new.<col>` row-context binding to the multi-member
  decomposition (and multi-source) INSERT fan-out. Each member insert's default-build
  scope now parents on the **produced logical row's** NEW context (every supplied
  logical column registered as `new.<col>` over the shared envelope attributes), so a
  member's column default can correlate on a sibling logical column the member's own
  base table does not carry — the key case being an anchor surrogate `default
  (select … where parent.key = new.<fk>)`. Before this, the engine's own fan-out threw
  `new.<col> isn't a column` from `buildDecompositionMemberInsert` → `buildInsertStmt`
  → `buildNotNullDefaults` → `resolveColumn`.
files:
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # buildMemberDefaultRowScope + threading into buildDecompositionMemberInsert / buildMultiSourceInsert
  - packages/quereus/src/planner/building/insert.ts                  # buildInsertStmt new defaultRowContextScope param → createRowExpansionProjection + buildNotNullDefaults
  - packages/quereus/src/planner/building/constraint-builder.ts      # buildNotNullDefaults new parent-scope param (the throw site)
  - packages/quereus/test/logic/03.4-defaults.sqllogic               # decomposition fan-out new.<col> case (appended)
  - packages/quereus/test/property.spec.ts                           # Family C: deployParentSurrogate + PutGet (surrogate, parent-resolving default)
  - docs/view-updateability.md                                       # § Mutation Context — member site resolves against the produced logical row

# Review: `new.<col>` row-context in the decomposition INSERT fan-out

## What landed

A lens logical-view INSERT lowers to an n-member decomposition fan-out (the
`shared-key-via-column-defaults` model). The anchor key column's `default` is evaluated
once per produced row at the envelope and EC-threaded across every member. When that
default is **identity-resolving** — `default (select rowId from parent where
parent.key = new.<fk>)` — it must read the produced row's `new.<fk>`. The envelope-level
key default (`buildKeyDefault`) already handled this. The **per-member base inserts** did
not: each re-plans through `buildInsertStmt`, whose `buildNotNullDefaults` builds a DEFAULT
evaluator for **every** NOT NULL column with a declared default (used by `or replace`
substitution) — and for the anchor's key column that default references `new.<fk>`, a
logical column the anchor's own base table does not carry. `resolveColumn` threw.

### The mechanism

`buildMemberDefaultRowScope` (view-mutation-builder.ts) builds, once per fan-out, the
produced logical row's NEW context: each supplied logical column registered as `new.<col>`
(and bare, unless shadowed) over the **shared envelope attributes**, reusing
`buildRowDefaultScope` (the same surface the single-source insert path exposes). It is
threaded as a new optional `defaultRowContextScope` param of `buildInsertStmt`, which
parents BOTH default-build sites on it:
  - `createRowExpansionProjection` (omitted-column expression defaults), and
  - `buildNotNullDefaults` (the NOT NULL / `or replace` substitution default — the throw site).

The member's own supplied columns / NEW columns and any mutation-context variables are
registered on the inner scopes and **shadow** the threaded names, so a name a member
carries itself still wins (single-source behaviour is byte-identical — the param is
`undefined` there).

### Why it resolves at runtime (the load-bearing claim to scrutinise)

The threaded scope's `new.<col>` refs point at the **envelope** attributes, not the
member's NEW row. At runtime those attributes stay bound through the whole member-insert
pipeline (`EnvelopeScan → [Filter] → narrowing Project → Insert → ConstraintCheck`) because
the narrowing envelope `ProjectNode`'s `sourceSlot` remains set while it is **suspended at
its `yield`** — exactly the suspension the single-source `new.<col>` path already relies on.
So `new.<fk>` resolves to the supplied value of the **current produced row** at both default
sites, including the `or replace` substitution evaluated downstream in `ConstraintCheckNode`.
Verified empirically (see below), not just reasoned.

## Use cases to validate

**Primary (the repro that threw before):** a surrogate decomposition whose anchor holds
only the key, its default resolving a parent surrogate from a sibling member's column:

```sql
create table p (pid integer primary key, value integer);          -- parent identity
insert into p values (10,100),(20,200),(30,300);
create table h_id (rowId integer primary key
    default (select pid from p where p.value = new.value)) with tags (… anchor, surrogate, key=rowId …);
create table h_val (rowId integer primary key, value integer) with tags (… member, col.value=value …);
declare logical schema x { table T { value integer } }; apply schema x;

insert into x.T (value) values (200);          -- rowId resolves to 20, threaded into BOTH members
insert into x.T (value) values (100),(300);    -- per produced row: 100→10, 300→30 (NEW context is per-row)
```

Things a reviewer should pin:
- **Per-row** resolution in a multi-row VALUES insert (each `new.<fk>` is the *that-row* value, not once-per-statement). Covered by the logic test + property test.
- **EC-threading**: the resolved surrogate lands identically on the anchor and every member.
- **`insert or replace`** through the decomposition reaches `buildNotNullDefaults` at runtime
  and still resolves `new.<fk>` (idempotent for the resolving shape). Manually verified;
  not asserted by an automated test (see Gaps).
- **Single-source unchanged**: 03.4-defaults.sqllogic's existing `new.<col>` cases (incl. the
  single-source identity-resolving `h0_users_id`/`h2_uprof`) stay green.

**Tests added**
- `test/logic/03.4-defaults.sqllogic` — a decomposition fan-out section: single-row resolve,
  identical surrogate on both members, multi-row per-row resolve, view read-back.
- `test/property.spec.ts` Family C — `deployParentSurrogate` + `PutGet (surrogate,
  parent-resolving default)` (50 runs): distinct parents, one logical insert per parent in one
  statement, asserts each row resolved its OWN parent surrogate and threaded it + supplied
  values into every member.

## Validation performed

- `yarn typecheck`, `yarn build`, `yarn lint` (the three src files + property.spec.ts): clean.
- `yarn test` (full quereus package): **4760 passing, 9 pending, 0 failing.**
- property + logic + lens-foundation specs together: 378 passing, 0 failing.
- Manual repros (since removed): the primary case incl. `insert or replace` (correct,
  idempotent), multi-row per-row resolution, AND the `createRowExpansionProjection` path (an
  *omitted* non-key member column whose default references a cross-member `new.<col>` —
  `tag default (new.value + 1)` resolved per row: 101/201). Both default sites runtime-correct.

## Known gaps / things to scrutinise (treat as a floor, not a finish line)

1. **Suspension-based runtime binding.** Cross-member `new.<col>` at the `buildNotNullDefaults`
   site resolves only because the narrowing envelope `ProjectNode` stays suspended (slot bound)
   while downstream processes each row. This holds for the simple `EnvelopeScan → Project` source
   the fan-out builds, and the single-source path already depends on the same property — but if a
   future optimizer rule inserted a **materialization / cache barrier** between the envelope
   projection and the member's `ConstraintCheckNode`, the `or replace` re-substitution of a
   cross-member ref could fail with "No row context found". No such rule exists today; worth a
   reviewer's eye on whether one could. (The common, non-REPLACE insert never invokes that
   evaluator at all.)
2. **Multi-source insert path threaded but unexercised.** The same scope is threaded into
   `buildMultiSourceInsert`'s per-side base inserts (symmetric dual; prevents the same latent
   throw for a join-view insert whose side default references a sibling side's column), but no
   test exercises a multi-source cross-side `new.<col>` default — only the decomposition path is
   tested. Consider a join-view analogue if cheap.
3. **Bare-form registration.** `buildMemberDefaultRowScope` registers both `new.<col>` and the
   bare `<col>` form (via `buildRowDefaultScope`) for supplied logical columns at the parent
   level — matching the single-source / `buildKeyDefault` precedent. Member-own names shadow
   them, but a reviewer may want to confirm a bare logical-column name can't surprise name
   resolution inside a member default's subquery.
4. **REPLACE re-substitution is not asserted in CI.** Manually confirmed correct; no test pins
   that `insert or replace` re-evaluates the cross-member default at runtime. Adding one would
   close gap (1)'s observability.
5. **Lens nullability quirk (NOT this ticket).** While writing the property test, a logical table
   declared with `null` columns and **no primary key** tripped a `lens.nullability-mismatch` at
   deploy (a `null` logical column read as NOT NULL against a nullable basis), whereas the same
   `integer null` works when the table has a PK or when columns are NOT NULL. Worked around by
   using NOT NULL columns in the test. Pre-existing lens deploy behaviour, unrelated to the
   `new.<col>` change — flagging only so the reviewer doesn't attribute it here. Could merit its
   own backlog ticket if it's a genuine inconsistency.

## Downstream (cross-repo, informational)

This was the lone remaining engine gate for Lamina's parent-fk shared-rowId **identity**
through the lens (sibling repo `../lamina`, consumes `@quereus/quereus` via a `portal:` link to
`dist/`). Building `dist/` and adopting it Lamina-side is out of scope here; the Lamina-side
proof is `pk-is-fk-anchor-default-e2e.test.ts` (skipped, pending), with dependents
`tickets/blocked/{1-lamina-lens-write-path-adoption, 4-lamina-retire-rowidsource-physical-machinery}.md`.
