import type { Database } from '../core/database.js';
import type { Schema } from './schema.js';
import type { SchemaManager } from './manager.js';
import type { TableSchema } from './table.js';
import type { ViewSchema } from './view.js';
import type * as AST from '../parser/ast.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { astToString } from '../emit/ast-stringify.js';
import { buildLogicalConstraints, type LensSlot, type LensColumnProvenance,
	type LensRelationBacking, type LensTableSnapshot, type LensDeploymentSnapshot } from './lens.js';
import { computeSchemaHash } from './schema-hasher.js';
import { validateReservedTags, type TagDiagnostic } from './reserved-tags.js';
import { createLogger } from '../common/logger.js';
import type { MappingAdvertisement, DecompositionMember } from '../vtab/mapping-advertisement.js';
import type { AnyVirtualTableModule } from '../vtab/module.js';

const log = createLogger('schema:lens-compiler');

/**
 * Lens compiler — the `apply schema X` step for a **logical** schema.
 *
 * For each declared logical table it: builds the logical spec, aligns it against
 * the basis schema (the default name-based aligner), produces the inlined
 * effective view body, populates the lens slot, and registers the body as an
 * ordinary `ViewSchema`. The query processor then sees a view; reads ride the
 * standard view-resolution path and writes ride view-updateability.
 *
 * v1 is **single-source, name-based** (see `docs/lens.md` § The Default Mapper):
 * a logical table maps to a name-matching basis table, and each logical column
 * to a name-matching basis column. Type/nullability conformance and the n-way
 * decomposition shape are deferred to the prover / decomposition tickets.
 */

/**
 * Deploys (or re-deploys) a logical schema's lens slots + compiled view bodies.
 *
 * Re-deploy semantics are **clear-and-rebuild**: every existing lens view + slot
 * in the logical schema is dropped, then rebuilt from the current declaration.
 * This is how asymmetric removal falls out for free — a logical table dropped
 * from the declaration is simply not rebuilt (its view + slot vanish), and the
 * basis is never touched (logical removals never cascade to basis storage; see
 * `docs/lens.md` § Deployment).
 */
export function deployLogicalSchema(
	db: Database,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	validateLogicalDeclaration(declaredSchema, logicalSchemaName);

	const schemaManager = db.schemaManager;
	const logicalSchema = schemaManager.getSchemaOrFail(logicalSchemaName);

	// The lens block (explicit `over Y` basis + sparse overrides), if declared.
	// Re-read from source on every deploy — that is what lets a rename and a
	// later column-add compose without attribute-ID plumbing (docs/lens.md § D2).
	const lensDecl = db.declaredSchemaManager.getLensDeclaration(logicalSchemaName);
	const overridesByTable = indexOverrides(lensDecl, declaredSchema, logicalSchemaName);

	// Infer the basis lazily, only when there is ≥1 logical table to align. An
	// empty logical declaration (e.g. re-applying X after all its tables are
	// removed) is a pure detach-everything operation and must NOT fail on basis
	// resolution — removal never depends on the basis (asymmetric removal).
	let basis: { schema: Schema; schemaName: string } | undefined;
	const resolveBasis = (): { schema: Schema; schemaName: string } => {
		if (lensDecl) {
			// Explicit `over Y` binding resolves the foundation's default-basis
			// ambiguity (docs/lens.md § D4); `inferDefaultBasis` is NOT consulted.
			const basisSchema = schemaManager.getSchema(lensDecl.basisSchema);
			if (!basisSchema) {
				throw new QuereusError(
					`lens: basis schema '${lensDecl.basisSchema}' for logical schema '${logicalSchemaName}' does not exist (declared via 'declare lens for ${logicalSchemaName} over ${lensDecl.basisSchema}')`,
					StatusCode.ERROR,
				);
			}
			return { schema: basisSchema, schemaName: basisSchema.name };
		}
		return inferDefaultBasis(schemaManager, logicalSchemaName);
	};

	// Compile everything FIRST (basis alignment can throw — name mismatch, etc.).
	// Only after every table aligns successfully do we mutate the catalog, so a
	// failed re-apply leaves the existing lens state untouched (atomic deploy).
	// Module mapping advertisements are collected once per deploy (the first time a
	// basis is resolved) and filtered per logical table by the resolver.
	let allAdvertisements: MappingAdvertisement[] | undefined;

	const compiled: Array<{ slot: LensSlot; view: ViewSchema }> = [];
	for (const item of declaredSchema.items) {
		if (item.type !== 'declaredTable') continue;

		basis ??= resolveBasis();
		allAdvertisements ??= collectAdvertisements(db, basis.schema);
		const logicalTable = schemaManager.buildLogicalTableSchema(item.tableStmt, logicalSchema.name);
		const override = overridesByTable.get(logicalTable.name.toLowerCase());

		// Resolve (collect → select primary → validate) the advertisement BEFORE body
		// compilation, so a malformed advertisement aborts the deploy atomically. The
		// resolved advertisement is **stored** on the slot, not yet synthesized — the
		// v1 name-match / override body producer below is unchanged by this ticket;
		// `lens-multi-source-decomposition` reads the slot to build the n-way body.
		const { advertisement, auxiliaryAccess } = resolveAdvertisement(
			allAdvertisements, logicalTable, basis, db, logicalSchemaName, override !== undefined,
		);

		let compiledBody: AST.SelectStmt;
		let provenance: LensColumnProvenance[];
		let hiding: ReadonlySet<string> | undefined;
		let effectiveColumns: string[];
		if (override) {
			const merged = compileOverrideBody(logicalTable, logicalSchemaName, basis.schemaName, schemaManager, override);
			compiledBody = merged.body;
			provenance = merged.provenance;
			hiding = merged.hiding.size > 0 ? merged.hiding : undefined;
			effectiveColumns = merged.effectiveColumns;
			// Override ⊕ advertisement composition (docs/lens.md § Override-vs-advertisement):
			// a *sparse* override (one that relies on gap-fill) must not re-anchor or
			// reference relations outside the advertised decomposition. A *full*
			// hand-authored override (no gap-fill) bypasses the advertisement and is
			// not conflict-checked. Gap-fill *execution* from the advertisement lands
			// in `lens-multi-source-decomposition`; this ticket validates the conflict.
			if (advertisement && provenance.some(p => p.source === 'default')) {
				validateOverrideAdvertisementConflict(
					advertisement, override, basis.schemaName, schemaManager, logicalSchemaName, logicalTable.name,
				);
			}
		} else {
			compiledBody = compileDefaultBody(logicalTable, logicalSchemaName, basis.schema, basis.schemaName);
			provenance = logicalTable.columns.map(c => ({ logicalColumn: c.name, source: 'default' as const }));
			effectiveColumns = logicalTable.columns.map(c => c.name);
		}

		// Annotate provenance with advertisement-backed member info (introspection).
		if (advertisement) annotateProvenanceWithAdvertisement(provenance, advertisement);

		const slot: LensSlot = {
			logicalTable,
			defaultBasis: { schemaName: basis.schemaName },
			override: override?.select,
			hiding,
			compiledBody,
			columnProvenance: provenance,
			attachedConstraints: buildLogicalConstraints(logicalTable),
			advertisement,
			auxiliaryAccess,
		};

		// PoC: validate the reserved `quereus.*` tag namespace shape + site on the
		// logical table and its constraints, INSIDE the compile-first loop so an
		// invalid tag fails the deploy atomically (before any catalog mutation).
		// Only shape/site is checked here — no reserved tag's semantics are read.
		validateLensTags(slot);
		const view: ViewSchema = {
			name: logicalTable.name,
			schemaName: logicalSchema.name,
			sql: astToString(compiledBody),
			selectAst: compiledBody,
			// Pin the consumer-facing column names to the *logical* declaration
			// (the contract, minus hidden columns), independent of the basis
			// column casing. Equivalent to `create view T(<logical cols>) as
			// <body>`: `select * from X.T` then surfaces the logical names, not
			// whatever the basis happens to spell them. Write-through is
			// unaffected (positional passthrough).
			columns: effectiveColumns,
			tags: logicalTable.tags,
		};
		compiled.push({ slot, view });
	}

	// Clear-and-rebuild: drop all current lens views + slots, then register the
	// freshly compiled set. A logical schema's views are exclusively lens bodies,
	// so dropping every view is safe and implements detach for tables removed
	// from the declaration (logical removals never touch basis storage).
	for (const view of Array.from(logicalSchema.getAllViews())) {
		logicalSchema.removeView(view.name);
	}
	logicalSchema.clearLensSlots();

	for (const { slot, view } of compiled) {
		logicalSchema.addLensSlot(slot);
		logicalSchema.addView(view);
		log('Deployed lens for %s.%s over %s', logicalSchemaName, slot.logicalTable.name, slot.defaultBasis.schemaName);
	}

	// Capture + rotate the deployed-basis snapshot AFTER a successful catalog
	// mutation, so an aborted re-apply leaves the prior snapshot untouched. The
	// snapshot is the source of truth the `quereus_basis_backfill` differ reads
	// (docs/lens.md § The deployed basis representation).
	const snapshot = buildDeploymentSnapshot(db, compiled, basis, logicalSchemaName);
	db.declaredSchemaManager.rotateDeployedLensSnapshot(logicalSchemaName, snapshot);
}

