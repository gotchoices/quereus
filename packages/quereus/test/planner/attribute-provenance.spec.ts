import { expect } from 'chai';
import { PlanNode, type Attribute, type RelationalPlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { RelationType, ScalarType } from '../../src/common/datatype.js';
import type { Scope } from '../../src/planner/scopes/scope.js';
import { QuereusError } from '../../src/common/errors.js';
import { computeAttributeProvenance } from '../../src/planner/analysis/attribute-provenance.js';

const mockScope = { resolveSymbol: () => undefined } as unknown as Scope;

const INT_TYPE: ScalarType = {
	typeClass: 'scalar',
	logicalType: { name: 'INTEGER', affinity: 'integer', isNumeric: true } as never,
	nullable: false,
	isReadOnly: false,
};

let attrCounter = 500000;
function makeAttr(id?: number, name = 'c'): Attribute {
	return { id: id ?? attrCounter++, name, type: INT_TYPE, sourceRelation: 'test.t', relationName: 't' };
}

/** Leaf relational mock that originates the given attributes. */
class LeafRel extends PlanNode implements RelationalPlanNode {
	override readonly nodeType: PlanNodeType = PlanNodeType.SeqScan;
	constructor(private readonly _attrs: readonly Attribute[]) { super(mockScope, 0.01); }
	getType(): RelationType {
		return {
			typeClass: 'relation',
			columns: this._attrs.map(a => ({ name: a.name, type: a.type })),
			keys: [], rowConstraints: [], isSet: false, isReadOnly: true,
		} as RelationType;
	}
	getChildren(): readonly PlanNode[] { return []; }
	getRelations(): readonly RelationalPlanNode[] { return []; }
	getAttributes(): readonly Attribute[] { return this._attrs; }
	withChildren(): PlanNode { return this; }
}

/**
 * Relational mock that publishes an explicit attribute list while carrying a
 * single relational source — used to model forwarding (attrs ⊆ source attrs)
 * and mixed forward+mint projections.
 */
class PassThroughRel extends PlanNode implements RelationalPlanNode {
	override readonly nodeType: PlanNodeType;
	constructor(
		public readonly source: RelationalPlanNode,
		private readonly _attrs: readonly Attribute[],
		nodeType: PlanNodeType = PlanNodeType.Project,
	) { super(mockScope, 0.01); this.nodeType = nodeType; }
	getType(): RelationType { return this.source.getType(); }
	getChildren(): readonly PlanNode[] { return [this.source]; }
	getRelations(): readonly RelationalPlanNode[] { return [this.source]; }
	getAttributes(): readonly Attribute[] { return this._attrs; }
	withChildren(nc: readonly PlanNode[]): PlanNode {
		return new PassThroughRel(nc[0] as RelationalPlanNode, this._attrs, this.nodeType);
	}
}

describe('computeAttributeProvenance', () => {
	it('maps each id to its originating leaf', () => {
		const a = makeAttr(1), b = makeAttr(2);
		const leaf = new LeafRel([a, b]);
		const prov = computeAttributeProvenance(leaf);
		expect(prov.get(1)?.originNode).to.equal(leaf);
		expect(prov.get(2)?.originNode).to.equal(leaf);
		expect(prov.size).to.equal(2);
	});

	it('attributes a forwarded id to the origin, not the forwarding parent', () => {
		const a = makeAttr(1), b = makeAttr(2);
		const leaf = new LeafRel([a, b]);
		// Parent re-publishes both ids verbatim (forwarding).
		const fwd = new PassThroughRel(leaf, [a, b], PlanNodeType.EagerPrefetch);
		const prov = computeAttributeProvenance(fwd);
		expect(prov.get(1)?.originNode).to.equal(leaf);
		expect(prov.get(2)?.originNode).to.equal(leaf);
		// The forwarding parent originates nothing.
		expect([...prov.values()].some(e => e.originNode === fwd)).to.equal(false);
	});

	it('handles a mixed projection (forwarded col-ref + minted computed col)', () => {
		const a = makeAttr(1), b = makeAttr(2);
		const leaf = new LeafRel([a, b]);
		const computed = makeAttr(99);
		// Project forwards `a` and mints a fresh id 99.
		const project = new PassThroughRel(leaf, [a, computed]);
		const prov = computeAttributeProvenance(project);
		expect(prov.get(1)?.originNode).to.equal(leaf);   // forwarded
		expect(prov.get(99)?.originNode).to.equal(project); // minted here
		// `b` is dropped by the projection but still originates at the leaf and
		// remains in scope (membership = "exists anywhere in the tree").
		expect(prov.get(2)?.originNode).to.equal(leaf);
	});

	it('throws when two distinct nodes originate the same id', () => {
		// Two sibling leaves each mint id 10; a forwarding parent re-publishes it.
		// The collision is between the leaves (distinct origin nodes).
		const left = new LeafRel([makeAttr(10)]);
		const right = new LeafRel([makeAttr(10)]);
		const collider = new (class extends PlanNode implements RelationalPlanNode {
			override readonly nodeType = PlanNodeType.SetOperation;
			getType(): RelationType { return left.getType(); }
			getChildren(): readonly PlanNode[] { return [left, right]; }
			getRelations(): readonly RelationalPlanNode[] { return [left, right]; }
			getAttributes(): readonly Attribute[] { return [makeAttr(10)]; }
			withChildren(): PlanNode { return this; }
		})(mockScope, 0.01);
		expect(() => computeAttributeProvenance(collider)).to.throw(QuereusError, /originated at two distinct nodes/);
	});

	it('throws when a single node lists the same id twice', () => {
		const leaf = new LeafRel([makeAttr(5), makeAttr(5)]);
		expect(() => computeAttributeProvenance(leaf)).to.throw(QuereusError, /Duplicate attribute ID 5/);
	});

	it('does not throw or hang on a shared child instance (DAG)', () => {
		const shared = new LeafRel([makeAttr(90)]);
		const parent = new (class extends PlanNode implements RelationalPlanNode {
			override readonly nodeType = PlanNodeType.Filter;
			getType(): RelationType { return shared.getType(); }
			getChildren(): readonly PlanNode[] { return [shared, shared]; }
			getRelations(): readonly RelationalPlanNode[] { return [shared, shared]; }
			getAttributes(): readonly Attribute[] { return [makeAttr(91)]; }
			withChildren(): PlanNode { return this; }
		})(mockScope, 0.01);
		const prov = computeAttributeProvenance(parent);
		expect(prov.get(90)?.originNode).to.equal(shared);
	});
});

describe('PlanNode.getAttributeIndex', () => {
	it('returns correct attrId → index positions', () => {
		const leaf = new LeafRel([makeAttr(1), makeAttr(2), makeAttr(3)]);
		const idx = leaf.getAttributeIndex();
		expect([...idx]).to.deep.equal([[1, 0], [2, 1], [3, 2]]);
	});

	it('caches the map (same reference across calls)', () => {
		const leaf = new LeafRel([makeAttr(1), makeAttr(2)]);
		expect(leaf.getAttributeIndex()).to.equal(leaf.getAttributeIndex());
	});

	it('rebuilds on the new instance after withChildren', () => {
		const childA = new LeafRel([makeAttr(1), makeAttr(2)]);
		const childB = new LeafRel([makeAttr(3), makeAttr(4), makeAttr(5)]);
		const fwd = new PassThroughRel(childA, childA.getAttributes(), PlanNodeType.EagerPrefetch);
		expect([...fwd.getAttributeIndex()]).to.deep.equal([[1, 0], [2, 1]]);

		// withChildren mints a fresh instance; since attributes here mirror the
		// (new) source, the new instance's index reflects the new attribute list.
		const fwd2 = new PassThroughRel(childB, childB.getAttributes(), PlanNodeType.EagerPrefetch);
		expect([...fwd2.getAttributeIndex()]).to.deep.equal([[3, 0], [4, 1], [5, 2]]);
		// Original instance's cache is unaffected.
		expect([...fwd.getAttributeIndex()]).to.deep.equal([[1, 0], [2, 1]]);
	});
});
