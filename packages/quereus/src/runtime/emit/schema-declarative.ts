import type { EmissionContext } from '../emission-context.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { createLogger } from '../../common/logger.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { collectSchemaCatalog } from '../../schema/catalog.js';
import { renderCatalogForComparison, renderCatalogForRestoreCheck } from '../../schema/catalog-rendering.js';
import { computeSchemaDiff, generateMigrationDDL, generateMigrationPlan, objectsRecreatedByDiff, type MigrationStep, type SchemaDiff } from '../../schema/schema-differ.js';
import { describeDependentTable, findChecksReachingObjects, type CheckReachingObjects } from '../../schema/expression-dependents.js';
import { describeReachPath } from '../../schema/object-dependency-closure.js';
import { computeShortSchemaHash } from '../../schema/schema-hasher.js';
import { deployLogicalSchema } from '../../schema/lens-compiler.js';
import type * as AST from '../../parser/ast.js';
import type { PlanNode } from '../../planner/nodes/plan-node.js';
import type { Database } from '../../core/database.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import type { TableSchema } from '../../schema/table.js';
import { quoteIdentifier } from '../../emit/ast-stringify.js';
import { spineCloneAst } from '../../util/ast-spine-clone.js';
import { createEventLoopPacer, type EventLoopPacer } from '../../util/event-loop.js';
import { assertModuleCanRebuild } from './alter-table.js';
import { rejectCheckViolatedByExistingRows } from './add-constraint.js';
import { rebuildNotOnlyEffectError } from './ddl-transaction-policy.js';

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

/**
 * Build the `on conflict (<pk-cols>) do nothing` tail for an idempotent seed
 * insert.
 *
 * Targeting the seed table's PRIMARY KEY (rather than the blunt `INSERT OR
 * IGNORE`) keeps reseed idempotency intact — an already-present seed PK is
 * skipped with no delete, so no `ON DELETE CASCADE` fires and user edits to a
 * seeded row survive — while NOT masking a *malformed* seed row. A row that
 * violates a `CHECK`, a `NOT NULL` column, or a child-side FK is evaluated by
 * the ConstraintCheckNode (which sees no statement-level OR clause here, so it
 * resolves to ABORT) and aborts the apply with a clear error, where `OR IGNORE`
 * used to drop it silently. See ticket seed-or-ignore-masks-malformed-rows and
 * docs/schema-declarative.md § Seed Data.
 *
 * A table whose PK is empty (`primary key ()` — a 0-or-1-row singleton) has no
 * columns to name, so it falls back to the untargeted `on conflict do nothing`;
 * the only possible conflict there is the singleton key.
 */
function buildSeedConflictClause(tableSchema: TableSchema): string {
	const pkCols = tableSchema.primaryKeyDefinition.map(def =>
		quoteIdentifier(tableSchema.columns[def.index].name)
	);
	return pkCols.length > 0
		? ` on conflict (${pkCols.join(', ')}) do nothing`
		: ' on conflict do nothing';
}

/** Runs the insert for one seed row, naming the row in the error if it fails. */
async function executeSeedRow(db: Database, tableName: string, sql: string): Promise<void> {
	log('Executing seed SQL: %s', sql);
	try {
		await db._execWithinTransaction(sql);
	} catch (e) {
		log('Seed application failed for table %s: %O', tableName, e);
		throw new QuereusError(
			`Failed to apply seed data for table ${tableName}. SQL: ${sql}\nError: ${errorText(e)}`,
			StatusCode.ERROR,
			e instanceof Error ? e : undefined
		);
	}
}

/**
 * First table named by two `seed` blocks in one declaration, or undefined. Pure walk.
 *
 * Seed data is stored one block per table (`setSeedData` is a `Map.set` keyed by
 * lowercased table name), so a second block for the same table used to silently
 * discard the first block's rows. Two blocks for one table have no defined meaning
 * today — rejecting loses nothing an author can rely on, and appending would be a
 * new semantic, not a bug fix. Invisible to the differ, which ignores seed items
 * entirely, so the guard lives here at declare time. See SCH-003.
 *
 * Returns the table name as written on the SECOND block.
 */
function findDuplicateSeedTable(items: readonly AST.DeclareItem[]): string | undefined {
	const seen = new Set<string>();
	for (const item of items) {
		if (item.type !== 'declaredSeed') continue;
		const key = item.tableName.toLowerCase();
		if (seen.has(key)) return item.tableName;
		seen.add(key);
	}
	return undefined;
}

export function emitDeclareSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const declareStmt = (plan as unknown as { statementAst: AST.DeclareSchemaStmt }).statementAst;

	const run = (rctx: RuntimeContext): Row => {
		const schemaName = declareStmt.schemaName || 'main';
		log('DECLARE SCHEMA %s', schemaName);

		// Reject before touching any stored state, so a rejected declaration
		// neither stores seed rows nor clobbers the prior declaration.
		const duplicateSeed = findDuplicateSeedTable(declareStmt.items);
		if (duplicateSeed) {
			throw new QuereusError(
				`Seed data for table '${duplicateSeed}' is declared more than once in schema '${schemaName}'`,
				StatusCode.ERROR,
			);
		}

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
		run: asRun(run),
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
		run: asRun(run),
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
		run: asRun(run),
		note: `diff schema ${diffStmt.schemaName || 'main'}`
	};
}