/**
 * Builds the {@link LensDeploymentSnapshot} for a just-completed deploy: per
 * logical table, the compiled get-body, its non-hidden logical columns, and the
 * per-column basis backing (relation + column) derived from the effective body.
 * Also records `basisHash = computeSchemaHash(basis declared schema)` — the
 * migration-safety record. An empty deploy (every logical table removed, no
 * basis resolved) yields an empty-tables snapshot that still rotates, so the
 * detach is reflected.
 */
function buildDeploymentSnapshot(
	db: Database,
	compiled: ReadonlyArray<{ slot: LensSlot; view: ViewSchema }>,
	basis: { schema: Schema; schemaName: string } | undefined,
	logicalSchemaName: string,
): LensDeploymentSnapshot {
	const priorBasisName = db.declaredSchemaManager.getDeployedLensSnapshots(logicalSchemaName)?.current?.basisSchemaName;
	const basisSchemaName = basis?.schemaName ?? priorBasisName ?? '';
	const basisDeclared = basisSchemaName
		? db.declaredSchemaManager.getDeclaredSchema(basisSchemaName)
		: undefined;
	const basisHash = basisDeclared ? computeSchemaHash(basisDeclared) : '';

	const tables = new Map<string, LensTableSnapshot>();
	if (basis) {
		for (const { slot } of compiled) {
			const relationBacking = deriveRelationBacking(slot.compiledBody, slot.columnProvenance, basis, db.schemaManager);
			const logicalColumns = slot.columnProvenance.filter(p => p.source !== 'hidden').map(p => p.logicalColumn);
			const surrogateMemberKeys = deriveSurrogateMemberKeys(slot, basis);
			tables.set(slot.logicalTable.name.toLowerCase(), {
				logicalTable: slot.logicalTable.name,
				getBody: slot.compiledBody,
				logicalColumns,
				relationBacking,
				surrogateMemberKeys,
			});
		}
	}
	return { basisSchemaName, basisHash, tables };
}

/** Lowercased `schema.table` identity for an override source's basis relation. */
function sourceRelKey(src: OverrideSource): string {
	return `${src.table.schemaName.toLowerCase()}.${src.table.name.toLowerCase()}`;
}

/**
 * The basis columns an engine-generated skeleton insert must supply: NOT NULL,
 * no default, non-generated. A column that is nullable, defaulted, or generated
 * has its own value source, so a skeleton may soundly omit it; these have none,
 * so omitting one would fail an unguarded NOT NULL constraint. Walks the member's
 * *full* schema so it also flags required columns the lens maps to no logical
 * column (which never appear in the relation's `(basisColumn → logicalColumn)`
 * pairs). See `LensRelationBacking.requiredBasisColumns`.
 */
function requiredBasisColumnsOf(table: TableSchema): string[] {
	return table.columns
		.filter(c => c.notNull && c.defaultValue === null && !c.generated)
		.map(c => c.name);
}

/**
 * Derives, per basis relation, the `(basisColumn → logicalColumn)` pairs it backs
 * for one compiled effective body — the record a later re-decomposition diffs and
 * backfills (docs/lens.md § The deployed basis representation). Two contributions:
 *
 * 1. **Projection.** The body's projection is exactly the non-hidden logical
 *    columns, in declaration order (see `compileDefaultBody` / `compileOverrideBody`);
 *    each plain column reference resolves to its FROM source. A computed
 *    (non-column) projection has no single basis backing and is omitted.
 * 2. **Shared join keys.** A columnar split joins its members on a shared key but
 *    projects it only once (from the anchor). The other members carry the key
 *    column too and must be backfilled with it, else a `not null` key fails. So
 *    every join-key column equated to a *projected* logical column is threaded to
 *    its member, mapped to that logical column.
 */
