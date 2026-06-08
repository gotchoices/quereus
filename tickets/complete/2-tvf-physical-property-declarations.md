---
description: TVF physical/relational property advertisement surface — `relationalAdvertisement` on `TableValuedFunctionSchema`, consumed by `TableFunctionCallNode` on the standard `computePhysical` / `getType` paths.
files:
  - packages/quereus/src/schema/function.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/src/planner/nodes/table-function-call.ts
  - packages/quereus/src/func/builtins/generation.ts
  - packages/quereus/src/func/builtins/json-tvf.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/test/planner/tvf-physical-properties.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## What landed

TVF authors can declare relational and physical properties through an optional `relationalAdvertisement` field on `TableValuedFunctionSchema`. The declaration is consumed by `TableFunctionCallNode` on the standard physical-property and type-computation paths, so downstream optimizer rules (FD propagation, DISTINCT elimination, monotonic/ordering-aware rules, cardinality-aware planning) get the same information from a TVF that they get from a real vtab.

### Surface (`schema/function.ts`)

- `TVFAdvertiseFn<T> = (operands, schema) => T | undefined` — callback for parameter-dependent advertisements.
- `MonotonicOnColumnInfo = { column, direction, strict? }` — column-form preferred because attrIds are minted per call.
- `TVFAdvertisement` — each field is a static value or a `TVFAdvertiseFn<T>`: `isSet`, `keys`, `fds`, `equivClasses`, `ordering`, `monotonicOn`, `monotonicOnColumns`, `constantBindings`, `estimatedRows`, `accessCapabilities`, `deterministic`, `readonly`, `idempotent`.
- `resolveAdvertisement(spec, operands, schema)` — resolves value-or-closure; closures that throw collapse to `undefined`.
- `evaluateLiteralOperand(operand)` — returns `operand.expression.value` when the operand is a literal.
- `TableValuedFunctionSchema.relationalAdvertisement?: TVFAdvertisement` — optional, no default ⇒ pre-existing TVFs behave exactly as before.

### Registration (`func/registration.ts`)

`TableValuedFuncOptions.relationalAdvertisement` is forwarded by both `createTableValuedFunction` and `createIntegratedTableValuedFunction`.

### Plan-node wiring (`planner/nodes/table-function-call.ts`)

- `getType()` resolves `isSet`/`keys` and folds them into a new `RelationType`; falls back to the schema's `returnType` when not advertised or invalid. Cached.
- `computePhysical()` overrides. Without advertisement: `{ deterministic (from FunctionFlags), readonly: true, idempotent: true }`. With advertisement: resolves and validates each facet, translates `monotonicOnColumns` → `monotonicOn` by reading the live `attrId` from `getAttributes()`, merges by attrId so `monotonicOn`/`monotonicOnColumns` coexist.
- `estimatedRows` getter now reads `physical.estimatedRows`, defaulting to 10.
- Per-field validators (`validateKeys`, `validateFds`, `validateEcs`, `validateOrdering`, `validateMonotonicOn`, `validateMonotonicOnColumns`, `validateBindings`) drop bad fields silently with a single warning on `planner:tvf`; the rest of the advertisement still applies.

### Built-in annotations

| TVF | Advertised |
|---|---|
| `generate_series` | `isSet`, `keys=[[0]]`, `ordering=[{0, asc}]`, `monotonicOnColumns=[{0, asc, strict}]`, `estimatedRows` from literal bounds, `deterministic`. |
| `json_each` / `json_tree` | `isSet`, `keys=[[4]]` (id), `deterministic`. |
| `query_plan` | `isSet`, `keys=[[0]]` (id), `deterministic`. |
| `table_info` | `isSet`, `keys=[[0]]` (cid). |
| `index_info` | `isSet`, `keys=[[0, 1]]` (index_name, seq). |
| `foreign_key_info` | `isSet`, `keys=[[0, 10]]` (id, seq). |
| `unique_constraint_info` | `isSet`, `keys=[[0, 2]]` (id, seq). |
| `check_constraint_info` | `isSet`, `keys=[[0]]` (id). |
| `assertion_info` | `isSet`, `keys=[[0]]` (name). |
| `function_info` | `isSet`, `keys=[[0, 1]]` (name, num_args). |

Trace TVFs (`execution_trace`, `row_trace`, `stack_trace`, `scheduler_program`, `schema_size`, `explain_assertion`, `schema`) intentionally not annotated.

## Tests

`packages/quereus/test/planner/tvf-physical-properties.spec.ts` (8 specs):

- `generate_series(1, 100)` folds to a `TableLiteral` carrying the advertised 100 rows.
- `generate_series(1, ?)` keeps `TableFunctionCall` and exposes `uniqueKeys`, `ordering`, `monotonicOn(strict, asc)`; `estimatedRows` declines when an operand is a parameter.
- `monotonicOn` persists when a Sort sits above (documents the missing sort-elimination rule — left for follow-up).
- `SELECT DISTINCT id FROM json_each(?)` — Distinct elimination fires.
- `json_tree(?)` exposes `uniqueKeys=[[4]]`.
- FD-from-injective-projections: `SELECT value + 1 AS v FROM generate_series(1, ?)` projects the key onto `v`.
- Negative: synthetic TVF with `keys=[[{index:99}]]` runs correctly, advertises no `uniqueKeys`, emits a single warning.
- `properties` JSON still exposes the TVF column list.

## Docs

- `docs/optimizer.md` — "TVF Property Declarations" subsection (advertisement surface, `monotonicOnColumns` rationale, `evaluateLiteralOperand`, silent-validation policy, built-in annotation table).
- `docs/architecture.md` — Recent refinements bullet linking to the optimizer section.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — 2811 passing, 2 pending (baseline parity).
- `yarn workspace @quereus/quereus run lint` — clean.

## Usage

```ts
createTableValuedFunction(
  {
    name: 'my_tvf',
    numArgs: 2,
    deterministic: true,
    returnType: { /* ... */ },
    relationalAdvertisement: {
      isSet: true,
      keys: [[{ index: 0 }]],
      ordering: [{ column: 0, desc: false }],
      monotonicOnColumns: [{ column: 0, direction: 'asc', strict: true }],
      estimatedRows: (operands) => {
        const start = evaluateLiteralOperand(operands[0]);
        const end = evaluateLiteralOperand(operands[1]);
        return (typeof start === 'number' && typeof end === 'number' && end >= start)
          ? end - start + 1
          : undefined;
      },
    },
  },
  async function* (start, end) { /* ... */ },
);
```

## Follow-up (not done here)

- General-purpose "Sort on TVF-monotonic source ⇒ eliminate" rule — the advertisement is present in physical properties; no rule consumes it yet.
- vtab-style `getBestAccessPlan` from a TVF.
- Runtime parameter-dependent advertisements (closures only fire at planning time today).
- Auto-inferring advertisements from the JS implementation body.
