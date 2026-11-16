import { Parser, quoteIdentifier, type Database, type SqlValue } from '@quereus/quereus';
import type { AlterTableAction, DeclareSchemaStmt, Statement } from '@quereus/quereus/parser';
import type { BundleHeader, BundleSchemaEntry } from './format.js';
import { BundleError, notifyProgress } from './hooks.js';
import { messageOf, type ImportRun, type ImportSettings, type SchemaPlan } from './import-run.js';

/**
 * The schema phase of an import: for each declaration in the header, plan the migration
 * with `diff schema`, refuse what the options do not allow, and run `apply schema`. Any
 * failure is fatal and stops the run, and nothing after it is applied.
 */
export async function importSchemas(run: ImportRun, header: BundleHeader): Promise<void> {
	if (run.settings.schemaMode === 'skip') return;
	for (const entry of header.schemas ?? []) {
		if (run.isCancelled('schema')) return;
		try {
			const ddlApplied = await reconcileSchema(run.db, entry, run.settings);
			run.schemas.push({ schema: entry.name, ddlApplied });
		} catch (e) {
			run.fail(e instanceof BundleError ? e : schemaError(entry.name, `Applying schema '${entry.name}' failed: ${messageOf(e)}`, e));
			return;
		}
		notifyProgress(run.settings.hooks, { phase: 'schema', schema: entry.name, rowsDone: 0, totalRowsDone: 0 });
	}
}

/**
 * Brings schema `entry.name` to the bundle's declaration, or checks that it already is,
 * and answers the DDL that ran. The database's own declaration of that schema, if any, is
 * put back afterwards: an import must not silently replace the application's declared state.
 *
 * @throws BundleError
 */
async function reconcileSchema(db: Database, entry: BundleSchemaEntry, settings: ImportSettings): Promise<string[]> {
	guardDeclaration(entry);
	const saved = saveDeclaration(db, entry.name);
	try {
		await declare(db, entry);
		const plan = await planOf(db, entry.name, settings.renamePolicy);
		if (settings.schemaMode === 'verify') {
			if (plan.ddl.length > 0) {
				throw schemaError(entry.name, `Schema '${entry.name}' differs from the bundle; it needs: ${plan.ddl.join('; ')}`);
			}
			return [];
		}
		await authorize(plan, settings);
		await apply(db, entry.name, settings);
		return plan.ddl;
	} finally {
		restoreDeclaration(db, entry.name, saved);
	}
}

/**
 * A bundle is untrusted input, and its declaration is about to run as SQL: it must be
 * exactly one `declare schema` statement for the schema the entry names.
 *
 * @throws BundleError
 */
function guardDeclaration(entry: BundleSchemaEntry): void {
	let statements: Statement[];
	try {
		statements = new Parser().parseAll(entry.declaration);
	} catch (e) {
		throw schemaError(entry.name, `The declaration of schema '${entry.name}' does not parse: ${messageOf(e)}`, e);
	}
	const [statement] = statements;
	if (statements.length !== 1 || statement.type !== 'declareSchema') {
		throw schemaError(entry.name, `The declaration of schema '${entry.name}' must be exactly one 'declare schema' statement`);
	}
	const declared = statement as DeclareSchemaStmt;
	if ((declared.schemaName ?? 'main').toLowerCase() !== entry.name.toLowerCase()) {
		throw schemaError(entry.name, `The declaration of schema '${entry.name}' declares schema '${declared.schemaName ?? 'main'}'`);
	}
	if (declared.isLogical) {
		throw schemaError(entry.name, `The declaration of schema '${entry.name}' is a logical schema; a bundle carries physical schemas only`);
	}
}

interface SavedDeclaration {
	declaration?: DeclareSchemaStmt;
	seeds: Array<[string, SqlValue[][]]>;
}

/** `declare schema` replaces both the stored declaration and its seed rows, so both are saved. */
function saveDeclaration(db: Database, schemaName: string): SavedDeclaration {
	const manager = db.declaredSchemaManager;
	return {
		declaration: manager.getDeclaredSchema(schemaName),
		seeds: [...manager.getAllSeedData(schemaName)],
	};
}