function deriveRelationBacking(
	body: AST.SelectStmt,
	provenance: ReadonlyArray<LensColumnProvenance>,
	basis: { schema: Schema; schemaName: string },
	schemaManager: SchemaManager,
): Map<string, LensRelationBacking> {
	const { sources } = collectOverrideSources(body.from, basis.schemaName, schemaManager);
	const byRef = new Map<string, OverrideSource>();
	for (const s of sources) byRef.set(s.refName.toLowerCase(), s);
	const single = sources.length === 1 ? sources[0] : undefined;

	const result = new Map<string, LensRelationBacking>();
	const add = (src: OverrideSource, basisColumn: string, logicalColumn: string): void => {
		const key = sourceRelKey(src);
		let rb = result.get(key);
		if (!rb) {
			rb = {
				relationId: key,
				basisRelation: { schema: src.table.schemaName, table: src.table.name },
				columns: [],
				requiredBasisColumns: requiredBasisColumnsOf(src.table),
			};
			result.set(key, rb);
		}
		const cols = rb.columns as Array<{ basisColumn: string; logicalColumn: string }>;
		if (!cols.some(c => c.basisColumn.toLowerCase() === basisColumn.toLowerCase())) {
			cols.push({ basisColumn, logicalColumn });
		}
	};

	// 1. Projection.
	const projected: Array<{ logical: string; src: OverrideSource; basisColumn: string }> = [];
	const nonHidden = provenance.filter(p => p.source !== 'hidden');
	for (let i = 0; i < nonHidden.length && i < body.columns.length; i++) {
		const rc = body.columns[i];
		if (rc.type !== 'column') continue;
		const expr = rc.expr;
		if (expr.type !== 'column') continue; // computed → no single backing relation
		const colExpr = expr as AST.ColumnExpr;
		const src = colExpr.table ? byRef.get(colExpr.table.toLowerCase()) : single;
		if (!src) continue; // unqualified ref over a multi-source FROM, or an opaque source
		projected.push({ logical: nonHidden[i].logicalColumn, src, basisColumn: colExpr.name });
		add(src, colExpr.name, nonHidden[i].logicalColumn);
	}

	// 2. Shared join keys — thread each equated key column to a projected logical column.
	for (const cls of collectJoinKeyEquivalences(body.from, basis.schemaName, schemaManager)) {
		let logical: string | undefined;
		for (const m of cls) {
			const proj = projected.find(p => sourceRelKey(p.src) === sourceRelKey(m.src)
				&& p.basisColumn.toLowerCase() === m.column.toLowerCase());
			if (proj) { logical = proj.logical; break; }
		}
		if (!logical) continue; // key not surfaced as a logical column → leave to multi-source
		for (const m of cls) add(m.src, m.column, logical);
	}

	return result;
}

/** One member of a join-key equivalence class: a basis source's key column. */
interface KeyMember {
	src: OverrideSource;
	/** The basis column name (original case) on `src` that the join equates. */
	column: string;
}

/**
 * Collects join-key equivalence classes from a body's FROM. Each `using (cols)`
 * join contributes, per column, the equated key columns across its left/right
 * subtree sources; each `on a.x = b.y` conjunct contributes that pair. Overlapping
 * classes are harmless — threading dedups per relation.
 */
function collectJoinKeyEquivalences(
	from: ReadonlyArray<AST.FromClause> | undefined,
	basisSchemaName: string,
	schemaManager: SchemaManager,
): KeyMember[][] {
	const classes: KeyMember[][] = [];
	if (!from) return classes;

	const resolveTableSources = (node: AST.FromClause): OverrideSource[] => {
		const out: OverrideSource[] = [];
		const walk = (n: AST.FromClause): void => {
			if (n.type === 'table') {
				const schemaName = n.table.schema ?? basisSchemaName;
				const tbl = schemaManager.getSchema(schemaName)?.getTable(n.table.name);
				if (tbl) out.push({ table: tbl, refName: n.alias ?? tbl.name });
			} else if (n.type === 'join') {
				walk(n.left);
				walk(n.right);
			}
		};
		walk(node);
		return out;
	};

	const memberFor = (src: OverrideSource, colName: string): KeyMember | undefined => {
		const idx = src.table.columnIndexMap.get(colName.toLowerCase());
		if (idx === undefined) return undefined;
		return { src, column: src.table.columns[idx].name };
	};

	const walkJoin = (node: AST.FromClause): void => {
		if (node.type !== 'join') return;
		walkJoin(node.left);
		walkJoin(node.right);
		const subtree = [...resolveTableSources(node.left), ...resolveTableSources(node.right)];
		if (node.columns) {
			// USING (cols): equate each named column across every subtree source carrying it.
			for (const col of node.columns) {
				const members = subtree.map(s => memberFor(s, col)).filter((m): m is KeyMember => m !== undefined);
				if (members.length > 1) classes.push(members);
			}
		} else if (node.condition) {
			// ON a.x = b.y [and ...]: best-effort equality-conjunct extraction.
			const byRef = new Map<string, OverrideSource>();
			for (const s of subtree) byRef.set(s.refName.toLowerCase(), s);
			for (const [left, right] of collectEqualityPairs(node.condition)) {
				if (!left.table || !right.table) continue;
				const ls = byRef.get(left.table.toLowerCase());
				const rs = byRef.get(right.table.toLowerCase());
				if (!ls || !rs) continue;
				const lm = memberFor(ls, left.name);
				const rm = memberFor(rs, right.name);
				if (lm && rm) classes.push([lm, rm]);
			}
		}
	};
	for (const f of from) walkJoin(f);
	return classes;
}

/** Extracts `col = col` conjuncts from an ON condition (best-effort, AND-only). */
function collectEqualityPairs(expr: AST.Expression): Array<[AST.ColumnExpr, AST.ColumnExpr]> {
	const pairs: Array<[AST.ColumnExpr, AST.ColumnExpr]> = [];
	const walk = (e: AST.Expression): void => {
		if (e.type !== 'binary') return;
		const bin = e as AST.BinaryExpr;
		if (bin.operator.toUpperCase() === 'AND') {
			walk(bin.left);
			walk(bin.right);
		} else if (bin.operator === '=' && bin.left.type === 'column' && bin.right.type === 'column') {
			pairs.push([bin.left as AST.ColumnExpr, bin.right as AST.ColumnExpr]);
		}
	};
	walk(expr);
	return pairs;
}

/**
 * The basis-relation keys (`schema.table`, lowercased) of a slot's surrogate-keyed
 * decomposition members, or undefined when there is no advertisement / the shared
 * key is a logical-tuple. Lets the differ defer an unsound multi-member surrogate
 * split (see `docs/lens.md` § The Default Mapper — evaluate-once-and-thread).
 */
