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

**Key conventions for FD-aware rules:**

1. **Reason via `computeClosure` / `determines` / `closureCoversAll` / `isUniqueDeterminant` / `hasAnyKey` / `hasSingletonFd`.** Walking `physical.fds` by hand will miss transitive closure and forget the subsumption / cap / guard semantics that `addFd` enforces. **Pick coverage vs uniqueness deliberately**: `closureCoversAll` is a pure value claim (a determined column is redundant in an ORDER BY / GROUP BY regardless of uniqueness); `isUniqueDeterminant(attrs, fds, columnCount, isSet)` is the only sound way to ask "is this set row-unique?" — coverage alone over a bag proves nothing (see [Optimizer § The reader rule](optimizer.md#the-reader-rule-isuniquedeterminant)).
2. **Guarded FDs are not closure-time facts.** All closure helpers (`computeClosure`, `determines`, `closureCoversAll`, `isUniqueDeterminant`, `hasAnyKey`, `hasSingletonFd`, `deriveKeysFromFds`) **skip** guarded FDs by design — a conditional uniqueness claim cannot prove a key (nor serve as a `'unique'` witness) for an unrelated subtree. If your rule needs to discharge a guard, do it at the producing `Filter`'s `computePhysical` via `predicateImpliesGuard` + `stripGuard`, never at the consumer.
3. **Column index space.** FDs / ECs / bindings are indexed by **output-column index** on the node carrying them, not by attribute ID. When you cross a Project / Returning / Aggregate / join boundary, translate via `projectFds` / `shiftFds` (and their EC / binding / domain mirrors) instead of hand-mapping. `shiftFds` shifts guard column indices alongside determinants/dependents; `projectFds` drops a guarded FD whose guard references a column missing from the mapping.
4. **Use `addFd` (not `Array.push`) when accumulating FDs.** `addFd` performs subsumption (drop existing same-determinant FDs whose dependent set is a subset of the new one) and enforces `MAX_FDS_PER_NODE`. Pass `{ keyHints }` listing column-index sets that are known keys so cap eviction prefers to keep them; truncations are logged on the `quereus:planner:fd` debug channel.
5. **Equivalence-class closure for bindings.** Whenever a rule adds a `ConstantBinding` at the same site as ECs (Filter, inner join), close it with `closeConstantBindingsOverEcs` so downstream consumers see the binding on every EC peer in a single pass. This is what makes `WHERE t.k = u.k AND t.k = 5` land as one binding covering both columns.
6. **Outer joins drop the null-padded side.** Inheriting "everything from both children" is wrong for LEFT/RIGHT/FULL: NULL padding violates source FDs/ECs/bindings on the padded side, and a guarded FD whose guard references a NULL-padded column would also become activatable for the wrong rows. Follow the per-operator table in [Optimizer § Functional Dependency Tracking](optimizer.md#functional-dependency-tracking) rather than inventing a propagation policy.
7. **Set semantics is not an FD — but the readers consume it.** "All output columns together form a key" lives on `RelationType.isSet`, not in `fds`. The kind-aware readers take it as a parameter (`hasAnyKey(fds, columnCount, isSet)` / `hasSingletonFd(fds, columnCount, isSet)` / `isUniqueDeterminant(…, isSet)`); node-level consumers should prefer `keysOf` / `isUnique`, which read `getType().isSet` themselves.
8. **Provenance is informational.** FD / `ConstantBinding` / `DomainConstraint` entries may carry a `source` tag (`'declared-check'`, `{kind: 'assertion', name}`, etc.). Dedup helpers ignore `source` by design — never branch rule logic on it.

See [Optimizer § Functional Dependency Tracking](optimizer.md#functional-dependency-tracking) for the producer/consumer catalog and the per-operator propagation table, and [Optimizer § Binding-aware Delta Planning](optimizer.md#binding-aware-delta-planning-reusable) for the `analyzeRowSpecific` / `extractBindings` analysis surface that builds on this layer.

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
  static guaranteesUniqueRows(node: PlanNode): boolean {
    return node.physical.uniqueKeys?.some(key => key.length === 0) === true;
  }
  
  // Relational capabilities
  static isRelational = isRelationalNode;
  static producesRows(node: PlanNode): node is RelationalPlanNode {
    return isRelationalNode(node);
  }
}
```

### Capability Interface Registry

```typescript
export class CapabilityRegistry {
  private static readonly detectors = new Map<string, (node: PlanNode) => boolean>();
  
  static register<T extends PlanNode>(
    capability: string,
    detector: (node: PlanNode) => node is T
  ): void {
    this.detectors.set(capability, detector);
  }
  
  static hasCapability(node: PlanNode, capability: string): boolean {
    const detector = this.detectors.get(capability);
    return detector ? detector(node) : false;
  }
  
  static getCapable<T extends PlanNode>(
    nodes: readonly PlanNode[], 
    capability: string
  ): T[] {
    const detector = this.detectors.get(capability);
    if (!detector) return [];
    return nodes.filter(detector) as T[];
  }
}

// Usage in rules:
CapabilityRegistry.register('predicate-pushdown', canPushDownPredicate);
CapabilityRegistry.register('table-access', isTableAccess);
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
