description: typeof()'s return type is now pinned to TEXT so the comparison emitter no longer inserts an implicit numeric cast on the literal RHS that const-folds to 0 and breaks CHECK predicates like `typeof(x) = 'integer'`.
files:
  packages/quereus/src/func/builtins/scalar.ts (typeofFunc registration, lines 159-180)
  packages/quereus/src/func/registration.ts (default returnType is REAL, lines 96-98 / 183-185)
  packages/quereus/test/logic/40.2-check-extras.sqllogic (typeof CHECK fixture, lines 9-30)
----

## What was built

`typeofFunc` in `scalar.ts` was given an explicit `returnType` of
`{ typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }`.
Previously it relied on the default in `createScalarFunction` (`registration.ts:96`,
`logicalType: REAL_TYPE`), which made the planner believe `typeof(x)` was numeric.

The downstream effect: in the comparison emitter, when one side of a comparison
is numeric the other side gets an implicit `Cast(... AS REAL)`. For
`typeof(x) = 'integer'` that cast landed on the literal `'integer'`, the
resulting `Cast(Literal('integer') AS REAL)` was fully constant, the const-fold
pass collapsed it to `0`, and the CHECK at row time evaluated `typeof(x) = 0` —
always false. With `typeof()` typed as TEXT, no implicit cast is inserted and
the comparison runs as text-vs-text, matching SQLite's documented behavior
(`typeof()` always yields `'null' | 'integer' | 'real' | 'text' | 'blob'`).

## Verification

```
yarn workspace @quereus/quereus test --grep "40\.2-check-extras"
  → 1 passing
yarn workspace @quereus/quereus test
  → 993 passing, 1 pre-existing failure unrelated to this ticket
    (`Predicate normalizer / double negation: NOT NOT (a > 10) equals a > 10`,
     reproduces on main without these changes)
npx tsc --noEmit (in packages/quereus)
  → clean
```

The fixture at `test/logic/40.2-check-extras.sqllogic:9-30` covers the
golden path:

```sql
create table t_typ (
  id integer primary key,
  x any,
  check (typeof(x) in ('integer', 'real'))
);
insert into t_typ values (1, 10);    -- succeeds (typeof = 'integer')
insert into t_typ values (2, 'abc'); -- still fails (typeof = 'text')
insert into t_typ values (3, 1.5);   -- succeeds (typeof = 'real')
```

23 other test files use `typeof(` in some form; the full-suite run confirms
none of them depended on the prior accidental REAL typing.

## Audit notes (other text-returning scalars)

Per the source ticket's complementary cleanup ask, `scalar.ts` and `string.ts`
were audited:

- `scalar.ts`: `typeof` was the only text-returning scalar without an explicit
  return type. All other text-shaped helpers (`coalesce`, `iif`, `nullif`,
  `choose`, `greatest`, `least`) use `inferReturnType` to compute the right
  type from arguments. There is no `printf` registered.
- `string.ts`: every text-returning function (`substr`, `substring`, `lower`,
  `upper`, `trim`, `ltrim`, `rtrim`, `replace`, `reverse`, `lpad`, `rpad`)
  already attaches `textReturnTypeInference` (TEXT). `length` and `instr`
  declare INTEGER explicitly.
- Latent but separate (out of scope here): `like` and `glob` in `string.ts`,
  and `random` / `randomblob` in `scalar.ts`, return non-TEXT values without
  a registered type and so default to REAL. None is a current bug — `like`
  / `glob` results are virtually always consumed as truthy, and the two
  `random*` functions are rarely compared against literal text — but a
  future sweep tightening these would prevent the same pattern from biting
  in another corner.

## Downstream follow-up

`lamina-quereus-test` can now drop its `TYPEOF_CHECK_CONSTANT_FOLD`
known-failure entry once a release containing this fix lands.
