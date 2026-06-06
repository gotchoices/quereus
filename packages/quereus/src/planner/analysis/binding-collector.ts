import type { PlanNode, ScalarPlanNode } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { TableReferenceNode, ColumnReferenceNode } from '../nodes/reference.js';

function buildAttrIdSet(tableRef: TableReferenceNode): Set<number> {
	const set = new Set<number>();
	for (const attr of tableRef.getAttributes()) set.add(attr.id);
	return set;
}

export function collectBindingsInExpr(expr: ScalarPlanNode, tableRef: TableReferenceNode): ScalarPlanNode[] {
	const targetAttrIds = buildAttrIdSet(tableRef);
	const result: ScalarPlanNode[] = [];

	function walkScalar(node: ScalarPlanNode): void {
		// Parameter bindings
		if (node.nodeType === PlanNodeType.ParameterReference) {
			result.push(node);
			return;
		}
		// Correlated column refs (not produced by tableRef)
		if (node.nodeType === PlanNodeType.ColumnReference) {
			const col = node as unknown as ColumnReferenceNode;
			if (!targetAttrIds.has(col.attributeId)) {
				result.push(node);
				return;
			}
		}
		// Recurse into scalar children
		for (const child of node.getChildren()) {
			// child here should also be scalar nodes
			walkScalar(child as unknown as ScalarPlanNode);
		}
	}

	walkScalar(expr);
	return dedupeById(result);
}

export function collectBindingsInPlan(plan: PlanNode, tableRef: TableReferenceNode): ScalarPlanNode[] {
	const targetAttrIds = buildAttrIdSet(tableRef);
	const result: ScalarPlanNode[] = [];

	function walk(node: PlanNode): void {
		if (!isRelationalNode(node)) {
			// Scalar node
			const scalar = node as unknown as ScalarPlanNode;
			if (scalar.nodeType === PlanNodeType.ParameterReference) {
				result.push(scalar);
				return;
			}
			if (scalar.nodeType === PlanNodeType.ColumnReference) {
				const col = scalar as unknown as ColumnReferenceNode;
				if (!targetAttrIds.has(col.attributeId)) {
					result.push(scalar);
					return;
				}
			}
		}
		// Recurse into all children (relational and scalar)
		for (const child of node.getChildren()) {
			walk(child);
		}
	}

	walk(plan);
	return dedupeById(result);
}

function dedupeById(nodes: ScalarPlanNode[]): ScalarPlanNode[] {
	const seen = new Set<string>();
	const out: ScalarPlanNode[] = [];
	for (const n of nodes) {
		if (!seen.has(n.id)) {
			seen.add(n.id);
			out.push(n);
		}
	}
	return out;
}