function restoreDeclaration(db: Database, schemaName: string, saved: SavedDeclaration): void {
	const manager = db.declaredSchemaManager;
	if (!saved.declaration) {
		manager.removeDeclaredSchema(schemaName);
		return;
	}
	manager.setDeclaredSchema(schemaName, saved.declaration);
	manager.clearSeedData(schemaName);
	for (const [table, rows] of saved.seeds) manager.setSeedData(schemaName, table, rows);
}

async function declare(db: Database, entry: BundleSchemaEntry): Promise<void> {
	try {
		await db.exec(entry.declaration);
	} catch (e) {
		throw schemaError(entry.name, `The declaration of schema '${entry.name}' was refused: ${messageOf(e)}`, e);
	}
}

async function planOf(db: Database, schemaName: string, renamePolicy: ImportSettings['renamePolicy']): Promise<SchemaPlan> {
	const ddl: string[] = [];
	try {
		for await (const row of db.eval(`diff schema ${quoteIdentifier(schemaName)}`)) ddl.push(String(row.ddl));
	} catch (e) {
		throw schemaError(schemaName, `Planning schema '${schemaName}' failed: ${messageOf(e)}`, e);
	}
	return { schema: schemaName, ddl, destructive: ddl.filter(sql => isDestructive(sql, renamePolicy)) };
}

/**
 * Refuses a destructive plan unless allowed, then asks `confirmSchemaPlan`. A hook that
 * throws is logged and counts as a refusal.
 *
 * @throws BundleError
 */
async function authorize(plan: SchemaPlan, settings: ImportSettings): Promise<void> {
	if (plan.destructive.length > 0 && !settings.allowDestructive) {
		throw new BundleError(
			`Applying schema '${plan.schema}' would run destructive statements; pass allowDestructive to allow them: ${plan.destructive.join('; ')}`,
			{ phase: 'schema', kind: 'destructive', schema: plan.schema },
		);
	}
	if (plan.ddl.length === 0 || !settings.confirmSchemaPlan) return;
	let confirmed = false;
	try {
		confirmed = await settings.confirmSchemaPlan(plan);
	} catch (e) {
		console.error('Bundle confirmSchemaPlan hook threw; treating the plan as declined:', e);
	}
	if (!confirmed) throw schemaError(plan.schema, `The plan for schema '${plan.schema}' was declined`);
}

/** `apply schema` is all-or-nothing unless a destructive step has run, so a refusal normally leaves the catalog as it was. */
async function apply(db: Database, schemaName: string, settings: ImportSettings): Promise<void> {
	const options = [
		...(settings.allowDestructive ? ['allow_destructive = true'] : []),
		...(settings.renamePolicy ? [`rename_policy = '${settings.renamePolicy}'`] : []),
	];
	const sql = `apply schema ${quoteIdentifier(schemaName)}${options.length > 0 ? ` options (${options.join(', ')})` : ''}`;
	try {
		await db.exec(sql);
	} catch (e) {
		throw schemaError(schemaName, `Applying schema '${schemaName}' failed: ${messageOf(e)}`, e);
	}
}

/**
 * Whether a planned statement loses data or breaks dependents: any drop (including the
 * drop half of a recreate), and an `alter table` that drops a column or constraint or
 * changes a column's type. Under `rename_policy = 'deny'` the engine turns every rename
 * the plan shows into a drop and a create, so renames count too (`diff schema` always
 * plans with `'allow'`). A statement that does not parse is counted, to stay on the safe side.
 */
function isDestructive(sql: string, renamePolicy: ImportSettings['renamePolicy']): boolean {
	let statements: Statement[];
	try {
		statements = new Parser().parseAll(sql);
	} catch (e) {
		console.warn(`Bundle import cannot classify planned statement, treating it as destructive: ${sql}`, e);
		return true;
	}
	return statements.some(statement => {
		if (statement.type === 'drop') return true;
		return statement.type === 'alterTable' && alterIsDestructive(statement.action, renamePolicy);
	});
}

function alterIsDestructive(action: AlterTableAction, renamePolicy: ImportSettings['renamePolicy']): boolean {
	switch (action.type) {
		case 'dropColumn':
		case 'dropConstraint':
			return true;
		case 'alterColumn':
			return action.setDataType !== undefined;
		case 'renameTable':
		case 'renameColumn':
		case 'renameConstraint':
			return renamePolicy === 'deny';
		default:
			return false;
	}
}

function schemaError(schema: string, message: string, cause?: unknown): BundleError {
	return new BundleError(message, { phase: 'schema', kind: 'schema', schema, cause });
}
