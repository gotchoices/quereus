description: A prepared statement whose parameter was first given a real value (say 5) rejects NULL for that parameter on every later run, so `update t set x = ?` cannot later set x to NULL. Decide whether a type inferred from a bound value should accept NULL.
architecture: docs/types-parameters.md#type-checking-and-validation
files: packages/quereus/src/core/param.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/planner/building/row-count-expression.ts, docs/types-parameters.md, docs/sql-select.md
repro: verified
----
# Should a parameter type inferred from a non-null value be nullable?

**Blocked: specification silent until just now.** Unblocks when the maintainer accepts or edits the proposed rule below.

## What happens

Verified 2026-11-10 with a throwaway spec (since deleted):

```ts
await db.exec('create table t (k integer primary key, x integer null)');
const s = db.prepare('update t set x = ? where k = ?', [5, 1]);
await s.run();
await s.run([null, 2]);
// Parameter type mismatch for ?1: expected non-nullable INTEGER, got NULL
```

`getParameterScalarType` (`core/param.ts`) gives a parameter first bound to a non-null value a type with `nullable: false`. That type is frozen for the statement's life, and `validateParameterTypes` (`core/statement.ts`) rejects a later `null`. The only workaround is a declared hint map. This is the mirror image of `bug-null-first-binding-pins-parameter-to-null`, where the maintainer decided that a null first binding types the parameter ANY (nullable). That decision covered only the null-first direction. Before that ticket the docs did not say whether NULL could follow a non-null binding. Its implementation documented the current rejection in the "NULL compatibility" bullet of `docs/types-parameters.md`, so the rule is now written down but was never decided.

## Proposed rule (recommended default)

A type inferred from a bound value is **nullable**: the value fixes the storage class the parameter accepts, never whether it may be NULL, because one execution's value says nothing about whether the next one is NULL. A declared hint map keeps full control, including `nullable: false`.

What else has to change with it:

- LIMIT / OFFSET: `limit ?` prepared with `[5]` would then be nullable, so the prepare-time "LIMIT expression may be NULL" check would reject it. `isUntypedParameter` (`planner/building/row-count-expression.ts`) would need to pass every parameter whose type came from inference (not only ANY) to the existing runtime check in `util/row-count.ts`. `docs/sql-select.md` §3.6 would change to match.
- Any planner or optimizer rule that relies on a parameter being non-null (for example folding `? is null` to false, or a NOT NULL proof) loses that fact for value-inferred parameters. Not measured — whoever implements this should first find the consumers of `ParameterReferenceNode` nullability.
- `docs/types-parameters.md` "NULL compatibility" bullet: replace the statement of the rejection.

## Alternatives considered

- **Re-plan once when NULL first arrives for a non-nullable inferred type**, widening it to nullable. Keeps non-null optimizations in the common case, but adds a second re-plan trigger beside the existing first-bind one, and the maintainer chose "no re-plan" for the null-first case, so this would be inconsistent with that.
- **Keep the current behaviour** (documented rejection; use a hint map). Simplest, but surprising for SQL users, who expect any parameter to accept NULL, and a reused `update … set x = ?` statement fails the first time it writes a NULL.

## If nothing is done

The rejection stays, as now documented. Callers that reuse a prepared statement for writes that sometimes carry NULL must prepare it with a hint map or prepare a new statement.

## Reversibility

Easy: the rule lives in one function (`getParameterScalarType`) plus the LIMIT/OFFSET helper; no stored data depends on it.
