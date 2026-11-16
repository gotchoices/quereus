import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { traverseAst } from '../src/parser/visitor.js';
import type * as AST from '../src/parser/ast.js';
import type { AstNode } from '../src/parser/ast.js';

/** Collect all node types visited via enterNode */
function collectTypes(sql: string): string[] {
	const ast = parse(sql);
	const types: string[] = [];
	traverseAst(ast, {
		enterNode(node: AstNode) {
			types.push(node.type);
		},
	});
	return types;
}

describe('traverseAst', () => {
	describe('traversal control flow', () => {
		it('traverses all children when enterNode returns void', () => {
			const types = collectTypes('select 1, 2');
			expect(types).to.include('select');
			expect(types).to.include('literal');
			expect(types.filter(t => t === 'literal')).to.have.length(2);
		});

		it('stops traversal of a branch when enterNode returns false', () => {
			const ast = parse('select 1 + 2');
			const types: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
					// Stop traversal at binary nodes — should not visit children
					if (node.type === 'binary') return false;
				},
			});
			expect(types).to.include('select');
			expect(types).to.include('binary');
			// The literals under the binary should NOT be visited
			expect(types).to.not.include('literal');
		});

		it('continues traversal when enterNode returns true', () => {
			const types: string[] = [];
			const ast = parse('select 1');
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
					return true;
				},
			});
			expect(types).to.include('select');
			expect(types).to.include('literal');
		});

		it('stops branch when specific visitor returns false', () => {
			const ast = parse('select 1 + 2');
			const types: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					types.push(node.type);
				},
				visitSelect() {
					return false; // Stop — should not visit children of select
				},
			});
			// enterNode sees the select, but visitSelect stops further traversal
			expect(types).to.deep.equal(['select']);
		});

		it('calls exitNode after traversing children', () => {
			const ast = parse('select 1');
			const events: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					events.push(`enter:${node.type}`);
				},
				exitNode(node: AstNode) {
					events.push(`exit:${node.type}`);
				},
			});
			expect(events).to.deep.equal([
				'enter:select',
				'enter:literal',
				'exit:literal',
				'exit:select',
			]);
		});

		it('does not call exitNode when enterNode returns false', () => {
			const ast = parse('select 1');
			const events: string[] = [];
			traverseAst(ast, {
				enterNode(node: AstNode) {
					events.push(`enter:${node.type}`);
					return false; // Stop at select
				},
				exitNode(node: AstNode) {
					events.push(`exit:${node.type}`);
				},
			});
			expect(events).to.deep.equal(['enter:select']);
		});
	});

	// The coverage ledger. One record per AST shape `traverseAst` descends or enters
	// as a leaf, plus every sub-structure such a shape holds an expression through,
	// classifying EVERY field. Its value is compile-time: a new field on any of these
	// shapes fails `yarn lint` (which type-checks this file) until it is classified
	// here, and the runtime test below proves each field marked `descend` is reached.
	// This exists because the determinism gate in `src/schema/manager.ts` walks with
	// `traverseAst`, and a field the traversal skips is a place a non-deterministic
	// call hides from `CREATE TABLE`. New node KINDS are guarded separately, by the
	// exhaustive `switch` in `traverseAst` itself.
	describe('field coverage ledger', () => {
		/** `type` is the discriminant (a frame's units, for `WindowFrame`) and `loc` the source span. */
		type Fields<T> = Exclude<keyof T, 'type' | 'loc'>;
		type Treatment =
			/** SQL — or a built tree, for a field the parser never sets — with `sentinel()` in exactly this field. */
			| { descend: string | (() => AST.AstNode) }
			/** Why the field cannot hold an expression. */
			| { noExpression: string }
			/** The field holds expressions but is deliberately not reached, and why. */
			| { notDescended: string };
		const ledger = <T>(fields: Record<Fields<T>, Treatment>): Record<string, Treatment> =>
			fields as Record<string, Treatment>;

		const flag = { noExpression: 'flag' };
		const names = { noExpression: 'names only' };
		const keyword = { noExpression: 'keyword' };
		const tags = { noExpression: 'literal metadata values' };
		const targetName = { noExpression: 'object name — entered as an identifier node, never an expression' };

		const LEDGERS: Record<string, Record<string, Treatment>> = {
			SelectStmt: ledger<AST.SelectStmt>({
				withClause: { descend: 'with c as (select sentinel()) select 1' },
				columns: { descend: 'select sentinel()' },
				from: { descend: 'select 1 from (select sentinel()) s' },
				where: { descend: 'select 1 from t where sentinel()' },
				groupBy: { descend: 'select 1 from t group by sentinel()' },
				having: { descend: 'select 1 from t group by a having sentinel()' },
				orderBy: { descend: 'select 1 from t order by sentinel()' },
				limit: { descend: 'select 1 from t limit sentinel()' },
				offset: { descend: 'select 1 from t limit 1 offset sentinel()' },
				distinct: flag,
				all: flag,
				union: { descend: () => ({ ...parseSelect('select 1'), union: parseSelect('select sentinel()') }) },
				unionAll: flag,
				compound: { descend: 'select 1 union select sentinel()' },
				schemaPath: names,
				defaults: { descend: 'select a from t with defaults (b = sentinel())' },
				storedBodyEnv: { notDescended: 'write-through lowering metadata the parser never sets, so no schema-time caller meets it' },
			}),
			'SelectStmt.compound': ledger<NonNullable<AST.SelectStmt['compound']>>({
				op: keyword,
				select: { descend: 'select 1 except select sentinel()' },
				existence: names,
			}),
			ResultColumnExpr: ledger<AST.ResultColumnExpr>({
				expr: { descend: 'select sentinel() as x' },
				alias: names,
				inverse: { descend: 'select a + 1 as b with inverse (a = sentinel()) from t' },
			}),
			ResultColumnInverse: ledger<AST.ResultColumnInverse>({
				column: names,
				expr: { descend: 'select a as b with inverse (a = sentinel() - 1) from t' },
			}),
			ViewInsertDefault: ledger<AST.ViewInsertDefault>({
				column: names,
				expr: { descend: 'select a from t with defaults (b = 1 + sentinel())' },
			}),
			WithClause: ledger<AST.WithClause>({
				recursive: flag,
				ctes: { descend: 'with c as (select 1), d as (select sentinel()) select 1' },
				options: { noExpression: 'numeric recursion limit' },
			}),
			CommonTableExpr: ledger<AST.CommonTableExpr>({
				name: names,
				columns: names,
				query: { descend: 'with c(x) as materialized (select sentinel()) select 1' },
				materializationHint: keyword,
			}),
			OrderByClause: ledger<AST.OrderByClause>({
				expr: { descend: 'select 1 from t order by sentinel() desc nulls last' },
				direction: keyword,
				nulls: keyword,
			}),
			InsertStmt: ledger<AST.InsertStmt>({
				withClause: { descend: 'with c as (select sentinel()) insert into t select * from c' },
				table: targetName,
				columns: names,
				source: { descend: 'insert into t values (sentinel())' },
				onConflict: keyword,
				upsertClauses: { descend: 'insert into t values (1) on conflict do update set a = sentinel()' },
				returning: { descend: 'insert into t values (1) returning sentinel()' },
				contextValues: { descend: 'insert into t with context x = sentinel() values (1)' },
				schemaPath: names,
				tags,
				skipRowChecks: { noExpression: 'engine-only flag' },
			}),
			UpsertClause: ledger<AST.UpsertClause>({
				conflictTarget: names,
				action: keyword,
				assignments: { descend: 'insert into t values (1) on conflict (a) do update set b = sentinel()' },
				where: { descend: 'insert into t values (1) on conflict do update set a = 1 where sentinel()' },
			}),
			'UpsertClause.assignments[]': ledger<NonNullable<AST.UpsertClause['assignments']>[number]>({
				column: names,
				value: { descend: 'insert into t values (1) on conflict do update set a = 1, b = sentinel()' },
			}),
			ContextAssignment: ledger<AST.ContextAssignment>({
				name: names,
				value: { descend: 'insert into t with context x = 1, y = sentinel() values (1)' },
			}),
			UpdateStmt: ledger<AST.UpdateStmt>({
				withClause: { descend: 'with c as (select sentinel()) update t set a = 1' },
				table: targetName,
				targetSource: { descend: 'update (select sentinel() as a from t) as v set a = 1' },
				alias: names,
				assignments: { descend: 'update t set a = sentinel()' },
				where: { descend: 'update t set a = 1 where sentinel()' },
				returning: { descend: 'update t set a = 1 returning sentinel()' },
				contextValues: { descend: 'update t with context x = sentinel() set a = 1' },
				schemaPath: names,
				tags,
			}),
			'UpdateStmt.assignments[]': ledger<AST.UpdateStmt['assignments'][number]>({
				column: names,
				value: { descend: 'update t set a = 1, b = sentinel()' },
			}),
			DeleteStmt: ledger<AST.DeleteStmt>({
				withClause: { descend: 'with c as (select sentinel()) delete from t' },
				table: targetName,
				targetSource: { descend: 'delete from (select sentinel() as a from t) as v' },
				alias: names,
				where: { descend: 'delete from t where sentinel()' },
				returning: { descend: 'delete from t returning sentinel()' },
				contextValues: { descend: 'delete from t with context x = sentinel()' },
				schemaPath: names,
				tags,
			}),
			ValuesStmt: ledger<AST.ValuesStmt>({
				values: { descend: 'values (1), (sentinel())' },
			}),
			TableSource: ledger<AST.TableSource>({
				table: targetName,
				alias: names,
			}),
			JoinClause: ledger<AST.JoinClause>({
				joinType: keyword,
				left: { descend: 'select 1 from (select sentinel()) l join t on 1' },
				right: { descend: 'select 1 from t join (select sentinel()) r on 1' },
				condition: { descend: 'select 1 from t join u on sentinel()' },
				columns: names,
				isLateral: flag,
				existence: names,
			}),
			FunctionSource: ledger<AST.FunctionSource>({
				name: targetName,
				args: { descend: 'select * from f(sentinel())' },
				alias: names,
				columns: names,
			}),
			SubquerySource: ledger<AST.SubquerySource>({
				subquery: { descend: 'select * from (select sentinel()) s(x)' },
				alias: names,
				columns: names,
			}),
			WindowFunctionExpr: ledger<AST.WindowFunctionExpr>({
				function: { descend: 'select sum(sentinel()) over () from t' },
				window: { descend: 'select sum(a) over (partition by sentinel()) from t' },
				alias: names,
			}),
			WindowDefinition: ledger<AST.WindowDefinition>({
				partitionBy: { descend: 'select sum(a) over (partition by b, sentinel()) from t' },
				orderBy: { descend: 'select sum(a) over (order by sentinel()) from t' },
				frame: { descend: 'select sum(a) over (order by a rows sentinel() preceding) from t' },
			}),
			WindowFrame: ledger<AST.WindowFrame>({
				start: { descend: 'select sum(a) over (order by a rows between sentinel() preceding and current row) from t' },
				end: { descend: 'select sum(a) over (order by a rows between current row and sentinel() following) from t' },
				exclusion: keyword,
			}),
			// A bound is a union discriminated on `type`, so its ledger is per kind.
			WindowFrameBound: {
				currentRow: keyword,
				unboundedPreceding: keyword,
				unboundedFollowing: keyword,
				preceding: { descend: 'select sum(a) over (order by a rows between unbounded preceding and sentinel() preceding) from t' },
				following: { descend: 'select sum(a) over (order by a rows between sentinel() following and unbounded following) from t' },
			} satisfies Record<AST.WindowFrameBound['type'], Treatment>,
			FunctionExpr: ledger<AST.FunctionExpr>({
				name: names,
				args: { descend: 'select coalesce(1, sentinel())' },
				distinct: flag,
			}),
			SubqueryExpr: ledger<AST.SubqueryExpr>({
				query: { descend: 'select (select sentinel())' },
			}),
			BinaryExpr: ledger<AST.BinaryExpr>({
				operator: keyword,
				left: { descend: 'select sentinel() + 1' },
				right: { descend: 'select 1 + sentinel()' },
			}),
			UnaryExpr: ledger<AST.UnaryExpr>({
				operator: keyword,
				expr: { descend: 'select -sentinel()' },
			}),
			CastExpr: ledger<AST.CastExpr>({
				expr: { descend: 'select cast(sentinel() as text)' },
				targetType: { noExpression: 'type name' },
			}),
			CollateExpr: ledger<AST.CollateExpr>({
				expr: { descend: 'select sentinel() collate nocase' },
				collation: names,
			}),
			CaseExpr: ledger<AST.CaseExpr>({
				baseExpr: { descend: 'select case sentinel() when 1 then 2 end' },
				whenThenClauses: { descend: 'select case when 1 then 2 when sentinel() then 3 end' },
				elseExpr: { descend: 'select case when 1 then 2 else sentinel() end' },
			}),
			CaseExprWhenThenClause: ledger<AST.CaseExprWhenThenClause>({
				when: { descend: 'select case 1 when sentinel() then 2 end' },
				then: { descend: 'select case when 1 then sentinel() end' },
			}),
			InExpr: ledger<AST.InExpr>({
				expr: { descend: 'select sentinel() in (1)' },
				values: { descend: 'select 1 in (2, sentinel())' },
				subquery: { descend: 'select 1 in (select sentinel())' },
			}),
			ExistsExpr: ledger<AST.ExistsExpr>({
				subquery: { descend: 'select exists (select sentinel())' },
			}),
			BetweenExpr: ledger<AST.BetweenExpr>({
				expr: { descend: 'select sentinel() between 1 and 2' },
				lower: { descend: 'select 1 between sentinel() and 2' },
				upper: { descend: 'select 1 between 0 and sentinel()' },
				not: flag,
			}),
			LiteralExpr: ledger<AST.LiteralExpr>({
				value: { noExpression: 'the literal value itself' },
				lexeme: { noExpression: 'source text of the literal' },
			}),
			IdentifierExpr: ledger<AST.IdentifierExpr>({
				name: names,
				schema: names,
			}),
			ColumnExpr: ledger<AST.ColumnExpr>({
				name: names,
				table: names,
				schema: names,
				alias: names,
			}),
			ParameterExpr: ledger<AST.ParameterExpr>({
				index: { noExpression: 'parameter position' },
				name: names,
			}),
		};

		function parseSelect(sql: string): AST.SelectStmt {
			const stmt = parse(sql);
			if (stmt.type !== 'select') throw new Error(`expected a select: ${sql}`);
			return stmt;
		}

		function reachesSentinel(sample: string | (() => AST.AstNode)): boolean {
			let reached = false;
			traverseAst(typeof sample === 'string' ? parse(sample) : sample(), {
				enterNode(node: AstNode) {
					if (node.type === 'function' && (node as AST.FunctionExpr).name.toLowerCase() === 'sentinel') reached = true;
				},
			});
			return reached;
		}

		it('reaches a sentinel placed in every field marked descend', () => {
			const unreached: string[] = [];
			for (const [owner, fields] of Object.entries(LEDGERS)) {
				for (const [field, treatment] of Object.entries(fields)) {
					if (!('descend' in treatment)) continue;
					try {
						if (!reachesSentinel(treatment.descend)) unreached.push(`${owner}.${field}`);
					} catch (e) {
						unreached.push(`${owner}.${field} — sample failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}
			}
			expect(unreached).to.deep.equal([]);
		});
	});

	describe('handles undefined/null nodes gracefully', () => {
		it('does nothing for undefined node', () => {
			const types: string[] = [];
			traverseAst(undefined, {
				enterNode(node: AstNode) {
					types.push(node.type);
				},
			});
			expect(types).to.be.empty;
		});
	});
});