function deriveSurrogateMemberKeys(
	slot: LensSlot,
	basis: { schema: Schema; schemaName: string },
): ReadonlySet<string> | undefined {
	const storage = slot.advertisement?.storage;
	if (!storage || storage.sharedKey.kind !== 'surrogate') return undefined;
	const keys = new Set<string>();
	for (const m of storage.members) {
		const schemaName = (m.relation.schema || basis.schemaName).toLowerCase();
		keys.add(`${schemaName}.${m.relation.table.toLowerCase()}`);
	}
	return keys;
}

/**
 * PoC wiring for `reserved-tags.ts`: validates the reserved `quereus.*` tag
 * namespace on one lens slot's logical table (`logical-table` site) and each of
 * its attached constraints (`logical-constraint` site).
 *
 * Severity policy is the registry's; this caller only routes it: a
 * `severity:'error'` diagnostic (unknown key, mis-sited key, malformed enum/CSV
 * value) throws a {@link QuereusError} with the sited message — consistent with
 * the other compile-time lens errors, and atomic because validation runs before
 * catalog mutation. `severity:'warning'` diagnostics (e.g. an empty
 * `quereus.lens.ack` rationale) are logged via the existing `log` channel; the
 * deploy-summary warning channel (`docs/lens.md:169`) is `3-lens-prover` Phase
 * C's to build. Errors take precedence — warnings only log when none fail.
 *
 * This validates shape/site only. `quereus.update.*` keys are reachable through
 * the same {@link validateReservedTags} entry point but are NOT wired into any
 * DML/view path here (that is `view-mutation-plan-node-substrate` Phase 2's).
 */
function validateLensTags(slot: LensSlot): void {
	const diagnostics: TagDiagnostic[] = [
		...validateReservedTags(slot.logicalTable.tags, 'logical-table'),
	];
	for (const constraint of slot.attachedConstraints) {
		const tags = constraint.kind === 'primaryKey' ? undefined : constraint.constraint.tags;
		if (tags) diagnostics.push(...validateReservedTags(tags, 'logical-constraint'));
	}

	const firstError = diagnostics.find(d => d.severity === 'error');
	if (firstError) {
		throw new QuereusError(firstError.message, StatusCode.ERROR);
	}
	for (const diag of diagnostics) {
		log('lens advisory (%s) on %s.%s: %s', diag.reason, slot.logicalTable.schemaName, slot.logicalTable.name, diag.message);
	}
}

/**
 * Rejects every physical construct under a logical declared schema, naming the
 * offending construct and the logical-schema context. Tags are allowed (they
 * are engine-facing and survive into the compiled view).
 */
export function validateLogicalDeclaration(
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	const ctx = `logical schema '${logicalSchemaName}'`;
	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				if (item.tableStmt.moduleName) {
					throw new QuereusError(
						`lens: module association 'using ${item.tableStmt.moduleName}(...)' on table '${item.tableStmt.table.name}' is not allowed in ${ctx}; logical tables declare columns and constraints only`,
						StatusCode.ERROR,
					);
				}
				break;
			}
			case 'declaredIndex': {
				const kind = item.indexStmt.isUnique ? 'unique index' : 'index';
				throw new QuereusError(
					`lens: ${kind} '${item.indexStmt.index.name}' is not allowed in ${ctx}; indexes are a basis-layer construct (a materialized view over the basis)`,
					StatusCode.ERROR,
				);
			}
			case 'declaredMaterializedView': {
				throw new QuereusError(
					`lens: materialized view '${item.viewStmt.view.name}' is not allowed in ${ctx}; materialized views are a basis-layer construct`,
					StatusCode.ERROR,
				);
			}
			// declaredView / declaredSeed / declaredAssertion / declareIgnored:
			// not part of the logical-table surface in v1 — neither rejected nor
			// processed by the lens compiler (only declaredTable becomes a slot).
		}
	}
}

/**
 * Infers the default basis for a logical schema (MVP binding — there is no
 * `declare lens for X over Y` yet). The basis is the single registered
 * **physical** schema that contains ≥1 table, excluding the logical schema
 * itself and `temp`. See `docs/lens.md` § Default-basis inference.
 */
export function inferDefaultBasis(
	schemaManager: SchemaManager,
	logicalSchemaName: string,
): { schema: Schema; schemaName: string } {
	const lowerLogical = logicalSchemaName.toLowerCase();
	const candidates: Array<{ schema: Schema; schemaName: string }> = [];

	for (const schema of schemaManager._getAllSchemas()) {
		const lowerName = schema.name.toLowerCase();
		if (lowerName === lowerLogical) continue;
		if (lowerName === 'temp') continue;
		if (schema.kind !== 'physical') continue;

		let hasTable = false;
		for (const _t of schema.getAllTables()) { hasTable = true; break; }
		if (!hasTable) continue;

		candidates.push({ schema, schemaName: schema.name });
	}

	if (candidates.length === 1) {
		return candidates[0];
	}

	throw new QuereusError(
		`lens: cannot infer a default basis for logical schema '${logicalSchemaName}' (found ${candidates.length} candidates); supply 'declare lens for ${logicalSchemaName} over <basis>'`,
		StatusCode.ERROR,
	);
}

/**
 * The default name-based aligner: produces `select <logical columns> from B.T'`
 * for one logical table `L.T` over basis schema `B`.
 *
 * - The basis table is matched by name (case-insensitive).
 * - Each logical column is matched to a basis column by name (case-insensitive).
 * - The projection lists exactly the logical columns, in declaration order, so
 *   a basis table with extra columns is correctly projected down.
 *
 * The empty-key (singleton) case needs no special path: a `primary key ()`
 * logical table over a `primary key ()` basis table is an ordinary single-source
 * projection.
 */
export function compileDefaultBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchema: Schema,
	basisSchemaName: string,
): AST.SelectStmt {
	const logicalName = logicalTable.name;
	const basisTable = basisSchema.getTable(logicalName);
	if (!basisTable) {
		throw new QuereusError(
			`lens: logical table '${logicalSchemaName}.${logicalName}' has no basis backing`,
			StatusCode.ERROR,
		);
	}

	const columns: AST.ResultColumn[] = [];
	for (const col of logicalTable.columns) {
		const basisColIdx = basisTable.columnIndexMap.get(col.name.toLowerCase());
		if (basisColIdx === undefined) {
			throw new QuereusError(
				`lens: logical column '${logicalSchemaName}.${logicalName}.${col.name}' has no basis backing`,
				StatusCode.ERROR,
			);
		}
		// Single source → an unqualified column reference is unambiguous. Reference
		// the basis column by its actual name; the consumer-facing column *names*
		// (and casing) are pinned to the logical declaration via the registered
		// view's explicit column list (see `deployLogicalSchema`), so the basis
		// spelling never leaks through `select * from Logical.T`.
		const basisColName = basisTable.columns[basisColIdx].name;
		columns.push({
			type: 'column',
			expr: { type: 'column', name: basisColName } as AST.ColumnExpr,
		});
	}

	return {
		type: 'select',
		columns,
		from: [{
			type: 'table',
			table: { type: 'identifier', name: basisTable.name, schema: basisSchemaName },
		}],
	};
}

