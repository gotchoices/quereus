import type { LogicalType } from './logical-type.js';
import {
	NULL_TYPE,
	INTEGER_TYPE,
	REAL_TYPE,
	TEXT_TYPE,
	BLOB_TYPE,
	BOOLEAN_TYPE,
	NUMERIC_TYPE,
	ANY_TYPE,
} from './builtin-types.js';
import { DATE_TYPE, TIME_TYPE, DATETIME_TYPE, TIMESTAMP_TYPE, TIMESPAN_TYPE } from './temporal-types.js';
import { JSON_TYPE } from './json-type.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

const log = createLogger('types:registry');
const warnLog = log.extend('warn');
const debugLog = log.extend('debug');

/**
 * Global type registry that maps type names to logical type definitions.
 *
 * Process-wide: every `Database` in the same JavaScript realm reads this one map, so
 * `Database.registerType` on any of them is visible to all, and registering a name again
 * replaces the earlier definition for all of them. Per-database registration would have
 * to thread a registry through db-less resolution (`columnDefToSchema`,
 * `CastNode.generateType`) and break the object-identity comparison logical types rely
 * on; `strict_type_names` instead turns a process that forgot to register into an error.
 */
class TypeRegistry {
	private types = new Map<string, LogicalType>();

	constructor() {
		// Register built-in types
		this.registerType(NULL_TYPE);
		this.registerType(INTEGER_TYPE);
		this.registerType(REAL_TYPE);
		this.registerType(TEXT_TYPE);
		this.registerType(BLOB_TYPE);
		this.registerType(BOOLEAN_TYPE);
		this.registerType(NUMERIC_TYPE);
		this.registerType(ANY_TYPE);
		this.registerType(DATE_TYPE);
		this.registerType(TIME_TYPE);
		this.registerType(DATETIME_TYPE);
		this.registerType(TIMESTAMP_TYPE);
		this.registerType(TIMESPAN_TYPE);
		this.registerType(JSON_TYPE);

		// Register common aliases
		// Temporal type aliases
		this.types.set('INTERVAL', TIMESPAN_TYPE); // SQL standard alias
		this.types.set('DURATION', TIMESPAN_TYPE); // Alternative name
		this.types.set('INT', INTEGER_TYPE);
		this.types.set('INT2', INTEGER_TYPE);
		this.types.set('INT8', INTEGER_TYPE);
		this.types.set('BIGINT', INTEGER_TYPE);
		this.types.set('SMALLINT', INTEGER_TYPE);
		this.types.set('TINYINT', INTEGER_TYPE);
		this.types.set('MEDIUMINT', INTEGER_TYPE);

		this.types.set('FLOAT', REAL_TYPE);
		this.types.set('DOUBLE', REAL_TYPE);
		this.types.set('DECIMAL', NUMERIC_TYPE);

		this.types.set('VARCHAR', TEXT_TYPE);
		this.types.set('CHAR', TEXT_TYPE);
		this.types.set('NCHAR', TEXT_TYPE);
		this.types.set('NVARCHAR', TEXT_TYPE);
		this.types.set('CHARACTER', TEXT_TYPE);
		this.types.set('CLOB', TEXT_TYPE);
		this.types.set('STRING', TEXT_TYPE);

		this.types.set('BOOL', BOOLEAN_TYPE);

		this.types.set('BYTES', BLOB_TYPE);
		this.types.set('BINARY', BLOB_TYPE);
		this.types.set('VARBINARY', BLOB_TYPE);
	}

	/**
	 * Register a new logical type.
	 * @param type The logical type to register
	 */
	registerType(type: LogicalType): void {
		const upperName = type.name.toUpperCase();
		if (this.types.has(upperName)) {
			warnLog(`Overwriting existing type: ${upperName}`);
		}
		this.types.set(upperName, type);
		debugLog(`Registered type: ${upperName}`);
	}

	/**
	 * Get a logical type by name.
	 * @param name The type name (case-insensitive)
	 * @returns The logical type, or undefined if not found
	 */
	getType(name: string): LogicalType | undefined {
		return this.types.get(name.toUpperCase());
	}

	/**
	 * The registered type a declared type name names: an exact match of the whole name,
	 * else of its base name without the `(…)` parameter list (`measure(3)` → MEASURE).
	 * No affinity rules — undefined when nothing registered matches.
	 * @param typeName The declared type name, as the parser produced it
	 */
	resolveDeclaredType(typeName: string): LogicalType | undefined {
		return this.getType(typeName) ?? this.getType(declaredTypeBase(typeName));
	}

	/**
	 * Check if a type is registered.
	 * @param name The type name (case-insensitive)
	 * @returns True if the type is registered
	 */
	hasType(name: string): boolean {
		return this.types.has(name.toUpperCase());
	}

