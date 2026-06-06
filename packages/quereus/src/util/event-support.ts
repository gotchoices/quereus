/**
 * Utilities for checking native event support in virtual table modules and instances.
 */

/**
 * Check if an object (module or virtual table instance) has native event support via getEventEmitter.
 * Returns true if the object has a getEventEmitter function that returns a defined value.
 *
 * This is used to determine whether automatic event emission should be performed
 * for schema/data changes, or whether the module handles its own events natively.
 *
 * @param obj The virtual table module or instance to check
 * @returns true if the object has native event support
 */
export function hasNativeEventSupport(obj: unknown): boolean {
	const asEventSource = obj as { getEventEmitter?: () => unknown } | undefined;
	if (typeof asEventSource?.getEventEmitter !== 'function') return false;
	return asEventSource.getEventEmitter() !== undefined;
}