/**
 * Indexes a lens block's overrides by lowercased logical-table name, validating
 * that each names a logical table the declaration actually carries. The check
 * is skipped for an empty declaration (a pure detach-everything re-apply, which
 * never aligns a basis).
 */
function indexOverrides(
	lensDecl: AST.DeclareLensStmt | undefined,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): Map<string, AST.LensOverride> {
	const byTable = new Map<string, AST.LensOverride>();
	if (!lensDecl) return byTable;

	const declaredTableNames = new Set<string>();
	for (const item of declaredSchema.items) {
		if (item.type === 'declaredTable') declaredTableNames.add(item.tableStmt.table.name.toLowerCase());
	}
	for (const ov of lensDecl.overrides) {
		const key = ov.table.toLowerCase();
		if (declaredTableNames.size > 0 && !declaredTableNames.has(key)) {
			throw new QuereusError(
				`lens: override 'view ${ov.table} as ...' references logical table '${logicalSchemaName}.${ov.table}', which is not declared in logical schema '${logicalSchemaName}'`,
				StatusCode.ERROR,
			);
		}
		byTable.set(key, ov);
	}
	return byTable;
}

/** A basis table referenced by an override's FROM clause, with its ref name. */
interface OverrideSource {
	/** The resolved basis table schema. */
	table: TableSchema;
	/** Alias if the FROM gave one, else the table name — used to qualify refs. */
	refName: string;
}

/**
 * Composes one effective **read** body for a logical table that has a
 * `declare lens` override, per docs/lens.md § D2:
 *
 *   covered columns (override projection) ⊕ default-mapper gap-fill ⊖ hidden.
 *
 * Coverage is read **by name** from the override's output column names (alias or
 * bare name, and `*`-expansion of FROM-source columns). Each uncovered,
 * non-hidden logical column is gap-filled from a same-named basis column of the
 * override's FROM. When a gap is not reachable from the FROM (the hide-via-
 * gap-fill trap, or a partial cross-basis join), the compile errors rather than
 * emit an unsound body. The composition is recomputed on every deploy.
 */
function compileOverrideBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	override: AST.LensOverride,
): { body: AST.SelectStmt; provenance: LensColumnProvenance[]; hiding: ReadonlySet<string>; effectiveColumns: string[] } {
	const select = override.select;
	const logicalName = logicalTable.name;

	// Every FROM source the override names must live in the declared basis — an
	// override referencing a *different* existing schema (e.g. `Z.Foo` while the
	// lens is `over Y`) would silently re-anchor the body to Z (docs/lens.md § D4).
	validateOverrideBasisSources(select.from, basisSchemaName, logicalSchemaName, logicalName);

	const hidden = new Set((override.hiding ?? []).map(h => h.toLowerCase()));
	// `hiding (...)` names that match no logical column are silently a no-op (a
	// typo hides nothing). Validate against the logical columns, preserving the
	// author's spelling in the message.
	const logicalColumnNames = new Set(logicalTable.columns.map(c => c.name.toLowerCase()));
	for (const h of override.hiding ?? []) {
		if (!logicalColumnNames.has(h.toLowerCase())) {
			throw new QuereusError(
				`lens: override for logical table '${logicalSchemaName}.${logicalName}' hides unknown column '${h}'; it matches no column of the logical table`,
				StatusCode.ERROR,
			);
		}
	}

	// Resolve FROM-source basis tables once — used for both `*` expansion and
	// gap-fill. Opaque sources (subquery / function / unresolvable table) are
	// tracked so a gap that actually needs them errors precisely.
	const { sources, hasOpaqueSource } = collectOverrideSources(select.from, basisSchemaName, schemaManager);
	const qualify = sources.length > 1;

	// Coverage map: lowercased output-column name -> the expression producing it.
	const coverage = new Map<string, AST.Expression>();
	let hasStar = false;
	let starTable: string | undefined;
	for (const col of select.columns) {
		if (col.type === 'all') {
			hasStar = true;
			if (col.table) starTable = col.table.toLowerCase();
			continue;
		}
		const outName = deriveColumnOutputName(col);
		if (!outName) {
			// A computed (non-column) projection term without an alias maps to no
			// logical column — it would be silently dropped, then the same-named
			// logical column gap-filled from the basis (a wrong, surprising read).
			throw new QuereusError(
				`lens: override for logical table '${logicalSchemaName}.${logicalName}' has a computed projection term '${astToString(col.expr)}' with no output name; add an alias (... as <name>) so it maps to a logical column`,
				StatusCode.ERROR,
			);
		}
		coverage.set(outName.toLowerCase(), col.expr);
	}

	// `*` covers every FROM-source column not already explicitly covered.
	if (hasStar) {
		for (const src of sources) {
			if (starTable && src.refName.toLowerCase() !== starTable) continue;
			for (const c of src.table.columns) {
				const key = c.name.toLowerCase();
				if (!coverage.has(key)) coverage.set(key, columnRef(c.name, qualify ? src.refName : undefined));
			}
		}
	}

	const composed: AST.ResultColumn[] = [];
	const provenance: LensColumnProvenance[] = [];
	const effectiveColumns: string[] = [];
	for (const col of logicalTable.columns) {
		const key = col.name.toLowerCase();
		if (hidden.has(key)) {
			provenance.push({ logicalColumn: col.name, source: 'hidden' });
			continue;
		}
		const coveredExpr = coverage.get(key);
		if (coveredExpr !== undefined) {
			composed.push({ type: 'column', expr: coveredExpr, alias: col.name });
			provenance.push({ logicalColumn: col.name, source: 'override' });
		} else {
			const ref = gapFillRef(col.name, sources, qualify);
			if (!ref) {
				throw new QuereusError(
					gapFillError(logicalSchemaName, logicalName, col.name, sources, hasOpaqueSource),
					StatusCode.ERROR,
				);
			}
			composed.push({ type: 'column', expr: ref, alias: col.name });
			provenance.push({ logicalColumn: col.name, source: 'default' });
		}
		effectiveColumns.push(col.name);
	}

	// Preserve every non-projection clause of the override (where/group/having/
	// order/limit/distinct/with — the filter shape, etc.); replace only the
	// projection with the composed logical-column list.
	const body: AST.SelectStmt = { ...select, columns: composed };
	return { body, provenance, hiding: hidden, effectiveColumns };
}

