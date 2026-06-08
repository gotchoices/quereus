---
description: The parser populates `CommonTableExpr.materializationHint` from `[NOT] MATERIALIZED` after the CTE name (parser.ts:301-316), but `withClauseToString` (emit/ast-stringify.ts:441-462) emits `as (${astToString(cte.query)})` with no [NOT] MATERIALIZED keyword. Round-trip silently drops the hint — exactly the class of bug the AST-level property suite is designed to surface (issue-#21 / issue-#23 class).
files:
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/test/emit-roundtrip-property.spec.ts
  - packages/quereus/test/emit-roundtrip-comparator.ts
---

## Symptom

```sql
with x as materialized (select 1) select * from x;
```

Re-emit via `astToString(parse(sql))` produces:

```sql
with x as (select 1) select * from x;
```

The `materializationHint: 'materialized'` field on the parsed AST is
present pre-emit, gone post-reparse — a silent drop the
`emit-roundtrip-property.spec.ts` `cteSelectArb` generator currently
sidesteps by leaving `materializationHint` unset.

The `dml-in-expression-position` work documented this gap in passing
(implement summary "Known gaps" #2 in
`tickets/complete/query-expr-roundtrip-property-coverage.md`); this
ticket exists to actually close it.

## Two viable shapes

Either:

1. **Emit the hint.** Add the `[not] materialized` keyword before
   `as (...)` inside `withClauseToString` when `cte.materializationHint`
   is set. Trivial, restores round-trip fidelity, makes the hint
   surface in re-stringified SQL the way SQLite does. Preferred.

2. **Document and ignore.** Add a `DEFAULT_EQUIVALENCES` entry or
   `FALSE_DEFAULT_FIELDS`-style absence in
   `emit-roundtrip-comparator.ts` that explicitly accepts the parser
   field as known-dropped, then widen `cteSelectArb` to include the
   hint so the comparator entry is actually exercised. This codifies
   the drop rather than fixing it; only reasonable if there's a
   semantic reason the hint can't survive (none observed today —
   it's literally just absent from the emit).

Shape 1 is straightforward and the natural answer. The reason for
listing shape 2 is the broader policy question: today's emitter
intentionally drops some fields (location, comments, `lexeme`); making
it round-trip-faithful by *default* is the design stance the property
suite implies, but is not explicitly stated anywhere. Worth confirming
before filing more "emit silently drops X" tickets piecemeal.

Decision: Do 1 and document the policy

## Acceptance

- A CTE with `materialized` / `not materialized` round-trips
  structurally — parsed `materializationHint` survives a
  `parse(astToString(ast))` pass.
- `cteSelectArb` in `emit-roundtrip-property.spec.ts` is widened to
  include the hint (oneof: `undefined | 'materialized' | 'not_materialized'`)
  so the property suite covers the new path.
- One targeted unit case in `emit-roundtrip.spec.ts` exercising both
  hint values, since the property suite samples and the explicit case
  is cheap belt-and-suspenders.
