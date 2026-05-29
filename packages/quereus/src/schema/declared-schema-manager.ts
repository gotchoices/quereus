import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:declared');

/**
 * Manages declared schemas and their associated seed data
 */
export class DeclaredSchemaManager {
	private declaredSchemas: Map<string, AST.DeclareSchemaStmt> = new Map();
	private seedData: Map<string, Map<string, SqlValue[][]>> = new Map(); // schemaName -> tableName -> rows
	/** Lens blocks keyed by *logical* schema name (the `for X` of `declare lens for X over Y`). */
	private lensDeclarations: Map<string, AST.DeclareLensStmt> = new Map();

	/**
	 * Stores a declared schema
	 */
	setDeclaredSchema(schemaName: string, declaration: AST.DeclareSchemaStmt): void {
		this.declaredSchemas.set(schemaName.toLowerCase(), declaration);
		log('Stored declared schema for: %s', schemaName);
	}

	/**
	 * Retrieves a declared schema
	 */
	getDeclaredSchema(schemaName: string): AST.DeclareSchemaStmt | undefined {
		return this.declaredSchemas.get(schemaName.toLowerCase());
	}

	/**
	 * Checks if a schema has been declared
	 */
	hasDeclaredSchema(schemaName: string): boolean {
		return this.declaredSchemas.has(schemaName.toLowerCase());
	}

	/**
	 * Stores seed data for a table in a schema
	 */
	setSeedData(schemaName: string, tableName: string, rows: SqlValue[][]): void {
		const lowerSchema = schemaName.toLowerCase();
		if (!this.seedData.has(lowerSchema)) {
			this.seedData.set(lowerSchema, new Map());
		}
		const schemaSeedData = this.seedData.get(lowerSchema)!;
		schemaSeedData.set(tableName.toLowerCase(), rows);
		log('Stored seed data for %s.%s (%d rows)', schemaName, tableName, rows.length);
	}

	/**
	 * Retrieves seed data for a table
	 */
	getSeedData(schemaName: string, tableName: string): SqlValue[][] | undefined {
		const schemaSeedData = this.seedData.get(schemaName.toLowerCase());
		if (!schemaSeedData) return undefined;
		return schemaSeedData.get(tableName.toLowerCase());
	}

	/**
	 * Gets all seed data for a schema
	 */
	getAllSeedData(schemaName: string): Map<string, SqlValue[][]> {
		return this.seedData.get(schemaName.toLowerCase()) || new Map();
	}

	/**
	 * Clears all seed data for a schema
	 */
	clearSeedData(schemaName: string): void {
		this.seedData.delete(schemaName.toLowerCase());
		log('Cleared seed data for: %s', schemaName);
	}

	/**
	 * Removes a declared schema and its seed data
	 */
	removeDeclaredSchema(schemaName: string): void {
		this.declaredSchemas.delete(schemaName.toLowerCase());
		this.seedData.delete(schemaName.toLowerCase());
		this.lensDeclarations.delete(schemaName.toLowerCase());
		log('Removed declared schema: %s', schemaName);
	}

	/**
	 * Stores (replacing any prior) the lens block for a logical schema. Keyed by
	 * the logical schema name (`for X`); re-declaring a lens for X overwrites,
	 * matching `declare schema`'s overwrite-on-redeclare. See docs/lens.md § D1.
	 */
	setLensDeclaration(logicalSchemaName: string, declaration: AST.DeclareLensStmt): void {
		this.lensDeclarations.set(logicalSchemaName.toLowerCase(), declaration);
		log('Stored lens declaration for: %s', logicalSchemaName);
	}

	/** Retrieves the lens block declared for a logical schema, if any. */
	getLensDeclaration(logicalSchemaName: string): AST.DeclareLensStmt | undefined {
		return this.lensDeclarations.get(logicalSchemaName.toLowerCase());
	}
}