/** Walks an override's FROM tree, collecting introspectable basis-table sources. */
function collectOverrideSources(
	from: ReadonlyArray<AST.FromClause> | undefined,
	basisSchemaName: string,
	schemaManager: SchemaManager,
): { sources: OverrideSource[]; hasOpaqueSource: boolean } {
	const sources: OverrideSource[] = [];
	let hasOpaqueSource = false;

	const walk = (node: AST.FromClause): void => {
		switch (node.type) {
			case 'table': {
				const schemaName = node.table.schema ?? basisSchemaName;
				const tbl = schemaManager.getSchema(schemaName)?.getTable(node.table.name);
				if (!tbl) { hasOpaqueSource = true; return; }
				sources.push({ table: tbl, refName: node.alias ?? tbl.name });
				break;
			}
			case 'join': {
				walk(node.left);
				walk(node.right);
				break;
			}
			default:
				// subquerySource / functionSource — not introspectable in v1.
				hasOpaqueSource = true;
				break;
		}
	};

	if (from) for (const f of from) walk(f);
	return { sources, hasOpaqueSource };
}

/**
 * Validates that every introspectable `table` source in an override's FROM tree
 * resolves to the declared basis schema. A table qualified with a *different*
 * existing schema would otherwise bind there silently (re-anchoring the lens off
 * its `over Y` basis); reject it at deploy time. Unqualified tables default to
 * the basis and are fine; tables qualified with the basis name are fine.
 *
 * KNOWN GAP: opaque sources (subquery / function) are not descended into, so a
 * cross-basis table hidden inside a subquery FROM (e.g.
 * `from (select * from z.Foo)`) is NOT caught here. The gap-fill error path only
 * catches it when some logical column is left uncovered; a subquery override that
 * covers every logical column explicitly still re-anchors silently. Closing this
 * requires walking nested subquery FROM trees (and excluding their CTE names) —
 * tracked by `lens-override-subquery-cross-basis`. Mirrors
 * `collectOverrideSources`'s FROM walk but does not share it (that helper is also
 * used where re-anchoring is allowed).
 */
function validateOverrideBasisSources(
	from: ReadonlyArray<AST.FromClause> | undefined,
	basisSchemaName: string,
	logicalSchemaName: string,
	logicalName: string,
): void {
	if (!from) return;
	const lowerBasis = basisSchemaName.toLowerCase();
	const walk = (node: AST.FromClause): void => {
		switch (node.type) {
			case 'table': {
				const schema = node.table.schema;
				if (schema && schema.toLowerCase() !== lowerBasis) {
					throw new QuereusError(
						`lens: override for logical table '${logicalSchemaName}.${logicalName}' references basis relation '${schema}.${node.table.name}' outside the declared basis '${basisSchemaName}' (the lens is declared 'over ${basisSchemaName}'); an override's FROM may only reference the declared basis`,
						StatusCode.ERROR,
					);
				}
				break;
			}
			case 'join': {
				walk(node.left);
				walk(node.right);
				break;
			}
			default:
				// subquerySource / functionSource — not introspectable in v1.
				break;
		}
	};
	for (const f of from) walk(f);
}

/** Output name a result column contributes: its alias, or the bare column name. */
function deriveColumnOutputName(col: AST.ResultColumnExpr): string | undefined {
	if (col.alias) return col.alias;
	return col.expr.type === 'column' ? col.expr.name : undefined;
}

/** Builds a column reference, optionally qualified by a source ref name. */
function columnRef(name: string, refName: string | undefined): AST.ColumnExpr {
	return refName ? { type: 'column', name, table: refName } : { type: 'column', name };
}

/** Finds a same-named basis column across the override's FROM sources. */
function gapFillRef(colName: string, sources: ReadonlyArray<OverrideSource>, qualify: boolean): AST.ColumnExpr | undefined {
	const lower = colName.toLowerCase();
	for (const src of sources) {
		const idx = src.table.columnIndexMap.get(lower);
		if (idx !== undefined) {
			// Reference the basis column by its actual name (casing); the logical
			// alias is applied by the caller.
			return columnRef(src.table.columns[idx].name, qualify ? src.refName : undefined);
		}
	}
	return undefined;
}

/** Diagnostic for an uncovered, non-hidden logical column the FROM can't gap-fill. */
function gapFillError(
	logicalSchemaName: string,
	logicalName: string,
	colName: string,
	sources: ReadonlyArray<OverrideSource>,
	hasOpaqueSource: boolean,
): string {
	const sourceDesc = sources.length === 0
		? 'the override FROM exposes no introspectable basis table'
		: `basis source(s) ${sources.map(s => s.table.name).join(', ')} have no column '${colName}'`;
	if (sources.length > 1 || hasOpaqueSource) {
		// Cross-basis / partial-coverage fidelity boundary (docs/lens.md § D2).
		return `lens: override for logical table '${logicalSchemaName}.${logicalName}' covers only some columns; uncovered column '${colName}' is not reachable from the override's FROM (${sourceDesc}) — it would need a basis source the v1 single-source mapper cannot join in. Cover it explicitly or list it in hiding(...)`;
	}
	// Single-source hide-via-gap-fill trap (docs/lens.md § D3).
	return `lens: override for logical table '${logicalSchemaName}.${logicalName}' leaves column '${colName}' uncovered and ${sourceDesc} to gap-fill from (the hide-via-gap-fill trap) — add it to the override projection or list it in hiding(...)`;
}

// ===========================================================================
// Module mapping advertisement resolution (docs/lens.md § The Default Mapper)
// ===========================================================================
//
// The protocol seam: a virtual-table module advertises how a set of its basis
// relations decomposes a logical table (columnar split / EAV / column-family /
// nd-tree). This compiler **resolves** (collects + selects the single primary +
// validates) and **stores** the advertisement on the lens slot; it does NOT
// synthesize the n-way body — that is `lens-multi-source-decomposition`, which
// reads `slot.advertisement`. Validation aborts the deploy atomically (before
// any catalog mutation), aggregating every problem with a named site, matching
// the contract `validateLensTags` already follows.

/**
 * Collects the mapping advertisements every module owning ≥1 table in `basis`
 * recognizes, deduplicated by the advertisement `id`. A generic module
 * (memory/store) returns tag-derived advertisements; a generic module that scans
 * the whole schema may be hit once per distinct module instance, so the same
 * tag-derived advertisement can appear twice — the `id` dedup collapses those.
 */
function collectAdvertisements(db: Database, basis: Schema): MappingAdvertisement[] {
	const modules = new Set<AnyVirtualTableModule>();
	for (const table of basis.getAllTables()) {
		if (table.vtabModule) modules.add(table.vtabModule);
	}
	const byId = new Map<string, MappingAdvertisement>();
	for (const module of modules) {
		const ads = module.getMappingAdvertisements?.(db, basis) ?? [];
		for (const ad of ads) {
			if (!byId.has(ad.id)) byId.set(ad.id, ad);
		}
	}
	return Array.from(byId.values());
}

