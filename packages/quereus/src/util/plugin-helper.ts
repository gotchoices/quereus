/**
 * Plugin registration helper for static plugin loading
 *
 * This module provides utilities for registering plugins without dynamic imports,
 * which is useful for React Native and other environments where dynamic imports
 * are not supported.
 */

import type { Database } from '../core/database.js';
import type { PluginRegistrations } from '../vtab/manifest.js';
import type { SqlValue } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Plugin function type - what a plugin exports as its default export
 */
export type PluginFunction = (
	db: Database,
	config?: Record<string, SqlValue>
) => Promise<PluginRegistrations> | PluginRegistrations;

function registerItems<T>(
	items: T[] | undefined,
	registerFn: (item: T) => void,
	errorPrefixFn: (item: T) => string
): void {
	if (!items) return;

	for (const item of items) {
		try {
			registerFn(item);
		} catch (error) {
			throw new QuereusError(
				`${errorPrefixFn(item)}: ${errorMessage(error)}`,
				StatusCode.ERROR,
				error instanceof Error ? error : undefined
			);
		}
	}
}

/**
 * Register a plugin's components with the database.
 *
 * This is a helper function for static plugin loading that handles calling
 * the plugin function and registering all returned components (vtables,
 * functions, collations, types) with the database.
 *
 * @param db Database instance to register with
 * @param plugin Plugin function (the default export from a plugin module)
 * @param config Optional configuration object to pass to the plugin
 *
 * @example
 * ```typescript
 * import { Database } from '@quereus/quereus';
 * import { registerPlugin } from '@quereus/quereus';
 * import myPlugin from './plugins/my-plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, myPlugin, { apiKey: 'secret' });
 * ```
 *
 * @example
 * ```typescript
 * // Register multiple plugins
 * await registerPlugin(db, stringFunctions);
 * await registerPlugin(db, customCollations);
 * await registerPlugin(db, jsonTable, { cacheSize: 100 });
 * ```
 */
export async function registerPlugin(
	db: Database,
	plugin: PluginFunction,
	config: Record<string, SqlValue> = {}
): Promise<void> {
	const registrations = await plugin(db, config);

	registerItems(
		registrations.vtables,
		(vtable) => db.registerModule(vtable.name, vtable.module, vtable.auxData),
		(vtable) => `Failed to register vtable module '${vtable.name}'`
	);

	registerItems(
		registrations.functions,
		(func) => db.registerFunction(func.schema),
		(func) => `Failed to register function '${func.schema.name}/${func.schema.numArgs}'`
	);

	registerItems(
		registrations.collations,
		(collation) => db.registerCollation(collation.name, collation.func, collation.normalizer),
		(collation) => `Failed to register collation '${collation.name}'`
	);

	registerItems(
		registrations.types,
		(type) => db.registerType(type.name, type.definition),
		(type) => `Failed to register type '${type.name}'`
	);
}
