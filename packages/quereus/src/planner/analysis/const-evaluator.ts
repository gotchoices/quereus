/**
 * Runtime-based expression evaluator for constant folding
 *
 * This module provides evaluation of constant expressions using the existing runtime
 * through a mini-scheduler, avoiding the need for a separate expression interpreter.
 */

import type { MaybePromise, OutputValue, Row } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Database } from '../../core/database.js';
import { emitPlanNode } from '../../runtime/emitters.js';
import { EmissionContext } from '../../runtime/emission-context.js';
import { Scheduler } from '../../runtime/scheduler.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../runtime/strict-fork.js';
import { isAsyncIterable } from '../../runtime/utils.js';
import { createLogger } from '../../common/logger.js';
import { PlanNode, type Attribute } from '../nodes/plan-node.js';
import { TableLiteralNode } from '../nodes/values-node.js';
import type { RelationType } from '../../common/datatype.js';

const log = createLogger('optimizer:folding:eval');

/**
 * Create an expression evaluator that uses the runtime to evaluate constant expressions
 */
export function createRuntimeExpressionEvaluator(db: Database): (expr: PlanNode) => MaybePromise<OutputValue> {
	return function evaluateExpression(expr: PlanNode): MaybePromise<OutputValue> {
		log('Evaluating constant expression: %s', expr.nodeType);

		try {
			// Create temporary emission context
			const emissionCtx = new EmissionContext(db);

			// Emit the expression to an instruction
			const instruction = emitPlanNode(expr, emissionCtx);

			// Create a scheduler to execute the instruction
			const scheduler = new Scheduler(instruction);

			// Create minimal runtime context for evaluation
			// No row context is needed since we only evaluate constant expressions
			const runtimeCtx: RuntimeContext = {
				db,
				stmt: undefined,
				params: {}, // No parameters needed for constants
				context: createStrictRowContextMap(), // No row context needed
				tableContexts: wrapTableContextsStrict(new Map()), // No table contexts needed for constants
				enableMetrics: false
			};

			// Execute and get the result
			const result = scheduler.run(runtimeCtx);

			// Ensure result is a valid OutputValue
			if (result === undefined) {
				throw new QuereusError('Expression evaluation returned undefined');
			}

			log('Expression evaluated to: %s', result);
			return result as MaybePromise<OutputValue>;

		} catch (error) {
			log('Failed to evaluate expression %s: %s', expr.nodeType, error);
			throw new QuereusError('Expression evaluation failed', StatusCode.ERROR, error instanceof Error ? error : undefined);
		}
	};
}

/**
 * A self-materializing async iterable that caches rows on first iteration.
 * First iteration runs the source, collects all rows, and caches them.
 * Subsequent iterations yield from the cached array.
 */
class MaterializingAsyncIterable implements AsyncIterable<Row> {
	private cached: Row[] | null = null;
	private materializing: Promise<Row[]> | null = null;

	constructor(private readonly createSource: () => OutputValue) {}

	[Symbol.asyncIterator](): AsyncIterator<Row> {
		if (this.cached) {
			return arrayToAsyncIterator(this.cached);
		}
		return this.materializeAndYield();
	}

	private materializeAndYield(): AsyncIterator<Row> {
		// If already materializing from another iterator, wait for it
		if (!this.materializing) {
			this.materializing = this.doMaterialize();
		}

		const promise = this.materializing;
		let index = 0;

		return {
			next: async () => {
				const rows = await promise;
				if (index < rows.length) {
					return { value: rows[index++], done: false };
				}
				return { value: undefined as unknown as Row, done: true };
			}
		};
	}

	private async doMaterialize(): Promise<Row[]> {
		const rows: Row[] = [];
		let source = this.createSource();

		// Resolve if promise
		if (source instanceof Promise) {
			source = await source;
		}

		// Source should be an AsyncIterable<Row>
		if (isAsyncIterable<Row>(source)) {
			for await (const row of source) {
				rows.push(row);
			}
		} else {
			throw new QuereusError('Relational evaluation did not produce an async iterable');
		}

		this.cached = rows;
		return rows;
	}
}

function arrayToAsyncIterator(rows: Row[]): AsyncIterator<Row> {
	let index = 0;
	return {
		next: async () => {
			if (index < rows.length) {
				return { value: rows[index++], done: false };
			}
			return { value: undefined as unknown as Row, done: true };
		}
	};
}

/**
 * Create a relational evaluator that replaces constant relational subtrees
 * with TableLiteralNodes using deferred materialization.
 */
export function createRuntimeRelationalEvaluator(db: Database): (node: PlanNode) => PlanNode {
	return function evaluateRelation(node: PlanNode): PlanNode {
		log('Evaluating relational constant: %s', node.nodeType);

		try {
			// Emit the relational subtree to an instruction tree
			const emissionCtx = new EmissionContext(db);
			const instruction = emitPlanNode(node, emissionCtx);
			const scheduler = new Scheduler(instruction);

			// Create a self-materializing async iterable
			const iterable = new MaterializingAsyncIterable(() => {
				const runtimeCtx: RuntimeContext = {
					db,
					stmt: undefined,
					params: {},
					context: createStrictRowContextMap(),
					tableContexts: wrapTableContextsStrict(new Map()),
					enableMetrics: false
				};
				return scheduler.run(runtimeCtx);
			});

			// Preserve the original node's type and attributes
			const relType = node.getType() as RelationType;
			const relNode = node as PlanNode & { getAttributes(): readonly Attribute[]; estimatedRows?: number };
			const originalAttrs: Attribute[] = [...relNode.getAttributes()];

			const replacement = new TableLiteralNode(
				node.scope,
				iterable,
				relNode.estimatedRows,
				relType,
				originalAttrs
			);

			log('Replaced relational node %s with TableLiteralNode', node.id);
			return replacement;

		} catch (error) {
			log('Failed to evaluate relational node %s: %s', node.nodeType, error);
			throw new QuereusError('Relational evaluation failed', StatusCode.ERROR, error instanceof Error ? error : undefined);
		}
	};
}