/**
 * A migrating apply is all-or-nothing, with one stated residual. The migration loop keeps an
 * undo journal (each step's `MigrationStep.undo`, rendered by the differ from the pre-apply
 * catalog); when a step fails the journal runs in reverse, the catalog is re-collected and
 * checked against its pre-apply rendering, and the step's own error is rethrown. The residual
 * is a step that destroyed data (`DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN … SET DATA TYPE`,
 * marked `irreversible` by the differ): once one has run the apply cannot be taken back, and
 * a later failure reports the schema as partially migrated. A module refusing the final
 * `endSchemaBatch` counts as a failure too, and is unwound the same way. See
 * `runBatchedMigrationLoop` and docs/schema-declarative.md § Failure and restoration.
 *
 * Schema events are retracted CONDITIONALLY, which is why this emitter cannot use the plain
 * `withStatementScopedSchemaEvents` helper (see ddl-event-scope.ts) every other DDL emitter
 * opens around its `run()`: a restored failure discards everything batched since the
 * watermark taken below (nothing happened, so nothing is announced), while an unrestorable
 * one keeps its events — the steps that landed really happened, the user may still commit an
 * explicit transaction, and a replicating peer must hear about them. Each generated
 * sub-statement runs its own emitter and so carries its own inner scope: a landed statement
 * keeps its event until the outer verdict, the failing one retracts its own.
 *
 * A primary-key change that needs the engine's shadow-table rebuild commits part-way, which the
 * undo journal cannot take back, so it is refused unless it is all the apply does: see
 * `rebuildWouldBeOnlyEffect`.
 */
