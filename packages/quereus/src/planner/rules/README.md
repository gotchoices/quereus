# Optimizer Rules Directory

This directory contains optimization rules for the Quereus Titan optimizer, organized by functional area.

## Directory Structure

```
rules/
├── rewrite/          # Logical-to-logical transformations
│   ├── predicate-pushdown/
│   ├── join-reordering/
│   └── subquery-rewrite/
├── access/           # Table access path optimization
│   ├── index-selection/
│   └── scan-strategy/
├── join/             # Join algorithm selection and optimization
│   ├── algorithm-selection/
│   └── join-ordering/
├── aggregate/        # Aggregation optimization
│   ├── streaming/
│   └── hash-aggregate/
├── cache/            # Caching and materialization
│   ├── materialization/
│   └── cache-injection/
└── physical/         # Physical property propagation
    ├── ordering/
    └── uniqueness/
```

## Rule Categories

### Rewrite Rules (Logical → Logical)
Transform logical plan structure without changing to physical nodes:
- Retrieve growth (modules handle pushdown via Retrieve pipelines)
- Join reordering based on cardinality
- Subquery → join conversions
- Constant folding and elimination

### Access Rules (Logical → Physical)
Choose optimal table access strategies:
- Index vs. sequential scan selection
- Index seek vs. scan decisions
- Column pruning integration

### Join Rules (Logical → Physical)
Select join algorithms and optimize join trees:
- Nested loop vs. bloom join vs. merge join selection
- Join order optimization
- Cache injection for inner sides

### Aggregate Rules (Logical → Physical)
Choose aggregation implementation strategies:
- Stream vs. hash aggregation
- Sort requirement analysis
- Grouping optimization

### Cache Rules
Inject caching where beneficial:
- CTE materialization decisions
- Nested loop inner caching
- Spill-to-disk strategies

### Physical Rules
Propagate and optimize physical properties:
- Ordering preservation and requirements
- Uniqueness key propagation
- Constant and deterministic flags

## Rule Naming Convention

Rules follow the pattern: `rule-<description>.ts`

Examples:
- `rule-grow-retrieve.ts`
- `rule-aggregate-streaming.ts`
- `rule-join-hash-conversion.ts`
- `rule-cache-cte-materialization.ts`

## Implementation Requirements

Each rule must:
1. Follow the function signature: `(node: PlanNode, optimizer: Optimizer) => PlanNode | null`
2. Include comprehensive unit tests in co-located `.spec.ts` file
3. Use consistent logging with `createLogger('optimizer:rule:<name>')`
4. Preserve attribute IDs when creating new nodes
5. Set appropriate physical properties using `PlanNode.setDefaultPhysical()`

## Getting Started

1. Choose the appropriate category directory
2. Copy the rule template from `docs/optimizer-conventions.md`
3. Implement the rule following the established patterns
4. Add comprehensive unit tests
5. Register the rule in the appropriate registry file

See `docs/optimizer-conventions.md` for detailed implementation guidelines. 
