import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { extractTableSchema, checkFkPkAlignment } from '../../util/key-utils.js';

const log = createLogger('optimizer:rule:join-key-inference');

/**
 * Rule: Join Key Inference
 *
 * Detects equi-join predicates and FK→PK relationships between join sides.
 * When an FK→PK alignment is found, the PK side's key is guaranteed to be
 * covered (each FK row matches ≤1 PK row), so computePhysical already handles
 * cardinality reduction. This rule logs the detection for diagnostics.
 *
 * The real work happens in:
 * - analyzeJoinKeyCoverage (key-utils.ts): unique key preservation + estimatedRows
 * - CatalogStatsProvider.joinSelectivity: FK-aware selectivity = 1/ndv_pk
 */
export function ruleJoinKeyInference(node: PlanNode, _context: OptContext): PlanNode | null {
  if (!(node instanceof JoinNode)) return null;
  if (node.joinType !== 'inner' && node.joinType !== 'cross') return null;

  const leftAttrs = node.left.getAttributes();
  const rightAttrs = node.right.getAttributes();
  const pairs = extractEquiPairsFromCondition(node.condition, leftAttrs, rightAttrs);
  if (pairs.length === 0) return null;

  // Check for FK→PK alignment
  const leftSchema = extractTableSchema(node.left as RelationalPlanNode);
  const rightSchema = extractTableSchema(node.right as RelationalPlanNode);

  if (leftSchema && rightSchema) {
    const leftFkIndices = pairs.map(p => p.left);
    const rightFkIndices = pairs.map(p => p.right);

    if (checkFkPkAlignment(leftSchema, rightSchema, leftFkIndices, rightFkIndices)) {
      log('FK→PK detected: %s.FK → %s.PK; PK-side key covered by equi-join',
        leftSchema.name, rightSchema.name);
    } else if (checkFkPkAlignment(rightSchema, leftSchema, rightFkIndices, leftFkIndices)) {
      log('FK→PK detected: %s.FK → %s.PK; PK-side key covered by equi-join',
        rightSchema.name, leftSchema.name);
    }
  }

  // No structural transformation needed — computePhysical handles key preservation
  return null;
}