export function emitApplySchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const applyStmt = (plan as unknown as { statementAst: AST.ApplySchemaStmt }).statementAst;

	const run = async (rctx: RuntimeContext): Promise<Row> => {
		const schemaName = applyStmt.schemaName || 'main';
		log('APPLY SCHEMA %s', schemaName);

		// Started here so that planning time counts toward the first yield.
		const pace = createEventLoopPacer();

		// Mark for the conditional retraction described on the function comment. Taken
		// before anything can batch a schema event; a lifetime-monotonic stamp, so it is
		// valid whether or not a transaction (and so batching) is open yet.
		const eventWatermark = rctx.db._getEventEmitter().beginSchemaEventScope();

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

		const defaultCollation = rctx.db.options.getStringOption('default_collation');

		// Applied-state fast path. If both sides render to exactly what they rendered
		// to at the end of the last successful, verified-no-op apply — and the
		// effective default_collation is unchanged — the diff would again be empty,
		// so skip it. `computeSchemaDiff` reads nothing but its four arguments; the
		// remaining one, `renamePolicy`, is inert when there are no differences (no
		// name-change pairs for a policy to police), and `allow_destructive` only
		// gates a non-empty `diff.maintainedModuleMigrations`. So the skip is
		// behaviour-preserving. See docs/schema-declarative.md § Applied-state snapshot.
		const catalogRendering = renderCatalogForComparison(actualCatalog);
		const declaredRendering = rctx.db.declaredSchemaManager.getDeclaredRendering(schemaName);
		const snapshot = rctx.db.declaredSchemaManager.getAppliedSnapshot(schemaName);
		const unchanged = snapshot !== undefined
			&& declaredRendering !== undefined
			&& snapshot.declaredRendering === declaredRendering
			&& snapshot.catalogRendering === catalogRendering
			&& snapshot.defaultCollation === defaultCollation;

		// True when this apply may record a snapshot: nothing needed doing. Set by the
		// fast path, or by a full reconcile whose plan came out empty.
		let verifiedNoOp = unchanged;

		if (unchanged) {
			log('APPLY SCHEMA %s: catalog and declaration unchanged since last no-op apply; skipping diff', schemaName);
		} else {
			// Compute diff (default rename_policy = 'allow' when unspecified). Thread the
			// live default_collation so an omitted-COLLATE declared column resolves to the
			// same effective collation the CREATE path produces — keeping a fresh apply at
			// parity with direct DDL and a re-apply idempotent under a non-BINARY default.
			const diff = computeSchemaDiff(declaredSchema, actualCatalog, applyStmt.options?.renamePolicy ?? 'allow', defaultCollation);

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

			// Build the migration plan. Same ordering (and same DDL text) `diff schema`
			// previews; the create steps additionally carry the statement they were
			// rendered from, so the loop below skips re-parsing them, and every step
			// carries its undo (rendered from `actualCatalog`, the pre-apply state).
			const migrationStatements = generateMigrationPlan(diff, schemaName, actualCatalog);

			// Run the migration loop. When there are no statements we keep the
			// idempotency fast-path: no module batch hooks fire. The restore fingerprint
			// is rendered only when there is something to restore from.
			if (migrationStatements.length > 0) {
				const refuseRebuild = !rebuildWouldBeOnlyEffect(rctx.db, schemaName, migrationStatements.length, applyStmt.withSeed);
				if (refuseRebuild) refuseCertainRebuild(rctx.db, schemaName, diff);
				const priorRefused = rctx.db._setPrimaryKeyRebuildRefused(refuseRebuild);
				const priorMigrating = rctx.db._setSchemaMigrating(true);
				const priorRecreated = rctx.db._setSchemaRecreatedObjects(objectsRecreatedByDiff(diff, schemaName));
				try {
					await runBatchedMigrationLoop(rctx.db, schemaName, migrationStatements, {
						preApplyFingerprint: renderCatalogForRestoreCheck(actualCatalog),
						eventWatermark,
					}, pace);
				} finally {
					rctx.db._setSchemaRecreatedObjects(priorRecreated);
					rctx.db._setSchemaMigrating(priorMigrating);
					rctx.db._setPrimaryKeyRebuildRefused(priorRefused);
				}
			}

			// A migrating apply records nothing: `catalogRendering` describes the
			// PRE-migration catalog, and re-collecting post-migration would assert an
			// equivalence this apply never verified with a diff. The next apply does a
			// full diff, finds it empty, and records then — which is what preserves
			// `apply schema`'s self-healing property (a repeat apply always re-diffs
			// rather than being told by a cache that everything is fine).
			verifiedNoOp = migrationStatements.length === 0;
		}

		// Apply seed data if requested.
		//
		// Runs on BOTH paths — the applied-state fast path elides the diff and the
		// migration plan, nothing else. A table emptied since the last apply gets its
		// seed rows back, which is the behaviour a user relies on and the only reading
		// consistent with "observably indistinguishable from a full apply whose diff
		// came out empty". Seeding is idempotent, so the repeat costs no correctness.
		//
		// Seed application is idempotent: each row is written as
		// `INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk>) DO NOTHING`. An existing
		// row (matching the seed PK) is left completely untouched — user edits
		// survive a reopen reseed and no ON DELETE CASCADE fires for a parent row
		// whose values are unchanged (OR REPLACE would delete-then-insert even when
		// the replacement values are identical, triggering cascades unnecessarily).
		// A freshly-created table has no existing rows, so every seed row inserts on
		// the first apply.
		//
		// Targeting the PK conflict (vs the blunt `OR IGNORE`) is deliberate: it
		// suppresses ONLY the seed-PK-already-present conflict, so a *malformed* seed
		// row — one that violates a CHECK, a NOT NULL column, or a child-side FK —
		// still aborts the apply with a clear error instead of vanishing silently.
		// (See `buildSeedConflictClause` and ticket seed-or-ignore-masks-malformed-rows.)
		//
		// Historical note: the original implementation used DELETE-then-INSERT, then
		// OR REPLACE, then OR IGNORE. The delete path was dropped because
		// `DELETE FROM <tbl>` routes through the host's snapshot resolver at
		// `asOf(ep.startedAt)` and faults on a freshly-created table that predates the
		// snapshot. OR REPLACE fixed the crash but fired ON DELETE CASCADE on every
		// reopen for unchanged seed parents. OR IGNORE removed the cascade but masked
		// every constraint failure, so a typo'd seed row vanished. ON CONFLICT (pk) DO
		// NOTHING is the final form: no scan, no cascade, user edits preserved, and
		// malformed rows surfaced.
		if (applyStmt.withSeed) {
			const allSeedData = rctx.db.declaredSchemaManager.getAllSeedData(schemaName);
			log('Seed data available for %d tables', allSeedData.size);
			for (const [tableName, rows] of allSeedData) {
				if (rows.length === 0) continue;
				log('Applying seed data to %s.%s (%d rows)', schemaName, tableName, rows.length);

				// Qualify table name with schema if not main
				const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
					? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
					: quoteIdentifier(tableName);

				// Resolve the just-migrated table to learn its PK column list for the
				// per-row conflict target. The migration loop above created/aligned the
				// table, so it is present in the catalog here.
				const tableSchema = rctx.db.schemaManager.getTable(schemaName, tableName);
				if (!tableSchema) {
					throw new QuereusError(
						`Cannot apply seed data: table '${schemaName}.${tableName}' not found after migration`,
						StatusCode.ERROR,
					);
				}
				const conflictClause = buildSeedConflictClause(tableSchema);

				// One idempotent insert per seed row, each its own call so the apply can
				// yield between rows. ON CONFLICT (<pk>) DO NOTHING: an existing row
				// (matching the seed PK) is left untouched — so user edits survive a reopen
				// reseed and no ON DELETE CASCADE fires for unchanged rows — while a malformed
				// row (CHECK / NOT NULL / child-FK violation) still aborts.
				for (const row of rows) {
					const values = row.map(formatSeedValue).join(', ');
					await executeSeedRow(rctx.db, tableName, `INSERT INTO ${qualifiedTableName} VALUES (${values})${conflictClause}`);
					await pace();
				}
				log('Seed application succeeded for table %s', tableName);
			}
		}

		// Record the applied-state snapshot. Only reached when nothing threw AND the
		// apply was a verified no-op, so `catalogRendering` (collected at the top of
		// this run, before any DDL could have executed) still describes the live
		// catalog, and a real diff has confirmed catalog ≡ declaration.
		//
		// A failed apply records nothing (it throws before reaching here), and a
		// snapshot an EARLIER apply recorded stays valid across a later restored
		// failure precisely because the restore returns the catalog to the state that
		// snapshot describes. Catalog DDL is still not undone by a transaction
		// rollback — the restore is undo DDL, not rollback — so a rolled-back
		// transaction cannot leave this snapshot describing a state the catalog is not
		// in either. If catalog DDL ever becomes rollback-able, the snapshot must be
		// invalidated on rollback.
		if (verifiedNoOp && declaredRendering !== undefined) {
			rctx.db.declaredSchemaManager.setAppliedSnapshot(schemaName, {
				declaredRendering,
				catalogRendering,
				defaultCollation,
			});
		}

		// Return empty row to satisfy type system (void result)
		return [];
	};

	return {
		params: [],
		run: asRun(run),
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
		run: asRun(run),
		note: `explain schema ${explainStmt.schemaName || 'main'}`
	};
}

