import type { EmissionContext } from '../emission-context.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { createLogger } from '../../common/logger.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { collectSchemaCatalog } from '../../schema/catalog.js';
import { computeSchemaDiff, generateMigrationDDL } from '../../schema/schema-differ.js';
import { computeShortSchemaHash } from '../../schema/schema-hasher.js';
import { deployLogicalSchema } from '../../schema/lens-compiler.js';
import type * as AST from '../../parser/ast.js';
import type { PlanNode } from '../../planner/nodes/plan-node.js';
import type { Database } from '../../core/database.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';

const log = createLogger('runtime:emit:declare');

/** Cross-platform Uint8Array to hex string (no Node Buffer dependency). */
function uint8ArrayToHex(bytes: Uint8Array): string {
	let hex = '';
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0');
	}
	return hex;
}

/** Render a seed value as a SQL literal for a generated INSERT statement. */
function formatSeedValue(v: SqlValue): string {
	return (
		v === null ? 'NULL' :
		typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` :
		typeof v === 'number' || typeof v === 'bigint' ? String(v) :
		typeof v === 'boolean' ? (v ? '1' : '0') :
		v instanceof Uint8Array ? `X'${uint8ArrayToHex(v)}'` :
		'NULL'
	);
}

export function emitDeclareSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const declareStmt = (plan as unknown as { statementAst: AST.DeclareSchemaStmt }).statementAst;

	const run = (rctx: RuntimeContext): Row => {
		const schemaName = declareStmt.schemaName || 'main';
		log('DECLARE SCHEMA %s', schemaName);

		// Clear previous declaration and seed data for this schema
		rctx.db.declaredSchemaManager.clearSeedData(schemaName);

		// Store the declared schema
		rctx.db.declaredSchemaManager.setDeclaredSchema(schemaName, declareStmt);

		// Process seed data if present
		for (const item of declareStmt.items) {
			if (item.type === 'declaredSeed' && item.seedData) {
				const tableName = item.tableName;
				const rows = Array.from(item.seedData) as Array<SqlValue[]>;
				rctx.db.declaredSchemaManager.setSeedData(schemaName, tableName, rows);
				log('Stored seed data for %s.%s (%d rows)', schemaName, tableName, rows.length);
			}
		}

		// Return empty row to satisfy type system (void result)
		return [];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `declare schema ${declareStmt.schemaName || 'main'}`
	};
}

export function emitDeclareLens(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const lensStmt = (plan as unknown as { statementAst: AST.DeclareLensStmt }).statementAst;

	const run = (rctx: RuntimeContext): Row => {
		const logicalSchema = lensStmt.logicalSchema;
		log('DECLARE LENS for %s over %s', logicalSchema, lensStmt.basisSchema);

		// Re-declaration is an error at the per-table grain: two `view T as` for
		// the same logical table within one block (see docs/lens.md § D1).
		const seen = new Set<string>();
		for (const ov of lensStmt.overrides) {
			const key = ov.table.toLowerCase();
			if (seen.has(key)) {
				throw new QuereusError(
					`lens: duplicate override 'view ${ov.table} as ...' for logical table '${logicalSchema}.${ov.table}' in one lens block`,
					StatusCode.ERROR,
				);
			}
			seen.add(key);
		}

		// Store keyed by logical schema name; re-applied (and re-read from source)
		// on every `apply schema X`, so overrides survive baseline regeneration.
		rctx.db.declaredSchemaManager.setLensDeclaration(logicalSchema, lensStmt);

		// Void result.
		return [];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `declare lens for ${lensStmt.logicalSchema} over ${lensStmt.basisSchema}`,
	};
}

export function emitDiffSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const diffStmt = (plan as unknown as { statementAst: AST.DiffSchemaStmt }).statementAst;

	const run = async function* (rctx: RuntimeContext): AsyncIterable<Row> {
		const schemaName = diffStmt.schemaName || 'main';
		log('DIFF SCHEMA %s', schemaName);

		// Get declared schema
		const declaredSchema = rctx.db.declaredSchemaManager.getDeclaredSchema(schemaName);
		if (!declaredSchema) {
			throw new QuereusError(`No declared schema found for '${schemaName}'`, StatusCode.ERROR);
		}

		// Collect actual catalog
		const actualCatalog = collectSchemaCatalog(rctx.db, schemaName);

		// Compute diff. Thread the live default_collation so an omitted-COLLATE
		// declared column resolves to the same effective collation the CREATE path
		// would produce (parity + idempotency under a non-BINARY default).
		const diff = computeSchemaDiff(declaredSchema, actualCatalog, 'allow', rctx.db.options.getStringOption('default_collation'));

		// Generate migration DDL statements
		const migrationStatements = generateMigrationDDL(diff, schemaName);

		// Return each DDL statement as a row
		// This allows users to fetch the DDL and execute it themselves with custom logic
		for (const ddl of migrationStatements) {
			yield [ddl];
		}
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `diff schema ${diffStmt.schemaName || 'main'}`
	};
}

export function emitApplySchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const applyStmt = (plan as unknown as { statementAst: AST.ApplySchemaStmt }).statementAst;

	const run = async (rctx: RuntimeContext): Promise<Row> => {
		const schemaName = applyStmt.schemaName || 'main';
		log('APPLY SCHEMA %s', schemaName);

		// Get declared schema
		const declaredSchema = rctx.db.declaredSchemaManager.getDeclaredSchema(schemaName);
		if (!declaredSchema) {
			throw new QuereusError(`No declared schema found for '${schemaName}'`, StatusCode.ERROR);
		}

		const lowerSchemaName = schemaName.toLowerCase();

		// Logical schema: deploy the lens layer instead of diffing + migrating
		// basis storage. The compiler builds slots, compiles the effective body
		// per logical table, and registers each as a ViewSchema. No basis DDL is
		// generated. See docs/lens.md § Deployment Is a Compile Step.
		if (declaredSchema.isLogical) {
			if (lowerSchemaName === 'main' || lowerSchemaName === 'temp') {
				throw new QuereusError(
					`lens: a logical schema cannot target the reserved schema '${schemaName}'`,
					StatusCode.ERROR,
				);
			}
			const existing = rctx.db.schemaManager.getSchema(schemaName);
			if (!existing) {
				rctx.db.schemaManager.addSchema(schemaName, 'logical');
				log('Created logical schema: %s', schemaName);
			} else if (existing.kind !== 'logical') {
				throw new QuereusError(
					`lens: schema '${schemaName}' already exists as a physical schema; cannot re-deploy it as logical`,
					StatusCode.ERROR,
				);
			}
			deployLogicalSchema(rctx.db, declaredSchema, schemaName);
			// Hand the freshly-deployed snapshot to every registered module so a
			// basis-backing module can reconcile its storage against the new lens.
			// Fires only on a successful deploy (an atomic deploy throws before
			// reaching here on any blocking diagnostic). See docs/lens.md
			// § Module deployment notification.
			await notifyLensDeploymentAll(rctx.db, schemaName);
			return [];
		}

		// Ensure the target schema exists (create if it doesn't, except for main/temp)
		if (lowerSchemaName !== 'main' && lowerSchemaName !== 'temp') {
			if (!rctx.db.schemaManager.getSchema(schemaName)) {
				rctx.db.schemaManager.addSchema(schemaName);
				log('Created schema: %s', schemaName);
			}
		}

		// Collect actual catalog
		const actualCatalog = collectSchemaCatalog(rctx.db, schemaName);

		// Compute diff (default rename_policy = 'allow' when unspecified). Thread the
		// live default_collation so an omitted-COLLATE declared column resolves to the
		// same effective collation the CREATE path produces — keeping a fresh apply at
		// parity with direct DDL and a re-apply idempotent under a non-BINARY default.
		const diff = computeSchemaDiff(declaredSchema, actualCatalog, applyStmt.options?.renamePolicy ?? 'allow', rctx.db.options.getStringOption('default_collation'));

		// Acknowledgement gate: a backing-module change on a maintained table is a
		// destructive incarnation-minting move (drop + recreate — fires
		// materialized_view_removed then _added, so row identity changes for a
		// replicated/synced table). Refuse to execute it unless the user opted in via
		// `options (allow_destructive = true)`. The whole apply aborts here, BEFORE any
		// DDL runs, so no partial migration occurs. (`diff schema` does NOT gate — it
		// is a read-only preview and surfaces the DROP/recreate DDL unconditionally.)
		if (diff.maintainedModuleMigrations.length > 0 && !applyStmt.options?.allowDestructive) {
			const names = diff.maintainedModuleMigrations.map(m => `'${m.name}'`).join(', ');
			throw new QuereusError(
				`apply schema '${schemaName}': backing-module change on maintained table(s) ${names} is destructive ` +
				`(drop + recreate, new incarnation). Re-run with options (allow_destructive = true) to migrate the backing.`,
				StatusCode.ERROR,
			);
		}

		// Generate migration DDL
		const migrationStatements = generateMigrationDDL(diff, schemaName);

		// Run the migration loop. When there are no statements we keep the
		// idempotency fast-path: no module batch hooks fire.
		if (migrationStatements.length > 0) {
			await runBatchedMigrationLoop(rctx.db, schemaName, migrationStatements);
		}

		// Apply seed data if requested.
		//
		// Seed application is idempotent: each row is written with `INSERT OR IGNORE`.
		// An existing row (matching PK) is left completely untouched — user edits
		// survive a reopen reseed and no ON DELETE CASCADE fires for a parent row
		// whose values are unchanged (OR REPLACE would delete-then-insert even when
		// the replacement values are identical, triggering cascades unnecessarily).
		// A freshly-created table has no existing rows, so OR IGNORE inserts all seed
		// rows on the first apply.
		//
		// Historical note: the original implementation used DELETE-then-INSERT, then
		// OR REPLACE. The delete path was dropped because `DELETE FROM <tbl>` routes
		// through the host's snapshot resolver at `asOf(ep.startedAt)` and faults on
		// a freshly-created table that predates the snapshot. OR REPLACE fixed the
		// crash but fired ON DELETE CASCADE on every reopen for unchanged seed parents.
		// OR IGNORE is the final form: no scan, no cascade, user edits preserved.
		if (applyStmt.withSeed) {
			const allSeedData = rctx.db.declaredSchemaManager.getAllSeedData(schemaName);
			log('Seed data available for %d tables', allSeedData.size);
			for (const [tableName, rows] of allSeedData) {
				if (rows.length === 0) continue;
				log('Applying seed data to %s.%s (%d rows)', schemaName, tableName, rows.length);

				// Qualify table name with schema if not main
				const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
					? `${schemaName}.${tableName}`
					: tableName;

				// One idempotent insert per seed row, batched in a single exec.
				// OR IGNORE: an existing row (matching PK) is left untouched, so user
				// edits survive a reopen reseed and no ON DELETE CASCADE fires for
				// unchanged rows.
				const seedSql = rows.map(row => {
					const values = row.map(formatSeedValue).join(', ');
					return `INSERT OR IGNORE INTO ${qualifiedTableName} VALUES (${values})`;
				}).join('; ');

				log('Executing seed SQL (length=%d): %s', seedSql.length, seedSql);
				try {
					await rctx.db._execWithinTransaction(seedSql);
					log('Seed application succeeded for table %s', tableName);
				} catch (e) {
					log('Seed application failed for table %s: %O', tableName, e);
					const errorMessage = e instanceof Error ? e.message : String(e);
					throw new QuereusError(
						`Failed to apply seed data for table ${tableName}. SQL: ${seedSql}\nError: ${errorMessage}`,
						StatusCode.ERROR,
						e instanceof Error ? e : undefined
					);
				}
			}
		}

		// Return empty row to satisfy type system (void result)
		return [];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `apply schema ${applyStmt.schemaName || 'main'}${applyStmt.withSeed ? ' with seed' : ''}`
	};
}

export function emitExplainSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const explainStmt = (plan as unknown as { statementAst: AST.ExplainSchemaStmt }).statementAst;

	const run = async function* (rctx: RuntimeContext): AsyncIterable<Row> {
		const schemaName = explainStmt.schemaName || 'main';
		log('EXPLAIN SCHEMA %s', schemaName);

		// Get declared schema
		const declaredSchema = rctx.db.declaredSchemaManager.getDeclaredSchema(schemaName);
		if (!declaredSchema) {
			throw new QuereusError(`No declared schema found for '${schemaName}'`, StatusCode.ERROR);
		}

		// Compute hash
		const hash = computeShortSchemaHash(declaredSchema);

		// Return hash with version if specified
		const result = explainStmt.version
			? `version:${explainStmt.version},hash:${hash}`
			: `hash:${hash}`;

		yield [result];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `explain schema ${explainStmt.schemaName || 'main'}`
	};
}

/**
 * Drives the per-DDL migration loop wrapped in module-level batch hooks.
 * Modules that opt in via `beginSchemaBatch` may fold the entire
 * APPLY SCHEMA into a single substrate commit. Modules without the hook
 * pay nothing — they're filtered out before the loop.
 */
async function runBatchedMigrationLoop(
	db: Database,
	schemaName: string,
	migrationStatements: readonly string[],
): Promise<void> {
	const startedModules = await beginSchemaBatchAll(db, schemaName);
	let loopError: unknown;
	try {
		for (const ddl of migrationStatements) {
			log('Executing migration DDL: %s', ddl);
			try {
				await db._execWithinTransaction(ddl);
			} catch (e) {
				log('Migration failed for DDL: %s', ddl);
				const errorMessage = e instanceof Error ? e.message : String(e);
				throw new QuereusError(
					`Failed to execute DDL: ${ddl}\nError: ${errorMessage}`,
					StatusCode.ERROR,
					e instanceof Error ? e : undefined
				);
			}
		}
	} catch (e) {
		loopError = e;
		throw e;
	} finally {
		await endSchemaBatchAll(startedModules, db, schemaName, loopError);
	}
}

interface StartedModule {
	name: string;
	module: AnyVirtualTableModule;
}

/**
 * Calls `beginSchemaBatch` on every module that defines it, in registration
 * order. Returns the modules that successfully began. If any module's
 * begin throws, already-started modules are torn down (in reverse order)
 * with the begin-time error and the original failure is rethrown.
 */
async function beginSchemaBatchAll(
	db: Database,
	schemaName: string,
): Promise<StartedModule[]> {
	const started: StartedModule[] = [];
	for (const { name, module } of db.schemaManager.allModules()) {
		if (typeof module.beginSchemaBatch !== 'function') continue;
		try {
			await module.beginSchemaBatch(db, schemaName);
			started.push({ name, module });
		} catch (e) {
			log('beginSchemaBatch failed for module %s: %O', name, e);
			await endSchemaBatchAll(started, db, schemaName, e);
			throw e;
		}
	}
	return started;
}

/**
 * Calls `endSchemaBatch` on previously-started modules in reverse order.
 * On success path (`loopError === undefined`), the first end-error is
 * captured and rethrown after every remaining end fires. On failure path,
 * end-errors are logged but never shadow the original loop error.
 */
async function endSchemaBatchAll(
	startedModules: readonly StartedModule[],
	db: Database,
	schemaName: string,
	loopError: unknown,
): Promise<void> {
	let firstEndError: unknown;
	for (let i = startedModules.length - 1; i >= 0; i--) {
		const { name, module } = startedModules[i];
		if (typeof module.endSchemaBatch !== 'function') continue;
		try {
			await module.endSchemaBatch(db, schemaName, loopError);
		} catch (e) {
			if (loopError !== undefined) {
				log('endSchemaBatch failed for module %s after loop error; swallowing: %O', name, e);
			} else if (firstEndError === undefined) {
				log('endSchemaBatch failed for module %s: %O', name, e);
				firstEndError = e;
			} else {
				log('endSchemaBatch failed for module %s (subsequent): %O', name, e);
			}
		}
	}
	if (loopError === undefined && firstEndError !== undefined) {
		throw firstEndError;
	}
}

/**
 * Fires the optional per-module lens deployment notification, once per
 * successful logical `apply schema X`, after the lens catalog mutation +
 * snapshot rotation complete (see `VirtualTableModule.notifyLensDeployment`).
 *
 * Reads the just-rotated `current` snapshot back from the `DeclaredSchemaManager`
 * so the notification carries the exact {@link LensDeploymentSnapshot}
 * `deployLogicalSchema` built — no second derivation. Every module implementing
 * the hook is notified in registration order; a module that backs none of the
 * basis relations is expected to no-op. A notification that throws propagates
 * out of `apply schema X` (the lens is already deployed; the failed reconcile is
 * the caller's to handle).
 */
async function notifyLensDeploymentAll(db: Database, logicalSchemaName: string): Promise<void> {
	const snapshot = db.declaredSchemaManager.getDeployedLensSnapshots(logicalSchemaName)?.current;
	// A successful deploy always rotates a snapshot; guard defensively rather
	// than notify modules with an undefined deployment.
	if (!snapshot) return;
	for (const { name, module } of db.schemaManager.allModules()) {
		if (typeof module.notifyLensDeployment !== 'function') continue;
		log('notifyLensDeployment → module %s for logical schema %s', name, logicalSchemaName);
		await module.notifyLensDeployment(db, logicalSchemaName, snapshot);
	}
}
