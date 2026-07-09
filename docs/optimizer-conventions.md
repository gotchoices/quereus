# Optimizer Conventions: Characteristics-Based Patterns

This document establishes the **implemented patterns** for the Quereus optimizer, using characteristics-based detection to ensure robust, extensible optimization rules. This approach is **actively in use** throughout the optimizer and plan builders.

## Philosophy: Characteristics Over Identity

The optimizer makes decisions based on **what nodes can do** (characteristics) rather than **what nodes are** (specific types). This **implemented approach**:

- **Eliminates fragility**: No hard-coded assumptions about specific node types
- **Enables extensibility**: New node types automatically work with existing rules
- **Improves maintainability**: Rules are self-documenting about their requirements
- **Supports symbolic refactoring**: Member names can be changed without breaking dynamic references

## Core Principles

### 1. Physical Properties First
Use the physical properties system as the primary way to understand node capabilities:

```typescript
// ❌ Fragile: Hard-coded node type check
if (node instanceof UpdateNode || node instanceof DeleteNode) {
  // handle mutating operations
}

// ✅ Robust: Physical property check
if (PlanNode.hasSideEffects(node.physical)) {
  // handle operations with side effects
}
```

### 2. Interface-Based Capabilities
Define interfaces that capture what nodes can do, not what they are:

```typescript
// ❌ Fragile: Checking specific node types
if (node instanceof FilterNode || node instanceof JoinNode) {
  // Both have predicates, but different structures
}

// ✅ Robust: Interface for predicate capability
interface HasPredicate {
  getPredicate(): ScalarPlanNode | null;
}

function canPushDownPredicate(node: PlanNode): node is HasPredicate {
  return 'getPredicate' in node && typeof node.getPredicate === 'function';
}
```

### 3. Utility Functions for Characteristics
Create reusable functions that detect characteristics across node types:

```typescript
// ✅ Characteristic detection utilities
export class PlanNodeCharacteristics {
  static hasOrderedOutput(node: PlanNode): boolean {
    return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
  }
  
  static isConstantValue(node: PlanNode): node is ConstantNode {
    return node.physical.constant === true && 'getValue' in node;
  }
  
  static estimatesRows(node: PlanNode): number {
    return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
  }
}
```

## Pattern Categories

### Access Path Selection

**Problem**: Rules need to identify table access patterns
**Solution**: Interface-based table access capabilities

```typescript
interface TableAccessNode extends RelationalPlanNode {
  readonly tableSchema: TableSchema;
  getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek';
}

function isTableAccess(node: PlanNode): node is TableAccessNode {
  return isRelationalNode(node) && 'tableSchema' in node;
}
```

### Predicate Operations

**Problem**: Rules need to work with predicates across different node types
**Solution**: Unified predicate interface

```typescript
interface PredicateCapable {
  getPredicate(): ScalarPlanNode | null;
  withPredicate(newPredicate: ScalarPlanNode | null): PlanNode;
}

interface PredicateCombinable extends PredicateCapable {
  canCombinePredicates(): boolean;
  combineWith(other: ScalarPlanNode): ScalarPlanNode;
}
```

### Aggregation Detection

**Problem**: Multiple ways to represent aggregation operations
**Solution**: Aggregation capability interface

```typescript
interface AggregationCapable extends RelationalPlanNode {
  getGroupingKeys(): readonly ScalarPlanNode[];
  getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string }[];
  requiresOrdering(): boolean;
}

function isAggregating(node: PlanNode): node is AggregationCapable {
  return isRelationalNode(node) && 'getGroupingKeys' in node;
}
```

### Functional Dependencies, Equivalence Classes, Bindings

**Problem**: Rules need to reason about "what determines what" — uniqueness, transitive equalities, pinned constants, domain constraints — across many operator shapes without re-implementing the algebra.
**Solution**: Treat `PhysicalProperties.fds` / `equivClasses` / `constantBindings` / `domainConstraints` as the single source of truth, and route every query through the helpers in `planner/util/fd-utils.ts` rather than walking the lists directly.

```typescript
// ❌ Fragile: re-implementing closure inline
const determined = new Set<number>(seedCols);
for (const fd of node.physical.fds ?? []) {
  if (fd.determinants.every(d => determined.has(d))) {
    for (const dep of fd.dependents) determined.add(dep);
  }
}

// ✅ Robust: use the shared fixed-point helper (which also handles iteration to convergence)
import { computeClosure } from '../util/fd-utils.js';
const determined = computeClosure(seedCols, node.physical.fds ?? []);
```

**Key conventions for FD-aware rules.** Most of these are normative — the register is where
they are stated, and where a reviewer checks them against the code. This guide keeps only
what a rule author needs at the keyboard.