/**
 * Resolves the advertisements for one logical table: filters to the table,
 * selects the single `primary-storage` (accommodation #5 — two is an error),
 * keeps the rest as `auxiliary-access`, and validates the primary's structural
 * coherence. Returns the resolved slot fields; throws (aggregated) on any
 * validation failure so the deploy aborts before catalog mutation.
 *
 * `hasOverride` relaxes the per-column coverage check: when an override exists
 * its own coverage validation (`compileOverrideBody`) owns the column-coverage
 * verdict, so the advertisement is only checked for internal coherence.
 */
function resolveAdvertisement(
	all: ReadonlyArray<MappingAdvertisement>,
	logicalTable: TableSchema,
	basis: { schema: Schema; schemaName: string },
	db: Database,
	logicalSchemaName: string,
	hasOverride: boolean,
): { advertisement?: MappingAdvertisement; auxiliaryAccess?: ReadonlyArray<MappingAdvertisement> } {
	const lower = logicalTable.name.toLowerCase();
	const matching = all.filter(a => a.logicalTable.toLowerCase() === lower);
	if (matching.length === 0) return {};

	const primaries = matching.filter(a => a.role === 'primary-storage');
	const auxiliaries = matching.filter(a => a.role === 'auxiliary-access');

	const errors: string[] = [];
	if (primaries.length > 1) {
		errors.push(
			`has ${primaries.length} primary-storage advertisements (${primaries.map(p => `'${p.id}'`).join(', ')}); at most one is allowed`,
		);
	}
	const advertisement = primaries[0];
	if (advertisement) {
		validatePrimaryAdvertisement(advertisement, logicalTable, basis, db, hasOverride, errors);
	}
	for (const aux of auxiliaries) {
		validateAuxiliaryAdvertisement(aux, basis, db, errors);
	}

	if (errors.length > 0) {
		throw new QuereusError(
			`lens: advertisement for logical table '${logicalSchemaName}.${logicalTable.name}' is invalid: ${errors.join('; ')}`,
			StatusCode.ERROR,
		);
	}

	return {
		advertisement,
		auxiliaryAccess: auxiliaries.length > 0 ? auxiliaries : undefined,
	};
}

/**
 * Validates a `primary-storage` advertisement's structural coherence. Each check
 * pushes a sited message to `errors` (aggregated by the caller); none mutate the
 * catalog. See `docs/lens.md` § The Default Mapper for the field semantics.
 */
function validatePrimaryAdvertisement(
	ad: MappingAdvertisement,
	logicalTable: TableSchema,
	basis: { schema: Schema; schemaName: string },
	db: Database,
	hasOverride: boolean,
	errors: string[],
): void {
	const storage = ad.storage;
	if (!storage) {
		errors.push(`role 'primary-storage' requires a storage shape`);
		return;
	}
	// The IND existence-anchor contract: id == anchorRelationId (so the INDs the
	// synthesis ticket injects, with IndTarget.kind:'relation'.relationId, and the
	// join it builds agree on the anchor).
	if (ad.id !== storage.anchorRelationId) {
		errors.push(`advertisement id '${ad.id}' must equal storage.anchorRelationId '${storage.anchorRelationId}'`);
	}

	const memberByRelationId = new Map<string, DecompositionMember>();
	for (const member of storage.members) memberByRelationId.set(member.relationId, member);

	if (!memberByRelationId.has(storage.anchorRelationId)) {
		errors.push(`anchor '${storage.anchorRelationId}' is not among the members (${storage.members.map(m => `'${m.relationId}'`).join(', ') || 'none'})`);
	}

	// Resolve each member's basis table; validate column / pivot existence.
	const memberTables = new Map<string, TableSchema>();
	for (const member of storage.members) {
		const table = resolveBasisRelation(db, member, basis);
		if (!table) {
			errors.push(`member '${member.relationId}' references basis relation '${member.relation.schema}.${member.relation.table}', which does not exist`);
			continue;
		}
		memberTables.set(member.relationId, table);

		for (const mapping of member.columns) {
			for (const refName of collectColumnRefNames(mapping.basisExpr)) {
				if (!table.columnIndexMap.has(refName.toLowerCase())) {
					errors.push(`member '${member.relationId}' maps logical column '${mapping.logicalColumn}' to basis expression referencing column '${refName}', which does not exist on '${table.name}'`);
				}
			}
		}
		if (member.attributePivot) {
			for (const [role, col] of [
				['entity', member.attributePivot.entityColumn],
				['attribute', member.attributePivot.attributeColumn],
				['value', member.attributePivot.valueColumn],
			] as const) {
				if (!table.columnIndexMap.has(col.toLowerCase())) {
					errors.push(`member '${member.relationId}' attributePivot ${role} column '${col}' does not exist on '${table.name}'`);
				}
			}
		}
	}

	// Shared key: surrogate ⇒ generator present; logical-tuple ⇒ generator absent
	// AND each member's key columns match the logical PK arity.
	const sharedKey = storage.sharedKey;
	if (sharedKey.kind === 'surrogate' && !sharedKey.generator) {
		errors.push(`shared key is 'surrogate' but no generator is declared`);
	}
	if (sharedKey.kind === 'logical-tuple') {
		if (sharedKey.generator) {
			errors.push(`shared key is 'logical-tuple' but a generator is declared (a logical-tuple key collapses surrogate generation)`);
		}
		const pkArity = logicalTable.primaryKeyDefinition.length;
		for (const member of storage.members) {
			const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId);
			if (keyCols && keyCols.length !== pkArity) {
				errors.push(`shared key is 'logical-tuple' but member '${member.relationId}' has ${keyCols.length} key column(s), not the logical primary key's arity (${pkArity})`);
			}
		}
	}

	// keyColumnsByRelation covers every member and each named column exists.
	for (const member of storage.members) {
		const keyCols = sharedKey.keyColumnsByRelation.get(member.relationId);
		if (keyCols === undefined) {
			errors.push(`shared key has no key columns for member '${member.relationId}'`);
			continue;
		}
		const table = memberTables.get(member.relationId);
		if (!table) continue; // already reported as a missing relation
		for (const col of keyCols) {
			if (!table.columnIndexMap.has(col.toLowerCase())) {
				errors.push(`shared key column '${col}' for member '${member.relationId}' does not exist on '${table.name}'`);
			}
		}
	}

	// Column coverage (only when there is no override — an override's own coverage
	// validation owns the verdict otherwise). Every logical column must be backed
	// by exactly one member mapping, or by an EAV pivot member, or be coverable by
	// name-match against the basis. Otherwise the advertisement claims the table
	// but leaves the column unbacked and uncovered → error, naming the column.
	if (!hasOverride) {
		const backedBy = buildColumnBackingMap(storage);
		const hasEavMember = storage.members.some(m => m.attributePivot);
		const nameMatchTable = basis.schema.getTable(logicalTable.name);
		for (const col of logicalTable.columns) {
			const lc = col.name.toLowerCase();
			if (backedBy.get(lc) === 'ambiguous') {
				errors.push(`logical column '${col.name}' is backed by more than one member mapping (must be exactly one)`);
				continue;
			}
			if (backedBy.has(lc)) continue; // exactly one member maps it
			if (hasEavMember) continue;      // an EAV pivot member backs it generically
			if (nameMatchTable?.columnIndexMap.has(lc)) continue; // left to name-match
			errors.push(`logical column '${col.name}' is left unbacked by the advertisement and is not coverable by name-match (cover it with a member mapping, an EAV pivot, or a name-matching basis column)`);
		}
	}
}