/**
 * Whether a primary-key rebuild in this apply would be its only effect, the one shape in which a
 * rebuild may run. The rebuild commits the implicit transaction part-way, so nothing may precede it
 * in that transaction, and undoing it would be another rebuild, so nothing that can fail may follow
 * it: no other step, no seed row, and no module able to refuse the commit. Any registered module
 * counts, whichever one owns the table, because the batch spans them all. The answer costs a plan
 * with no rebuild nothing: the flag it sets is only read on the way into a rebuild. See
 * docs/schema-undo-plan.md § A primary-key rebuild.
 */
function rebuildWouldBeOnlyEffect(db: Database, schemaName: string, stepCount: number, withSeed: boolean | undefined): boolean {
	if (stepCount !== 1) return false;
	if (withSeed && [...db.declaredSchemaManager.getAllSeedData(schemaName).values()].some(rows => rows.length > 0)) return false;
	// NOTE: also counts a module defining `endSchemaBatch` without `beginSchemaBatch`, which
	// `beginSchemaBatchAll` never starts and so can never refuse. Errs toward refusing; test
	// both hooks if such a module ever needs to rebuild through an apply.
	for (const { module } of db.schemaManager.allModules()) {
		if (typeof module.endSchemaBatch === 'function') return false;
	}
	return true;
}

/**
 * Refuses, before any step runs, a key change certain to need a rebuild because its table's module
 * has no `alterTable` hook to try first. It has to be this early because `DROP TABLE` steps run
 * before the key change, so a refusal at the rebuild would already have destroyed that table's rows.
 * A hook may decline, and only running it shows that, so those tables are left to the check in
 * `runAlterPrimaryKey`.
 *
 * `alter.tableName` is the post-rename name; the table is still under its old one here.
 */
function refuseCertainRebuild(db: Database, schemaName: string, diff: SchemaDiff): void {
	for (const alter of diff.tablesToAlter) {
		if (!alter.primaryKeyChange) continue;
		const declaredName = alter.tableName.toLowerCase();
		const rename = diff.renames.find(r => r.kind === 'table' && r.newName.toLowerCase() === declaredName);
		const table = db.schemaManager.getTable(schemaName, rename?.oldName ?? alter.tableName);
		const module = table?.vtabModule;
		if (!table || !module || module.alterTable) continue;
		assertModuleCanRebuild(table, module);
		throw rebuildNotOnlyEffectError(table);
	}
}

/** What the migration loop needs to make a failed apply all-or-nothing. */
interface RestoreContext {
	/** `renderCatalogForRestoreCheck` of the pre-apply catalog: what a completed unwind must render to. */
	readonly preApplyFingerprint: string;
	/** The apply's schema-event watermark; everything since it is retracted on a verified restore. */
	readonly eventWatermark: number;
}

/** A migration loop that stopped on a failing step. */
interface MigrationFailure {
	/** The `Failed to execute DDL: …` error the failing step raised. */
	readonly error: QuereusError;
	/**
	 * Why the catalog is NOT back at its pre-apply state — an irreversible step ran, an
	 * undo statement failed, or the post-unwind catalog did not match. Undefined when the
	 * unwind ran to completion and the catalog was verified restored.
	 */
	readonly notRestored?: string;
}

