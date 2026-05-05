import { expect } from 'chai';
import { Database } from '../src/index.js';
import { emitCreateAssertion } from '../src/runtime/emit/create-assertion.js';
import type { EmissionContext } from '../src/runtime/emission-context.js';
import type { RuntimeContext } from '../src/runtime/types.js';
import type { CreateAssertionNode } from '../src/planner/nodes/create-assertion-node.js';
import type * as AST from '../src/parser/ast.js';
import { QuereusError } from '../src/common/errors.js';

describe('Emit: CREATE ASSERTION error handling', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should throw QuereusError when expression cannot be stringified', async () => {
		// A binary expression with null children causes expressionToString to throw
		// when it tries to recurse into expr.left / expr.right
		const poisonExpr = {
			type: 'binary',
			operator: '=',
			left: null,
			right: null,
		} as unknown as AST.Expression;

		const fakePlan = {
			name: 'bad_assertion',
			checkExpression: poisonExpr,
		} as unknown as CreateAssertionNode;

		const instruction = emitCreateAssertion(fakePlan, {} as EmissionContext);

		const rctx = {
			db,
			stmt: undefined,
			params: {},
			context: new Map(),
			tableContexts: new Map(),
			enableMetrics: false,
		} as unknown as RuntimeContext;

		let caught: unknown;
		try {
			await instruction.run(rctx);
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).message).to.include('Cannot create assertion');
		expect((caught as QuereusError).message).to.include('bad_assertion');
		expect((caught as QuereusError).message).to.include('failed to convert check expression to SQL');
	});
});
