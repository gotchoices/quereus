/**
 * Tests for characteristics-based plan node analysis
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
	PlanNodeCharacteristics,
	CapabilityDetectors,
	CachingAnalysis,
	CapabilityRegistry
} from '../../src/planner/framework/characteristics.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';

describe('PlanNodeCharacteristics', () => {
	describe('Physical Properties', () => {
		it('should provide utility methods for physical property analysis', () => {
			// Mock node with physical properties
			const mockNode = {
				physical: {
					readonly: true,
					deterministic: true,
					idempotent: true,
					constant: false,
					estimatedRows: 1000
				}
			} as PlanNode;

			expect(PlanNodeCharacteristics.hasSideEffects(mockNode)).to.be.false;
			expect(PlanNodeCharacteristics.isReadOnly(mockNode)).to.be.true;
			expect(PlanNodeCharacteristics.isDeterministic(mockNode)).to.be.true;
			expect(PlanNodeCharacteristics.estimatesRows(mockNode)).to.equal(1000);
		});

		it('should detect expensive operations based on row estimates', () => {
			const expensiveNode = {
				physical: { estimatedRows: 50000 }
			} as PlanNode;

			const cheapNode = {
				physical: { estimatedRows: 100 }
			} as PlanNode;

			expect(PlanNodeCharacteristics.isExpensive(expensiveNode)).to.be.true;
			expect(PlanNodeCharacteristics.isExpensive(cheapNode)).to.be.false;
		});
	});
});

describe('CapabilityDetectors', () => {
	it('should detect capabilities using duck typing', () => {
		// Mock node with predicate capability
		const predicateNode = {
			getPredicate: () => null,
			withPredicate: (_pred: any) => predicateNode
		} as any;

		const regularNode = {} as PlanNode;

		expect(CapabilityDetectors.canPushDownPredicate(predicateNode)).to.be.true;
		expect(CapabilityDetectors.canPushDownPredicate(regularNode)).to.be.false;
	});
});

describe('CachingAnalysis', () => {
	it('should calculate appropriate cache thresholds', () => {
		const node = {
			physical: { estimatedRows: 5000 }
		} as PlanNode;

		const threshold = CachingAnalysis.getCacheThreshold(node);
		expect(threshold).to.be.a('number');
		expect(threshold).to.be.greaterThan(0);
	});
});

describe('CapabilityRegistry', () => {
	afterEach(() => {
		// Clean up test registrations
		CapabilityRegistry.unregister('test-capability');
	});

	it('should register and detect custom capabilities', () => {
		// Define a custom capability
		const isTestNode = (node: PlanNode): boolean => {
			return 'testProperty' in node;
		};

		// Register the capability
		CapabilityRegistry.register('test-capability', isTestNode);

		// Test detection
		const regularNode = {} as PlanNode;
		const testNode = { testProperty: true } as any;

		expect(CapabilityRegistry.hasCapability(regularNode, 'test-capability')).to.be.false;
		expect(CapabilityRegistry.hasCapability(testNode, 'test-capability')).to.be.true;
	});

	it('should list all registered capabilities', () => {
		const capabilities = CapabilityRegistry.getAllCapabilities();

		expect(capabilities).to.be.an('array');
		expect(capabilities).to.include('predicate-pushdown');
		expect(capabilities).to.include('table-access');
		expect(capabilities).to.include('aggregation');
	});
});

describe('Characteristics-Based Benefits', () => {
	it('should enable type-safe capability detection', () => {
		// Mock aggregation-capable node
		const aggregateNode = {
			getType: () => ({ typeClass: 'relation' }),
			getGroupingKeys: () => [],
			getAggregateExpressions: () => []
		} as any;

		const regularNode = {
			getType: () => ({ typeClass: 'scalar' })
		} as any;

		expect(CapabilityDetectors.isAggregating(aggregateNode)).to.be.true;
		expect(CapabilityDetectors.isAggregating(regularNode)).to.be.false;
	});

	it('should work with any node implementing the interface', () => {
		// Custom node implementing aggregation interface
		class CustomAggregateNode {
			getType() {
				return { typeClass: 'relation' as const };
			}

			getGroupingKeys() {
				return [];
			}

			getAggregateExpressions() {
				return [];
			}
		}

		const customNode = new CustomAggregateNode();

		// The characteristics system should detect this as aggregation-capable
		// even though it's not a standard AggregateNode
		expect(CapabilityDetectors.isAggregating(customNode as any)).to.be.true;
	});
});