/** How the plan's steps ended. The journal survives a clean run because a module can still refuse the batch end. */
type StepsOutcome =
	| { readonly clean: false; readonly failure: MigrationFailure }
	| CleanSteps;

interface CleanSteps {
	readonly clean: true;
	/** The `undo` of every step that ran, in execution order. */
	readonly journal: ReadonlyArray<readonly string[]>;
	/** The first step that cannot be undone, when one ran: the journal then cannot restore the catalog. */
	readonly poisonedBy?: MigrationStep;
}

/** A module whose `endSchemaBatch` threw, in firing order (reverse registration order). */
interface BatchEndRefusal {
	readonly name: string;
	readonly error: unknown;
}

/**
 * Drives the per-DDL migration loop wrapped in module-level batch hooks.
 * Modules that opt in via `beginSchemaBatch` may fold the entire
 * APPLY SCHEMA into a single substrate commit. Modules without the hook
 * pay nothing — they're filtered out before the loop.
 *
 * ## Failure: unwind, verify, then end the batch
 *
 * The loop keeps an undo journal (see `runStepsWithUndoJournal`). When a step fails the
 * journal runs in reverse and the catalog is checked against the pre-apply fingerprint —
 * all still INSIDE the module batch, and before `endSchemaBatch` fires with the original
 * loop error. That ordering is what lets every module tier land in the same place: a
 * module that discards its batch on error rewinds its substrate to the pre-apply state
 * (the undo DDL it also received is discarded with everything else), and a module with no
 * batch hooks has had both the forward and the undo DDL applied for real. Either way the
 * substrate matches the restored catalog. The undo is ordinary DDL, so this needs nothing
 * from module authors and works identically on every `ddlTransactionality` tier.
 *
 * What is thrown depends on the verdict. A verified restore rethrows the step's own error
 * unchanged and retracts every schema event batched since the apply's watermark (nothing
 * happened). Otherwise the error is wrapped: the original message first, then why the
 * schema is partially migrated, with the original as `cause` — and the events stay, because
 * the steps that landed really happened.
 *
 * ## Refused commit: end the batch, then unwind in a second one
 *
 * A module that throws from `endSchemaBatch` after a clean loop has refused to commit, so the
 * apply failed even though every step ran. `unwindRefusedBatchEnd` takes it back with the
 * same journal, verification and verdict, and the first refusal in firing order is the error
 * reported. Without this the catalog would keep a migration the store never received, and the
 * next apply would diff clean and report success with nothing written.
 *
 * ## Giving up the thread
 *
 * `pace` yields to the event loop between steps and between undo statements, so a module whose
 * hooks do no real waiting cannot hold the thread for the whole apply. Nothing can damage the
 * apply during a yield: statements queue behind the execution mutex it holds for its whole
 * duration, committed reads are refused by `Database._setSchemaMigrating`, `close()` fails the
 * next statement through the open check in `_executeSingleStatement`, and the journal is a local
 * array whose SQL was rendered at plan time. The flags held across a yield are read only by
 * statements, which are behind the mutex; the committed-read flag above is the exception, by
 * design. Synchronous catalog APIs (`defineTable`, `registerModule`) take no mutex and are not
 * kept out; the fingerprint check notices one that moved the catalog, on the failure path only.
 *
 * ## Executing a step
 *
 * A step that carries its AST is executed on a spine clone of it — the differ rendered
 * `step.sql` FROM that statement, so re-lexing it would rebuild the same tree, but the
 * plan's own node must not escape into the catalog (see below). Template-built steps
 * (renames, drops, alters, SET TAGS) carry no AST and take the parsing path. Both
 * branches report `step.sql` on failure, so the error text is identical either way.
 *
 * The clone is NOT optional. A plan step's AST is (a subtree of) the statement
 * `DeclaredSchemaManager` holds — the schema qualifiers spread only the outermost node,
 * so a view's `select`, an assertion's body and a `set maintained as` body are the
 * declaration's own subtrees on every target schema, main or not. The create emitters
 * retain what they are handed (`emitCreateView` stores `plan.selectStmt` as
 * `ViewSchema.selectAst`, and the assertion / maintained-table paths do the same), and
 * rename propagation rewrites those catalog bodies IN PLACE (`renameTableInAst` /
 * `renameColumnInAst` in `runtime/emit/alter-table.ts`). Without the clone, an
 * `ALTER TABLE … RENAME` after an apply silently rewrites the stored declaration, so
 * `diff schema` stops seeing the drift it should report.
 * `declarative-equivalence.spec.ts` § "apply executes the plan AST" pins both halves:
 * the apply itself leaves the declaration untouched, and so does a later rename.
 * The applied-state fast path now leans on the same invariant from the other side:
 * `DeclaredSchemaManager.getDeclaredRendering` memoizes the declaration's rendering
 * and re-derives it only on `setDeclaredSchema`, so an in-place edit of a stored
 * declaration would leave a stale rendering and could skip a real reconcile.
 *
 * NOTE: the clone costs about what the parse it replaces costs, because it copies the
 * WHOLE statement while the catalog retains only a few subtrees of it. Measured over
 * 68 creates of the synthetic declaration `bench/apply-schema-unchanged.mjs` builds
 * (harness since deleted): clone 0.91 ms vs parse 1.07 ms on
 * the 20.4 KB declaration, and clone 3.57 ms vs parse 3.13 ms on the 112.7 KB one — so
 * the create-heavy apply nets ~3–8% off the migration loop, not the ~26–38% the
 * uncloned version appeared to. If apply latency ever matters, the fix is to move
 * ownership into the emitters (each copies only what it stores) and drop this blunt
 * clone — see `tickets/backlog/debt-catalog-aliases-caller-ast`.
 */
