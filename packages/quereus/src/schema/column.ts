import type { Expression } from '../parser/ast.js';
import type { LogicalType } from '../types/logical-type.js';
import type { SqlValue } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';
import { TEXT_TYPE } from '../types/builtin-types.js';

/**
 * Represents the schema definition of a single column in a table.
 */
export interface ColumnSchema {
	/** Column name */
	name: string;
	/** Logical type definition */
	logicalType: LogicalType;
	/** Whether the column has a NOT NULL constraint */
	notNull: boolean;
	/** Whether the column is part of the primary key */
	primaryKey: boolean;
	/** Order within the primary key (1-based) or 0 if not PK */
	pkOrder: number;
	/** Default value expression */
	defaultValue: Expression | null;
	/** Declared collation sequence name (e.g., "BINARY", "NOCASE", "RTRIM") */
	collation: string;
	/**
	 * Whether `collation` came from an explicit `COLLATE` clause (true) rather than
	 * the implicit default (undefined). Lets a module distinguish a user-declared
	 * collation from the default — e.g. the store module keys an *explicit* per-column
	 * PK collation natively but applies its own table-level default collation to an
	 * *implicit*-default text PK column. Purely informational; absent ⇒ implicit.
	 */
	collationExplicit?: boolean;
	/** Whether the column is generated (GENERATED ALWAYS AS) */
	generated: boolean;
	/** AST expression for generated columns */
	generatedExpr?: Expression;
	/** Whether the generated value is stored (true) or virtual/computed on read (false) */
	generatedStored?: boolean;
	/** Sort direction for primary key ('asc' | 'desc') */
	pkDirection?: 'asc' | 'desc';
	/**
	 * Default conflict resolution declared at the column level for this column's
	 * NOT NULL / PK constraint (e.g., `name TEXT NOT NULL ON CONFLICT IGNORE`).
	 * Statement-level OR clauses override this; if both are absent the action is ABORT.
	 */
	defaultConflict?: ConflictResolution;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Creates a default ColumnSchema with basic properties
 * Following Third Manifesto principles, columns default to NOT NULL unless explicitly specified otherwise
 *
 * @param name The name for the column
 * @param defaultNotNull Whether columns should be NOT NULL by default (defaults to true for Third Manifesto compliance)
 * @returns A new column schema with default values
 */
export function createDefaultColumnSchema(name: string, defaultNotNull: boolean = true): ColumnSchema {
	return {
		name: name,
		logicalType: TEXT_TYPE,
		notNull: defaultNotNull, // Third Manifesto: default to NOT NULL
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY', // SQLite's default
		generated: false,
	};
}
