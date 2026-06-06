import type { RowDescriptor } from '../planner/nodes/plan-node.js';

/**
 * Composes a combined row descriptor that includes both context and flat descriptors.
 * Context attributes come first, followed by flat attributes with offset indices.
 */
export function composeCombinedDescriptor(contextDescriptor: RowDescriptor, flatRowDescriptor: RowDescriptor): RowDescriptor {
	const combined: RowDescriptor = [];
	const contextLength = Object.keys(contextDescriptor).filter(k => contextDescriptor[parseInt(k)] !== undefined).length;

	// Copy context descriptor as-is (indices 0..contextLength-1)
	for (const attrIdStr in contextDescriptor) {
		const attrId = parseInt(attrIdStr);
		if (contextDescriptor[attrId] !== undefined) {
			combined[attrId] = contextDescriptor[attrId];
		}
	}

	// Copy flat descriptor with offset indices (indices contextLength..end)
	for (const attrIdStr in flatRowDescriptor) {
		const attrId = parseInt(attrIdStr);
		if (flatRowDescriptor[attrId] !== undefined) {
			combined[attrId] = flatRowDescriptor[attrId] + contextLength;
		}
	}

	return combined;
}

