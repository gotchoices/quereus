import { expect } from 'chai';
import { astToString } from '../src/emit/ast-stringify.js';
import type {
	AlterTableStmt,
	AnalyzeStmt,
	CreateAssertionStmt,
	MutatingSubquerySource,
	IdentifierExpr,
	ColumnDef,
	TableConstraint,
	DeleteStmt,
	FromClause,
} from '../src/parser/ast.js';

// Helper to build an IdentifierExpr
function ident(name: string, schema?: string): IdentifierExpr {
	return { type: 'identifier', name, ...(schema ? { schema } : {}) };
}

describe('Emit: missing statement types', () => {

	describe('alterTable', () => {
		it('should stringify renameTable action', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'renameTable', newName: 'accounts' },
			};
			const result = astToString(node);
			// Currently falls through to default — should NOT be a placeholder
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('alter table');
			expect(result).to.include('rename to');
		});

		it('should stringify renameColumn action', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'renameColumn', oldName: 'name', newName: 'full_name' },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('rename column');
		});

		it('should stringify addColumn action', () => {
			const col: ColumnDef = {
				name: 'email',
				dataType: 'text',
				constraints: [],
			};
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'addColumn', column: col },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('add column');
		});

		it('should stringify dropColumn action', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'dropColumn', name: 'legacy_field' },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('drop column');
		});

		it('should stringify addConstraint action', () => {
			const constraint: TableConstraint = {
				type: 'unique',
				columns: [{ name: 'email' }],
			};
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'addConstraint', constraint },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('add');
		});

		it('should stringify schema-qualified table', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users', 'myschema'),
				action: { type: 'renameTable', newName: 'accounts' },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('myschema');
		});
	});

	describe('analyze', () => {
		it('should stringify bare analyze', () => {
			const node: AnalyzeStmt = { type: 'analyze' };
			const result = astToString(node);
			expect(result).to.not.equal('[analyze]');
			expect(result).to.equal('analyze');
		});

		it('should stringify analyze with table', () => {
			const node: AnalyzeStmt = { type: 'analyze', tableName: 'users' };
			const result = astToString(node);
			expect(result).to.not.equal('[analyze]');
			expect(result).to.include('users');
		});

		it('should stringify analyze with schema.table', () => {
			const node: AnalyzeStmt = { type: 'analyze', schemaName: 'main', tableName: 'users' };
			const result = astToString(node);
			expect(result).to.not.equal('[analyze]');
			expect(result).to.include('main');
			expect(result).to.include('users');
		});
	});

	describe('createAssertion', () => {
		it('should stringify create assertion', () => {
			const node: CreateAssertionStmt = {
				type: 'createAssertion',
				name: 'positive_balance',
				check: {
					type: 'binary',
					operator: '>',
					left: { type: 'column', name: 'balance' },
					right: { type: 'literal', value: 0 },
				},
			};
			const result = astToString(node);
			expect(result).to.not.equal('[createAssertion]');
			expect(result).to.include('create assertion');
			expect(result).to.include('positive_balance');
			expect(result).to.include('check');
		});
	});

	describe('mutatingSubquerySource in fromClauseToString', () => {
		it('should stringify mutating subquery source via select', () => {
			// Build a SELECT that uses a mutating subquery in FROM
			const deleteStmt: DeleteStmt = {
				type: 'delete',
				table: ident('old_logs'),
				returning: [{ type: 'all' }],
			};
			const mutSource: MutatingSubquerySource = {
				type: 'mutatingSubquerySource',
				stmt: deleteStmt,
				alias: 'deleted',
			};
			// We can't call fromClauseToString directly (not exported),
			// so build a select that uses it as a FROM source
			const selectNode = {
				type: 'select' as const,
				columns: [{ type: 'all' as const }],
				from: [mutSource as unknown as FromClause],
			};
			const result = astToString(selectNode);
			// Currently the from clause falls through to [unknown_from]
			expect(result).to.not.include('[unknown_from]');
			expect(result).to.include('deleted');
		});
	});
});