async function runBatchedMigrationLoop(
	db: Database,
	schemaName: string,
	migrationStatements: readonly MigrationStep[],
	restore: RestoreContext,
	pace: EventLoopPacer,
): Promise<void> {
	const startedModules = await beginSchemaBatchAll(db, schemaName);
	let steps: StepsOutcome;
	try {
		steps = await runStepsWithUndoJournal(db, schemaName, migrationStatements, restore.preApplyFingerprint, pace);
	} catch (e) {
		// `runStepsWithUndoJournal` reports every step and undo failure as data, so this is a
		// throw it did not anticipate: the batch must still end with SOME error, or a module
		// would commit an overlay whose migration is propagating as failed.
		await endSchemaBatchAll(startedModules, db, schemaName, e);
		throw e;
	}
	if (!steps.clean) {
		// A refusal here is only logged, so the step's own error is the one the caller sees.
		await endSchemaBatchAll(startedModules, db, schemaName, steps.failure.error);
		throwFailedApply(db, restore, steps.failure.error, steps.failure.notRestored);
	}
	const refusals = await endSchemaBatchAll(startedModules, db, schemaName, undefined);
	if (refusals.length === 0) return;
	const notRestored = await unwindRefusedBatchEnd(db, schemaName, steps, refusals, restore.preApplyFingerprint, pace);
	throwFailedApply(db, restore, refusals[0].error, notRestored);
}

/**
 * Reports a failed apply. A verified restore rethrows `error` unchanged and retracts the
 * apply's schema events, since nothing happened. Otherwise the steps that landed really did,
 * so their events stay and the error is wrapped with the reason as its second line. A thrown
 * value that is not an `Error` cannot ride as `cause`, so only its text survives.
 */
function throwFailedApply(db: Database, restore: RestoreContext, error: unknown, notRestored: string | undefined): never {
	if (notRestored === undefined) {
		db._getEventEmitter().discardSchemaEventsSince(restore.eventWatermark);
		throw error;
	}
	throw new QuereusError(`${errorText(error)}\n${notRestored}`, StatusCode.ERROR, error instanceof Error ? error : undefined);
}

/**
 * Takes back a migration whose every step ran but whose batch end was refused. Returns
 * undefined on a verified restore, otherwise why the schema is left partially migrated.
 *
 * The first batch is already closed, so the undo DDL runs in a second one. That batch always
 * ends with no error, even after an undo statement failed: a module whose first commit landed
 * has to commit the undo that did run, so its store matches the catalog as far as the unwind
 * got, and an error would tell a discarding module to throw that away.
 *
 * A second refusal is judged against the first. A module that refused both times still holds
 * the pre-apply state, per the `endSchemaBatch` contract, so it is tolerated. A module that
 * committed the migration and then refused its undo holds the forward change under a restored
 * catalog, which the fingerprint check cannot see, so that module is what fails the restore.
 */
async function unwindRefusedBatchEnd(
	db: Database,
	schemaName: string,
	steps: CleanSteps,
	firstRefusals: readonly BatchEndRefusal[],
	preApplyFingerprint: string,
	pace: EventLoopPacer,
): Promise<string | undefined> {
	if (steps.poisonedBy !== undefined) return describeIrreversible(steps.poisonedBy);
	// NOTE: an empty journal still opens this batch, so a module that committed and then refuses
	// the empty batch reads as not restored. If that ever surfaces, return early on an empty journal.
	let reopened: StartedModule[];
	try {
		reopened = await beginSchemaBatchAll(db, schemaName);
	} catch (e) {
		return `${NOT_RESTORED}: the module batch could not be reopened for the unwind (${errorText(e)}).`;
	}
	// NOTE: no guard for an unexpected throw, unlike the first batch: every fallible call in
	// `unwindJournal` is inside a `try`. If that stops holding, this batch would stay open.
	const undoFailure = await unwindJournal(db, schemaName, steps.journal, preApplyFingerprint, pace);
	const secondRefusals = await endSchemaBatchAll(reopened, db, schemaName, undefined);
	if (undoFailure !== undefined) return undoFailure;
	const refusedFirst = new Set(firstRefusals.map(r => r.name));
	const stranded = secondRefusals.find(r => !refusedFirst.has(r.name));
	return stranded === undefined
		? undefined
		: `${NOT_RESTORED}: module '${stranded.name}' committed the migration and then refused to commit its undo (${errorText(stranded.error)}).`;
}

