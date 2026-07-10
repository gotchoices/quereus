----
description: The query planner believes a column declared as JSON can never hold a text string, but it can, so the planner can convince itself a filter matches at most one row when it really matches several. Fix the check and add a regression test.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # isNonTextualLogicalType (~296), logicalTypeCanHoldText (~335), NEVER_TEXT_PHYSICAL_TYPES (~320)
  - packages/quereus/test/planner/collation-soundness.spec.ts       # add repro shape 5
  - packages/quereus-store/src/common/store-table.ts                # columnCanHoldText (~146) — already a wrapper; leave alone
difficulty: easy
----

# `isNonTextualLogicalType` mis-classifies JSON

## What is wrong

`isNonTextualLogicalType(lt)` answers "can a value of this type *never* be a text string?".
It answers **yes** for the `JSON` logical type, because JSON's physical representation is
tagged `OBJECT`.

That is false. `JSON_TYPE.parse` runs the input through `JSON.parse`, so a JSON *scalar*
string round-trips to an ordinary JS string. Confirmed empirically:

```sql
create table tj (id integer primary key, j json) using memory;
insert into tj values (1, '"Bob"'), (2, '"bob"');
select id, j, typeof(j) from tj;
-- 1 | Bob | text
-- 2 | bob | text
```

So a `JSON` column holds text, comparisons on it go through the text path, and a collation
applies.

## Why it matters — reproduced

The predicate gates `isValueDiscriminatingEquality`, which decides whether an equality
`a = b` is safe to mint value-level facts from (constant pins, equivalence classes, mirror
functional dependencies, join equi-pairs). Under `NOCASE`, `'Bob' = 'bob'` passes without
the two values being equal, so a fact minted from it over-claims. JSON was being exempted
from that gate.

Reproduced against the current tree:

```sql
create table tj (j json, x integer, primary key (j, x)) using memory;
insert into tj values ('"Bob"',1), ('"bob"',1);
select * from tj where j = cast('"bob"' as json) collate nocase and x = 1;
```

Both rows are returned (correct — `NOCASE`), but the planner claims the filter yields at
most one row:

| | `isAtMostOneRow(root)` | `keysOf(root)` |
|---|---|---|
| before fix | `true` | `[[]]` (empty key = "≤1 row") |
| after fix | `false` | `[[0,1]]` |

Reaching the bug needs a JSON-typed operand on *both* sides plus a non-`BINARY` collation.
A column-level `collate nocase` on a `JSON` column is rejected at CREATE time
(`JSON_TYPE.supportedCollations` is `[]`), and the session `default_collation` likewise
never lands on it — so the collation has to arrive via an explicit `COLLATE` wrapper, and
the constant side has to be JSON-typed (`cast(… as json)` or the `json(…)` function). Both
forms reproduce.

### What was *not* found

No query returning wrong **rows**. `distinct`, `group by`, `order by`, `limit`, scalar
subquery, and `left join` over the pinned filter all still return correct results, because
constant folding collapses `cast('"bob"' as json)` back to a plain TEXT literal before the
optimizer rules consume the fact — the false claim lives in the logical plan and the rules
that would act on it re-derive from the folded tree. That is luck, not design: the claim is
wrong, `isAtMostOneRow` is public planner API, and any rule that reads it earlier (or any
future non-foldable JSON operand — a correlated subquery, a JSON-returning UDF) turns it
into wrong rows. It is a latent defect, not a tripwire.

The exact analogue one layer down **is** proven and already fixed: a `JSON` column under a
`create unique index … collate nocase` silently accepted a duplicate in the persistent
store, because the store had its own copy of the predicate. See `columnCanHoldText` in
`store-table.ts` and its regression tests in
`packages/quereus-store/test/unique-constraints.spec.ts`.

## The fix

The engine already has the corrected predicate sitting 40 lines below the broken one:
`logicalTypeCanHoldText`, an allow-list over physical representation (`INTEGER`, `REAL`,
`BLOB`, `BOOLEAN` provably never hold a string; everything else may). It is already
exported from `@quereus/quereus` and already consumed by the store and the isolation layer.
`isNonTextualLogicalType` is its exact negation, minus the JSON hole. Collapse the two:

```ts
function isNonTextualLogicalType(lt: LogicalType | undefined): boolean {
	return !logicalTypeCanHoldText(lt);
}
```

(`logicalTypeCanHoldText(undefined)` is `true`, so the `undefined ⇒ potentially textual`
behaviour of the old body is preserved.) Applied and verified: the false claim disappears
and the whole `@quereus/quereus` suite passes — 6733 passing, 9 pending.

Two behaviour changes fall out, both conservative in the safe direction:

- `JSON` (physical `OBJECT`) is now potentially textual — the bug being fixed.
- `NULL` (the `NULL_TYPE` logical type, physical `NULL`) is now potentially textual too. It
  can only ever hold `null`, so this loses a theoretical optimization on an operand whose
  static type is exactly `NULL`. No test notices, and nothing else in the codebase mints a
  `NULL_TYPE`-typed comparison operand.

`ANY` keeps its current classification (potentially textual) — the old body special-cased it
by *name*; the allow-list catches it by physical representation (`NULL`), so the name check
goes away rather than being preserved.

## De-duplication

Mostly already done: `columnCanHoldText` in `store-table.ts` is a three-line adapter that
calls the engine's exported `logicalTypeCanHoldText` with a `ColumnSchema` instead of a
`LogicalType`. It is not a second copy of the logic and should stay — deleting it would only
push `col?.logicalType` into its three call sites. The original ticket's "delete
`columnCanHoldText`" step is therefore obsolete; what remains is deleting the *engine's*
divergent copy, which is exactly the fix above.

Both places still carry stale comments pointing at this ticket and must be cleaned up:

- `comparison-collation.ts` (~311–316): the `NOTE:` on `NEVER_TEXT_PHYSICAL_TYPES` saying it
  is "deliberately stricter than `isNonTextualLogicalType` … the two collapse into one
  predicate once that ticket lands". They have collapsed; drop the note.
- `store-table.ts` (~140): the comment on `columnCanHoldText` describing the two guards.
  Re-read it and trim anything that still implies a divergence.

# TODO

- Replace `isNonTextualLogicalType`'s body with `!logicalTypeCanHoldText(lt)` in
  `packages/quereus/src/planner/analysis/comparison-collation.ts`. Keep the function (three
  call sites: `isStaticallyNonTextual`, and twice inside `astOperandContribution`); update
  its doc comment — it no longer special-cases `ANY` by name, and `JSON`/`NULL` are now
  treated as potentially textual.
- Drop the now-unused `PhysicalType` import if nothing else in the file needs it
  (`NEVER_TEXT_PHYSICAL_TYPES` still does — check before removing).
- Delete the stale `NOTE:` block above `NEVER_TEXT_PHYSICAL_TYPES` that forward-references
  this ticket; fold anything still true (why `OBJECT` and `NULL` are absent) into the
  set's own doc comment.
- Trim the stale cross-reference comment above `columnCanHoldText` in
  `packages/quereus-store/src/common/store-table.ts`. Do not delete the function.
- Add repro shape 5 to the `repro shapes (must stay fixed)` block of
  `packages/quereus/test/planner/collation-soundness.spec.ts`, alongside the four existing
  ones. It fails on the current tree (`atMostOne` is `true`) and passes after the fix:

  ```ts
  it('5: a NOCASE pin on a JSON column makes no ≤1-row claim', async () => {
      await db.exec('create table tj (j json, x integer, primary key (j, x)) using memory');
      await db.exec(`insert into tj values ('"Bob"',1), ('"bob"',1)`);
      const q = `select * from tj where j = cast('"bob"' as json) collate nocase and x = 1`;
      const root = rootOf(db, q);
      expect((await collect(db, q)).length).to.equal(2);
      expect(isAtMostOneRow(root), 'false ≤1-row claim on JSON column').to.equal(false);
      expect(keysOf(root).some(k => k.length === 0), 'empty key claimed').to.equal(false);
  });
  ```

  Note `tj` is declared inside the test, not in the block's `beforeEach` (which creates
  `t4`) — follow the shape of repro 4, which does the same.
- Run `yarn workspace @quereus/quereus run test` (expect ~6733 passing) and `yarn lint`.