/**
 * Minimal validation for an `auxiliary-access` advertisement: every member
 * relation must resolve. The access-shape planner consumer is deferred (backlog
 * `lens-access-shape-path-selection`), so its predicate forms are stored
 * unvalidated here.
 */
function validateAuxiliaryAdvertisement(
	ad: MappingAdvertisement,
	basis: { schema: Schema; schemaName: string },
	db: Database,
	errors: string[],
): void {
	if (!ad.storage) return; // an auxiliary may carry access-only shape
	for (const member of ad.storage.members) {
		if (!resolveBasisRelation(db, member, basis)) {
			errors.push(`auxiliary advertisement '${ad.id}' member '${member.relationId}' references basis relation '${member.relation.schema}.${member.relation.table}', which does not exist`);
		}
	}
}

/**
 * Builds `logicalColumn(lower) -> member relationId | 'ambiguous'` from the
 * explicit per-member column mappings (EAV pivots are handled separately by the
 * caller). A column mapped by two members is `'ambiguous'`.
 */
function buildColumnBackingMap(storage: NonNullable<MappingAdvertisement['storage']>): Map<string, string | 'ambiguous'> {
	const backedBy = new Map<string, string | 'ambiguous'>();
	for (const member of storage.members) {
		for (const mapping of member.columns) {
			const lc = mapping.logicalColumn.toLowerCase();
			backedBy.set(lc, backedBy.has(lc) ? 'ambiguous' : member.relationId);
		}
	}
	return backedBy;
}

/** Resolves a member's {@link BasisRelationRef} to a concrete basis table. */
function resolveBasisRelation(
	db: Database,
	member: DecompositionMember,
	basis: { schema: Schema; schemaName: string },
): TableSchema | undefined {
	const schemaName = member.relation.schema || basis.schemaName;
	const schema = schemaName.toLowerCase() === basis.schemaName.toLowerCase()
		? basis.schema
		: db.schemaManager.getSchema(schemaName);
	return schema?.getTable(member.relation.table);
}

/**
 * Annotates each provenance entry with the member `relationId` that backs its
 * logical column, when the resolved advertisement maps it. Explicit mappings win;
 * a column with no explicit mapping is attributed to the sole EAV pivot member
 * when one exists. Surfaced by `quereus_effective_lens`.
 */
function annotateProvenanceWithAdvertisement(
	provenance: LensColumnProvenance[],
	ad: MappingAdvertisement,
): void {
	const storage = ad.storage;
	if (!storage) return;
	const backedBy = buildColumnBackingMap(storage);
	const eavMembers = storage.members.filter(m => m.attributePivot);
	const soleEav = eavMembers.length === 1 ? eavMembers[0].relationId : undefined;
	for (const p of provenance) {
		if (p.source === 'hidden') continue;
		const explicit = backedBy.get(p.logicalColumn.toLowerCase());
		if (explicit && explicit !== 'ambiguous') {
			p.advertisedBy = explicit;
		} else if (soleEav) {
			p.advertisedBy = soleEav;
		}
	}
}

/**
 * Override ⊕ advertisement conflict (docs/lens.md § Override-vs-advertisement
 * composition): a *sparse* override (one that relies on gap-fill) may correct an
 * advertised column mapping, but must NOT re-anchor or reference basis relations
 * outside the advertised decomposition. Every introspectable basis-table source
 * in the override's FROM must be one of the advertisement's member relations;
 * otherwise the developer is silently re-anchoring and must instead author a full
 * hand-authored body (which bypasses the advertisement entirely). Opaque sources
 * (subquery / function) are not introspectable and do not trip the check.
 */
function validateOverrideAdvertisementConflict(
	ad: MappingAdvertisement,
	override: AST.LensOverride,
	basisSchemaName: string,
	schemaManager: SchemaManager,
	logicalSchemaName: string,
	logicalName: string,
): void {
	const storage = ad.storage;
	if (!storage) return;
	const memberRelations = new Set(
		storage.members.map(m => `${(m.relation.schema || basisSchemaName).toLowerCase()}.${m.relation.table.toLowerCase()}`),
	);
	const { sources } = collectOverrideSources(override.select.from, basisSchemaName, schemaManager);
	for (const src of sources) {
		const key = `${src.table.schemaName.toLowerCase()}.${src.table.name.toLowerCase()}`;
		if (!memberRelations.has(key)) {
			throw new QuereusError(
				`lens: override for logical table '${logicalSchemaName}.${logicalName}' references basis relation '${src.table.schemaName}.${src.table.name}', which is not part of the advertised decomposition (anchor '${storage.anchorRelationId}', members: ${storage.members.map(m => `'${m.relation.table}'`).join(', ')}); a partial override may not re-anchor or change the shared key — cover every logical column explicitly to author a full body that bypasses the advertisement, or align the override's FROM with the decomposition`,
				StatusCode.ERROR,
			);
		}
	}
}

/**
 * Collects the names of every `column` reference in a basis expression (a
 * best-effort reflective walk). Used to validate that an advertisement's
 * `basisExpr` references columns that actually exist on its member relation.
 */
function collectColumnRefNames(expr: AST.Expression): string[] {
	const names: string[] = [];
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'column' && typeof (node as AST.ColumnExpr).name === 'string') {
			names.push((node as AST.ColumnExpr).name);
		}
		for (const key of Object.keys(node)) {
			const value = (node as unknown as Record<string, unknown>)[key];
			if (!value) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					if (item && typeof item === 'object' && 'type' in item) stack.push(item as AST.AstNode);
				}
			} else if (typeof value === 'object' && 'type' in (value as object)) {
				stack.push(value as AST.AstNode);
			}
		}
	}
	return names;
}