/**
 * Runs the plan's steps in order under an undo journal. When every step ran, returns the
 * journal, because a module can still refuse the batch end; otherwise the failure, with the
 * catalog already unwound (or the reason it could not be). Never throws: the caller must
 * still end the module batch with the original error.
 *
 * The journal holds the `undo` of every step that succeeded. A step the differ marked
 * `irreversible` poisons the journal BEFORE it runs — the step may apply partially before it
 * throws, so its own failure must not read as restorable either — and journaling stops there.
 *
 * Once every step has run, the CHECKs over what the plan recreated are checked, and a failure
 * there takes the failed-step path: the plan is what broke them, whichever step that was.
 */
async function runStepsWithUndoJournal(
	db: Database,
	schemaName: string,
	migrationStatements: readonly MigrationStep[],
	preApplyFingerprint: string,
	pace: EventLoopPacer,
): Promise<StepsOutcome> {
	const journal: Array<readonly string[]> = [];
	let poisonedBy: MigrationStep | undefined;
	for (const step of migrationStatements) {
		if (poisonedBy === undefined && step.undo === undefined) poisonedBy = step;
		const error = await executeMigrationStep(db, step);
		if (error) {
			const notRestored = poisonedBy !== undefined
				? describeIrreversible(poisonedBy, step)
				: await unwindJournal(db, schemaName, journal, preApplyFingerprint, pace);
			return { clean: false, failure: { error, notRestored } };
		}
		if (poisonedBy === undefined && step.undo !== undefined && step.undo.length > 0) journal.push(step.undo);
		await pace();
	}
	const error = await revalidateChecksOverRecreatedObjects(db, schemaName, pace);
	if (error) {
		const notRestored = poisonedBy !== undefined
			? describeIrreversible(poisonedBy)
			: await unwindJournal(db, schemaName, journal, preApplyFingerprint, pace);
		return { clean: false, failure: { error, notRestored } };
	}
	return { clean: true, journal, poisonedBy };
}

/**
 * Checks the existing rows against each CHECK that reaches an object this plan recreated, which
 * is what `ADD CONSTRAINT` would have judged had the user redefined the object by hand (dropping
 * the constraint around it). Returns the first failure instead of throwing, as a failed step does.
 *
 * NOTE: a DEFAULT, a generated column and a CHECK that is not a row invariant get no check, as a
 * hand redefinition gets none, so a new view that lost a column they read surfaces on the next
 * write that uses them. If that proves too late, plan those expressions here without scanning.
 */
async function revalidateChecksOverRecreatedObjects(db: Database, schemaName: string, pace: EventLoopPacer): Promise<QuereusError | undefined> {
	const recreated = db._getSchemaRecreatedObjects();
	if (recreated.size === 0) return undefined;
	for (const reaching of findChecksReachingObjects(db, recreated)) {
		try {
			await rejectCheckViolatedByExistingRows(db, reaching.table, reaching.check);
		} catch (e) {
			log('CHECK over a recreated object failed on %s: %O', reaching.table.name, e);
			return recreatedObjectBrokeCheck(reaching, schemaName, e);
		}
		await pace();
	}
	return undefined;
}

/** The error for a CHECK that fails over a recreated object: it names the CHECK and what it reads, since its own body may not mention that object. */
function recreatedObjectBrokeCheck(reaching: CheckReachingObjects, schemaName: string, cause: unknown): QuereusError {
	const objects = reaching.reached.map(({ key, path }) => `'${key}'${describeReachPath(path)}`).join(', ');
	const on = describeDependentTable(reaching.table, schemaName);
	return new QuereusError(
		`apply schema '${schemaName}': ${reaching.describe} on table ${on} reads recreated ${objects} and fails: ${errorText(cause)}`,
		StatusCode.ERROR,
		cause instanceof Error ? cause : undefined,
	);
}

/** Runs one migration step; returns its wrapped error instead of throwing, so the loop can unwind. */
async function executeMigrationStep(db: Database, step: MigrationStep): Promise<QuereusError | undefined> {
	const ddl = step.sql;
	log('Executing migration DDL: %s', ddl);
	try {
		if (step.ast) await db._execAstWithinTransaction([spineCloneAst(step.ast)]);
		else await db._execWithinTransaction(ddl);
		return undefined;
	} catch (e) {
		log('Migration failed for DDL: %s', ddl);
		// NOTE: every failed step surfaces as ERROR; the step's own code (e.g. CONSTRAINT
		// when the data violates a tightened rule) is only on `cause` and inside the
		// message. If a caller ever needs to key on "data violates the new schema" vs.
		// "the migration is broken", propagate the inner code instead of flattening it.
		return new QuereusError(
			`Failed to execute DDL: ${ddl}\nError: ${errorText(e)}`,
			StatusCode.ERROR,
			e instanceof Error ? e : undefined
		);
	}
}