> **Invariant:** [OPT-030](invariants.md#opt-030--uniqueness-is-read-through-one-surface), [OPT-032](invariants.md#opt-032--coverage-is-not-uniqueness)

Reason through the helpers, never by walking `physical.fds` yourself — hand-walking misses
transitive closure and forgets the subsumption / cap / guard semantics `addFd` enforces. And
pick coverage vs uniqueness deliberately: `closureCoversAll` is a pure value claim (a
determined column is redundant in an `ORDER BY` / `GROUP BY` regardless of uniqueness),
whereas `isUniqueDeterminant` — or, at node level, `keysOf` / `isUnique` — is the only sound
way to ask "is this set row-unique?".

> **Invariant:** [OPT-034](invariants.md#opt-034--closure-helpers-skip-guarded-fds), [OPT-036](invariants.md#opt-036--a-guard-is-discharged-only-at-the-producing-filter), [OPT-038](invariants.md#opt-038--projection-drops-an-fd-whose-guard-loses-a-column)

If your rule needs a guarded FD's fact, do not discharge the guard yourself. Discharge happens
at the producing `Filter`'s `computePhysical`, via `predicateImpliesGuard` + `stripGuard`.

> **Invariant:** [OPT-048](invariants.md#opt-048--dependency-facts-index-output-columns)

Crossing a Project / Returning / Aggregate / join boundary, translate via `projectFds` /
`shiftFds` and their EC / binding / domain / IND mirrors instead of hand-mapping indices.

> **Invariant:** [OPT-046](invariants.md#opt-046--addfd-is-the-only-fd-accumulation-path)

Accumulate with `addFd`, not `Array.push`. Pass `{ keyHints }` listing column-index sets known
to be keys so cap eviction prefers to keep them; truncations log on the `quereus:planner:fd`
debug channel.

> **Invariant:** [OPT-042](invariants.md#opt-042--an-outer-join-drops-the-null-padded-sides-facts)

Do not invent a propagation policy for a new operator — follow the per-operator table in
[Functional Dependency Tracking](optimizer-fd.md#per-operator-propagation).

> **Invariant:** [OPT-054](invariants.md#opt-054--all-columns-key-ness-lives-on-isset), [OPT-052](invariants.md#opt-052--provenance-is-informational)

Set-ness is not an FD, but the readers consume it: `hasAnyKey(fds, columnCount, isSet)` and
friends take it as a parameter, while `keysOf` / `isUnique` read `getType().isSet` themselves.
And a `source` tag is for diagnostics — never branch rule logic on it.

**Not in the register** (a convention, not an invariant): whenever a rule adds a
`ConstantBinding` at the same site as ECs (Filter, inner join), close it with
`closeConstantBindingsOverEcs` so downstream consumers see the binding on every EC peer in one
pass. That is what makes `WHERE t.k = u.k AND t.k = 5` land as one binding covering both
columns.

See [Functional Dependency Tracking](optimizer-fd.md#functional-dependency-tracking) for the producer/consumer catalog and the per-operator propagation table, and [Assertions § Binding-aware Delta Planning](optimizer-assertions.md#binding-aware-delta-planning-reusable) for the `analyzeRowSpecific` / `extractBindings` analysis surface that builds on this layer.

### Caching Eligibility

**Problem**: Determining what can be cached
**Solution**: Physical properties + interface checks

```typescript
export class CachingAnalysis {
  static isCacheable(node: PlanNode): boolean {
    // Must be relational to cache results
    if (!isRelationalNode(node)) return false;
    
    // Already cached nodes don't need re-caching
    if (this.isAlreadyCached(node)) return false;
    
    // Check physical properties for side effects
    const physical = node.physical;
    if (PlanNode.hasSideEffects(physical)) {
      // Only cache if execution would be expensive and repeated
      return this.isExpensiveRepeatedOperation(node);
    }
    
    return true;
  }
  
  private static isAlreadyCached(node: PlanNode): boolean {
    return 'cacheStrategy' in node && node.cacheStrategy !== null;
  }
}
```

## Migration Patterns

### From instanceof to Interface Checks

```typescript
// Before: Hard-coded type checks
function oldRule(node: PlanNode): PlanNode | null {
  if (node instanceof FilterNode) {
    const filter = node as FilterNode;
    // ... work with filter.predicate
  } else if (node instanceof JoinNode) {
    const join = node as JoinNode;
    // ... work with join.condition
  }
  return null;
}

// After: Interface-based approach
function newRule(node: PlanNode): PlanNode | null {
  if (canPushDownPredicate(node)) {
    const predicate = node.getPredicate();
    if (predicate && canOptimizePredicate(predicate)) {
      return optimizePredicateNode(node, predicate);
    }
  }
  return null;
}
```

### From nodeType Checks to Property Checks

```typescript
// Before: Enumeration-based checks
if (node.nodeType === PlanNodeType.Sort || 
    node.nodeType === PlanNodeType.StreamAggregate) {
  // Handle ordered operations
}

// After: Property-based checks
if (PlanNodeCharacteristics.hasOrderedOutput(node)) {
  // Handle any node that produces ordered output
}
```

## Framework Utilities

### Core Characteristic Detectors

```typescript
export class PlanNodeCharacteristics {
  // Physical property shortcuts
  static hasSideEffects = PlanNode.hasSideEffects;
  static isReadOnly(node: PlanNode): boolean {
    return node.physical.readonly !== false;
  }
  static isDeterministic(node: PlanNode): boolean {
    return node.physical.deterministic !== false;
  }
  static isConstant(node: PlanNode): node is ConstantNode {
    return node.physical.constant === true && 'getValue' in node;
  }
  
  // Ordering capabilities
  static hasOrderedOutput(node: PlanNode): boolean {
    return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
  }
  static preservesOrdering(node: PlanNode): boolean {
    // Check if node preserves input ordering
    const children = node.getChildren();
    return children.length === 1 && this.hasOrderedOutput(children[0]);
  }
  
  // Cardinality analysis
  static estimatesRows(node: PlanNode): number {
    return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
  }
  // At-most-one-row. There is no `physical.uniqueKeys` field — the claim rides
  // the `∅ → all_cols` FD (or, for a zero-column relation, `estimatedRows`).
  static guaranteesUniqueRows(node: PlanNode): boolean {
    if (!isRelationalNode(node)) return false;
    const colCount = node.getAttributes().length;
    if (colCount === 0) return node.physical.estimatedRows === 1;
    return hasSingletonFd(node.physical.fds, colCount, node.getType().isSet);
  }
  
  // Relational capabilities
  static isRelational = isRelationalNode;
  static producesRows(node: PlanNode): node is RelationalPlanNode {
    return isRelationalNode(node);
  }
}
```

## Rule Development Guidelines

### 1. Start with Capabilities
Before writing a rule, identify what characteristics the rule needs:

```typescript
function ruleMyOptimization(node: PlanNode, context: OptContext): PlanNode | null {
  // 1. Check required capabilities
  if (!PlanNodeCharacteristics.isRelational(node)) return null;
  if (PlanNodeCharacteristics.hasSideEffects(node)) return null;
  
  // 2. Check specific interfaces if needed
  if (!isSpecializedCapability(node)) return null;
  
  // 3. Apply transformation based on characteristics
  return transformBasedOnCharacteristics(node, context);
}
```

### 2. Prefer Composition over Inheritance
Use interfaces to compose capabilities rather than relying on inheritance hierarchies:

```typescript
interface Sortable {
  getSortKeys(): readonly SortKey[];
  withSortKeys(keys: readonly SortKey[]): PlanNode;
}

interface Projectable {
  getProjections(): readonly Projection[];
  withProjections(projections: readonly Projection[]): PlanNode;
}

// Nodes implement multiple interfaces as appropriate
class SortedProjectNode implements RelationalPlanNode, Sortable, Projectable {
  // ... implementation
}
```

### 3. Document Required Characteristics
Make rule requirements explicit in documentation:

```typescript
/**
 * Rule: Predicate Pushdown
 * 
 * Required Characteristics:
 * - Node must implement PredicateCapable interface
 * - Node must be read-only (no side effects)
 * - Predicate must be deterministic
 * 
 * Applied When:
 * - Child node supports predicate pushdown
 * - Predicate references only child's output columns
 */
export function rulePushDownPredicate(node: PlanNode, context: OptContext): PlanNode | null {
  // Implementation follows documented requirements
}
```

## Benefits of This Approach

1. **Symbolic Rename Safety**: Member names can be changed without breaking optimizer
2. **Extensibility**: New node types work automatically with existing rules
3. **Maintainability**: Clear separation between node structure and optimization logic
4. **Testability**: Characteristics can be tested independently of specific nodes
5. **Documentation**: Rules self-document their requirements through capability checks

## For New Developers

When working with the optimizer or plan builders:
- **DO**: Use `CapabilityDetectors` and `PlanNodeCharacteristics` utilities
- **DON'T**: Use `instanceof` checks or hard-coded node type assumptions
- **REFERENCE**: The capability interfaces in `src/planner/framework/characteristics.ts`
- **FOLLOW**: The patterns established in existing optimization rules and builders 
