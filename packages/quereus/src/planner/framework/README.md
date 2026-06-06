# Titan Optimizer Framework (Phase 1)

This directory contains the core framework components for the Titan optimizer Phase 1 implementation.

## Components

### Registry (`registry.ts`)
- **RuleHandle**: Structured rule registration with ID, node type, phase, and priority
- **Loop Detection**: Prevents infinite rule application using visited rule tracking
- **Priority Ordering**: Rules execute in priority order (lower numbers first)
- **Comprehensive Tracing**: Detailed logging and trace hooks for debugging

### Trace Framework (`trace.ts`)
- **TraceHook Interface**: Extensible hooks for rule and node processing events
- **DebugTraceHook**: Logs all optimizer activity to debug channels
- **PerformanceTraceHook**: Measures and logs rule execution times
- **CompositeTraceHook**: Combines multiple trace hooks
- **Environment Integration**: Automatically enables tracing based on DEBUG environment

### Context (`context.ts`)
- **OptContext**: Unified interface combining optimizer, stats provider, and tuning
- **Depth Tracking**: Prevents infinite recursion in optimization rules
- **Phase Management**: Supports 'rewrite' (logical→logical) and 'impl' (logical→physical) phases
- **Context Data**: Key-value store for rule communication and state

### Physical Utilities (`physical-utils.ts`)
- **Property Inference**: Utilities for combining and propagating physical properties
- **Ordering Operations**: Functions for merging and inferring result orderings
- **Unique Key Handling**: Logic for combining unique keys across joins and projections
- **Cost Estimation**: Helpers for consistent cost model application

## Architecture Integration

### Rule Registration
```typescript
import { registerRule, createRule } from '../framework/registry.js';

registerRule(createRule(
  'Aggregate→StreamAggregate',
  PlanNodeType.Aggregate,
  'impl',
  ruleAggregateStreaming,
  'safe', // sideEffectMode — see docs/optimizer.md § Audit discipline
  10      // priority
));
```

### Rule Implementation
```typescript
import type { RuleFn } from '../framework/registry.js';

const ruleAggregateStreaming: RuleFn = (node, optimizer) => {
  if (!(node instanceof AggregateNode)) return null;
  
  const context = optimizer.getContext();
  const stats = optimizer.getStats();
  
  // Rule logic here...
  return transformedNode;
};
```

### Tracing Integration
Tracing is automatically enabled based on environment variables:
- `DEBUG=quereus:optimizer*` - enables debug tracing
- `QUEREUS_OPTIMIZER_PERF=true` - enables performance tracing

### Statistics Provider
```typescript
// Use built-in providers
import { defaultStatsProvider, vtabStatsProvider } from '../stats/index.js';

// Or create custom provider
const customStats = createStatsProvider(
  new Map([['users', 50000]]), // table row counts
  new Map([['users:BinaryOp', 0.1]]) // predicate selectivity
);
```

## Phase 1 Status

✅ **Implemented Components:**
- Rule registration and management framework
- Comprehensive trace framework with multiple hook types
- Optimizer context with statistics provider integration
- Physical property utilities
- Golden plan test harness
- Environment-based configuration

✅ **Integration Complete:**
- Optimizer updated to use new framework
- Emitter metadata support added
- Trace hooks integrated into rule application
- Statistics provider abstraction ready

🔄 **Next Steps (Phase 2):**
- Advanced optimization rules implementation
- Seek/range scan access path selection  
- Materialization advisory framework
- Plan validation pass

## Usage Examples

### Enabling Tracing
```bash
# Enable all optimizer tracing
DEBUG=quereus:optimizer* yarn test

# Enable performance measurement
QUEREUS_OPTIMIZER_PERF=true DEBUG=quereus:optimizer* yarn test

# Trace specific rule categories
DEBUG=quereus:optimizer:rule:* yarn test
```

### Running Golden Plan Tests
```bash
# Run all golden plan tests
yarn test:plans

# Update golden files when plans change
UPDATE_PLANS=true yarn test:plans
```

### Custom Statistics Provider
```typescript
const optimizer = new Optimizer(
  DEFAULT_TUNING,
  new VTabStatsProvider() // Uses VTab module statistics when available
);
```

This framework provides the foundation for sophisticated query optimization while maintaining clear separation of concerns and comprehensive debugging capabilities. 