	/**
	 * Get all registered type names.
	 * @returns Array of type names
	 */
	getTypeNames(): string[] {
		return Array.from(this.types.keys());
	}

	/**
	 * Infer logical type from a type name string: the registered type it names
	 * ({@link resolveDeclaredType}), else SQLite-style affinity rules where type names
	 * can contain keywords like "INT", "CHAR", "REAL", etc., else BLOB.
	 *
	 * The lenient resolver every site uses; a user-written name is checked first by
	 * {@link requireRegisteredTypeName} when `strict_type_names` is on, so after that
	 * check the affinity arm is never reached.
	 *
	 * @param typeName The declared type name (e.g., "VARCHAR(100)", "UNSIGNED INT")
	 * @returns The inferred logical type
	 */
	inferType(typeName: string | undefined): LogicalType {
		if (!typeName) return BLOB_TYPE;

		const registered = this.resolveDeclaredType(typeName);
		if (registered) return registered;

		const upperName = typeName.toUpperCase();

		// SQLite-style affinity rules
		// INTEGER affinity: INT
		if (upperName.includes('INT')) return INTEGER_TYPE;

		// TEXT affinity: CHAR, CLOB, TEXT
		if (upperName.includes('CHAR') || upperName.includes('CLOB') || upperName.includes('TEXT')) {
			return TEXT_TYPE;
		}

		// BLOB affinity: BLOB
		if (upperName.includes('BLOB')) return BLOB_TYPE;

		// REAL affinity: REAL, FLOA, DOUB
		if (upperName.includes('REAL') || upperName.includes('FLOA') || upperName.includes('DOUB')) {
			return REAL_TYPE;
		}

		// BOOLEAN affinity: BOOL
		if (upperName.includes('BOOL')) return BOOLEAN_TYPE;

		// NUMERIC affinity: everything else with NUMERIC, DECIMAL
		if (upperName.includes('NUMERIC') || upperName.includes('DECIMAL')) {
			return NUMERIC_TYPE;
		}

		// Default to BLOB (SQLite behavior)
		debugLog(`Unknown type '${typeName}', defaulting to BLOB`);
		return BLOB_TYPE;
	}
}

/**
 * The base of a declared type name: the text before its `(…)` parameter list, trimmed.
 * The parser yields one identifier with any parameter list glued on (`varchar(100)`,
 * `decimal(10,5)`), so the first `(` is where the parameters start.
 */
function declaredTypeBase(typeName: string): string {
	const paren = typeName.indexOf('(');
	return (paren < 0 ? typeName : typeName.slice(0, paren)).trim();
}

// Global singleton instance
export const typeRegistry = new TypeRegistry();

/**
 * Register a custom logical type.
 * @param type The logical type to register
 */
export function registerType(type: LogicalType): void {
	typeRegistry.registerType(type);
}

/**
 * Get a logical type by name.
 * @param name The type name (case-insensitive)
 * @returns The logical type, or undefined if not found
 */
export function getType(name: string): LogicalType | undefined {
	return typeRegistry.getType(name);
}

/**
 * Infer logical type from a type name string.
 * @param typeName The declared type name
 * @returns The inferred logical type
 */
export function inferType(typeName: string | undefined): LogicalType {
	return typeRegistry.inferType(typeName);
}

/** The database options {@link requireRegisteredTypeName} reads — structural, so types/ does not depend on core/. */
export interface TypeNameOptions {
	getBooleanOption(key: string): boolean;
}

/**
 * Refuse a user-written type name that names no registered type, when the database's
 * `strict_type_names` option is on. Called where a declared or cast type name enters
 * (CREATE TABLE and catalog rehydrate, mutation-context variables, ALTER TABLE ADD
 * COLUMN / SET DATA TYPE, `declare schema`, user-written `cast`), so the lenient
 * {@link inferType} behind them only ever sees names this check accepted. With the
 * option off, the SQLite affinity rules and the BLOB fallback apply as before.
 *
 * @param typeName The name as written; an omitted type (undefined) is not checked
 * @param subject What the name types, for the message — e.g. `column 'v' of table 'main.u'`
 * @param loc Source position of the statement or expression, when known
 */
export function requireRegisteredTypeName(
	options: TypeNameOptions,
	typeName: string | undefined,
	subject: string,
	loc?: { line: number; column: number },
): void {
	if (typeName === undefined || !options.getBooleanOption('strict_type_names')) return;
	if (typeRegistry.resolveDeclaredType(typeName)) return;
	throw new QuereusError(
		`Unknown type '${typeName}' for ${subject}: register the type (Database.registerType) before using it, `
		+ 'or set pragma strict_type_names = false to apply SQLite affinity rules instead',
		StatusCode.ERROR,
		undefined,
		loc?.line,
		loc?.column,
	);
}
