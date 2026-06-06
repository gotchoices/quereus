import type { RowDescriptor, Attribute } from '../planner/nodes/plan-node.js';
import type { Row } from '../common/types.js';
import { TEXT_TYPE } from '../types/builtin-types.js';

/**
 * Utility to build a RowDescriptor (attributeId → columnIndex mapping)
 * for any relational plan node.
 */
export function buildRowDescriptor(attributes: readonly Attribute[]): RowDescriptor {
  const descriptor: RowDescriptor = [];
  attributes.forEach((attr, index) => {
    descriptor[attr.id] = index;
  });
  return descriptor;
}

/**
 * Creates OLD and NEW row descriptors for mutation operations.
 * Returns descriptors where OLD columns are at indices 0..n-1 and NEW columns at n..2n-1
 */
export function buildOldNewRowDescriptors(
	oldAttributes: Attribute[],
	newAttributes: Attribute[]
): {
	oldRowDescriptor: RowDescriptor;
	newRowDescriptor: RowDescriptor;
	flatRowDescriptor: RowDescriptor;
} {
	const oldRowDescriptor: RowDescriptor = [];
	const newRowDescriptor: RowDescriptor = [];
	const flatRowDescriptor: RowDescriptor = [];

	// OLD attributes occupy indices 0..n-1
	oldAttributes.forEach((attr, index) => {
		oldRowDescriptor[attr.id] = index;
		flatRowDescriptor[attr.id] = index;
	});

	// NEW attributes occupy indices n..2n-1
	newAttributes.forEach((attr, index) => {
		const flatIndex = oldAttributes.length + index;
		newRowDescriptor[attr.id] = index;
		flatRowDescriptor[attr.id] = flatIndex;
	});

	return { oldRowDescriptor, newRowDescriptor, flatRowDescriptor };
}

/**
 * Composes a flat row from OLD and NEW row values.
 * Result format: [oldCol0, oldCol1, ..., oldColN, newCol0, newCol1, ..., newColN]
 */
export function composeOldNewRow(oldRow: Row | null, newRow: Row | null, columnCount: number): Row {
	const flatRow: Row = new Array(columnCount * 2);

	// Fill OLD section (indices 0..n-1)
	for (let i = 0; i < columnCount; i++) {
		flatRow[i] = oldRow ? oldRow[i] : null;
	}

	// Fill NEW section (indices n..2n-1)
	for (let i = 0; i < columnCount; i++) {
		flatRow[columnCount + i] = newRow ? newRow[i] : null;
	}

	return flatRow;
}

/**
 * Extracts NEW values from a flat OLD/NEW row
 */
export function extractNewRowFromFlat(flatRow: Row, columnCount: number): Row {
	return flatRow.slice(columnCount, columnCount * 2);
}

/**
 * Extracts OLD values from a flat OLD/NEW row
 */
export function extractOldRowFromFlat(flatRow: Row, columnCount: number): Row {
	return flatRow.slice(0, columnCount);
}

/**
 * Helper to build Attribute array from flatRowDescriptor for DML nodes.
 * This is used by UpdateNode and DeleteNode to expose their flat row layout.
 */
export function buildAttributesFromFlatDescriptor(flatRowDescriptor: RowDescriptor): Attribute[] {
	const attributes: Attribute[] = [];
	for (const attrIdStr in flatRowDescriptor) {
		const attrId = parseInt(attrIdStr);
		const index = flatRowDescriptor[attrId];
		attributes[index] = {
			id: attrId,
			name: `attr_${attrId}`,
			type: {
				typeClass: 'scalar' as const,
				logicalType: TEXT_TYPE,
				nullable: true,
				isReadOnly: false
			},
			sourceRelation: 'unknown'
		};
	}
	return attributes;
}
