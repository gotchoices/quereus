// Constants for function flags (matching C API where sensible)
export enum FunctionFlags {
	UTF8 = 1,
	// UTF16LE = 2, // Decide if UTF16 support is needed internally
	// UTF16BE = 3,
	// UTF16 = 4,
	DETERMINISTIC = 0x000000800,
	DIRECTONLY = 0x000080000,
	INNOCUOUS = 0x000200000,
	// Add others if needed (SUBTYPE, etc.)
}

// Constants for VTable configuration
export enum VTabConfig {
	CONSTRAINT_SUPPORT = 1,
	INNOCUOUS = 2,
	DIRECTONLY = 3,
	USES_ALL_SCHEMAS = 4,
}

// Constants for VTable constraint operators
export enum IndexConstraintOp {
	EQ = 2,
	GT = 4,
	LE = 8,
	LT = 16,
	GE = 32,
	MATCH = 64,
	LIKE = 65, // Requires a LIKE implementation or delegation
	GLOB = 66, // Requires a GLOB implementation or delegation
	REGEXP = 67, // Requires a REGEXP implementation or delegation
	NE = 68,
	ISNOT = 69,
	ISNOTNULL = 70,
	ISNULL = 71,
	IS = 72,
	LIMIT = 73,
	OFFSET = 74,
	IN = 75,
	FUNCTION = 150, // Base for function-based constraints
}

/**
 * Defines how to resolve a constraint conflict.
 * These correspond to SQLite's ON CONFLICT clauses.
 */
export enum ConflictResolution {
	ROLLBACK = 1,
	ABORT = 2,    // Default
	FAIL = 3,
	IGNORE = 4,
	REPLACE = 5,
}

// Constants for Changeset operations (matching C API)
export enum ChangesetOperation {
	DELETE = 9,
	INSERT = 18,
	UPDATE = 23,
}