/**
 * Runs the journal in reverse (each step's undo statements in their own order), then checks
 * the catalog against the pre-apply fingerprint. Returns undefined on a verified restore,
 * otherwise the reason the schema is left partially migrated.
 *
 * An undo statement that throws stops the unwind where it is: the schema is then in a state
 * neither the user nor the plan asked for, and continuing past a failed undo would only
 * compound it. The fingerprint check is what notices a wrong or missing undo arm — including
 * a failing step that left residue of its own (each DDL statement owns its atomicity; this
 * is the check that catches one that is not). It costs one catalog render, on the failure
 * path only.
 */
async function unwindJournal(
	db: Database,
	schemaName: string,
	journal: ReadonlyArray<readonly string[]>,
	preApplyFingerprint: string,
	pace: EventLoopPacer,
): Promise<string | undefined> {
	const undoFailure = await runJournalInReverse(db, journal, pace);
	if (undoFailure !== undefined) return undoFailure;
	let afterUnwind: string;
	try {
		afterUnwind = renderCatalogForRestoreCheck(collectSchemaCatalog(db, schemaName));
	} catch (e) {
		log('Could not re-collect the catalog to verify the restore: %O', e);
		return `${NOT_RESTORED}: the catalog could not be re-collected to verify the restore (${errorText(e)}).`;
	}
	if (afterUnwind === preApplyFingerprint) return undefined;
	log('Post-unwind catalog does not match the pre-apply fingerprint.\nbefore:\n%s\nafter:\n%s', preApplyFingerprint, afterUnwind);
	return `${NOT_RESTORED}: after unwinding, the catalog does not match its pre-apply state.`;
}

/**
 * Runs the undo statements with the drop reference guards stood down (see
 * `Database._setSchemaUnwinding`). `CREATE TABLE` does not validate what it refers to, so the
 * plan can create a table naming a column or table a later step adds, and undoing in exact
 * reverse removes that target while the referring table still exists.
 */
async function runJournalInReverse(db: Database, journal: ReadonlyArray<readonly string[]>, pace: EventLoopPacer): Promise<string | undefined> {
	const priorUnwinding = db._setSchemaUnwinding(true);
	try {
		for (let i = journal.length - 1; i >= 0; i--) {
			for (const sql of journal[i]) {
				log('Unwinding migration step: %s', sql);
				try {
					await db._execWithinTransaction(sql);
				} catch (e) {
					log('Undo failed for DDL: %s: %O', sql, e);
					return `${NOT_RESTORED}: undo statement \`${sql}\` failed (${errorText(e)}).`;
				}
				await pace();
			}
		}
		return undefined;
	} finally {
		db._setSchemaUnwinding(priorUnwinding);
	}
}

const NOT_RESTORED = 'The schema is partially migrated and could not be restored';

/** The reason text when an irreversible step ran: before the failing step, as it, or (no `failing`) before a failure that followed the last step. */
function describeIrreversible(poisonedBy: MigrationStep, failing?: MigrationStep): string {
	const why = poisonedBy.irreversible ?? 'no undo was recorded for it';
	return poisonedBy === failing
		? `The schema could not be restored: the failing step \`${poisonedBy.sql}\` cannot be undone (${why}), so any partial effect of it stands.`
		: `${NOT_RESTORED}: the earlier step \`${poisonedBy.sql}\` cannot be undone (${why}).`;
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

interface StartedModule {
	name: string;
	module: AnyVirtualTableModule;
}

/**
 * Calls `beginSchemaBatch` on every module that defines it, in registration
 * order. Returns the modules that successfully began. If any module's
 * begin throws, already-started modules are torn down (in reverse order)
 * with the begin-time error, any refusal of that teardown is only logged,
 * and the original failure is rethrown.
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
 * Calls `endSchemaBatch` on previously-started modules in reverse order, every one of them
 * regardless of earlier refusals, and returns the refusals for the caller to judge. An array
 * rather than a first error, so a module that throws `undefined` is still seen as refusing.
 */
async function endSchemaBatchAll(
	startedModules: readonly StartedModule[],
	db: Database,
	schemaName: string,
	loopError: unknown,
): Promise<readonly BatchEndRefusal[]> {
	const refusals: BatchEndRefusal[] = [];
	for (let i = startedModules.length - 1; i >= 0; i--) {
		const { name, module } = startedModules[i];
		if (typeof module.endSchemaBatch !== 'function') continue;
		try {
			await module.endSchemaBatch(db, schemaName, loopError);
		} catch (e) {
			log('endSchemaBatch failed for module %s: %O', name, e);
			refusals.push({ name, error: e });
		}
	}
	return refusals;
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
