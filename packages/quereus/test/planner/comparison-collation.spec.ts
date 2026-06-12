/**
 * Unit net for the provenance-ranked comparison-collation lattice (ticket
 * `comparison-collation-provenance-and-precedence`). Pins the
 * rank/conflict table of `resolveComparisonCollation`, the RHS-merge rules of
 * `resolveInCollation`, the non-comparison propagation merge, and the
 * throwing `effective*` wrappers' error shapes. End-to-end behavior lives in
 * test/logic/06.4.4-comparison-collation-precedence.sqllogic.
 */
import { expect } from 'chai';
import {
	collationContribution,
	resolveComparisonCollation,
	resolveInCollation,
	mergePropagatedCollation,
	effectiveComparisonCollation,
	isComparisonOperator,
	type CollationSource,
	type CollationResolution,
} from '../../src/planner/analysis/comparison-collation.js';
import type { ScalarType } from '../../src/common/datatype.js';
import { TEXT_TYPE } from '../../src/types/builtin-types.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { QuereusError } from '../../src/common/errors.js';
import type * as AST from '../../src/parser/ast.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;

function t(collationName?: string, collationSource?: CollationSource): ScalarType {
	return {
		typeClass: 'scalar',
		logicalType: TEXT_TYPE,
		collationName,
		collationSource,
		nullable: false,
		isReadOnly: false,
	};
}

function colNode(type: ScalarType, attrId = 1): ColumnReferenceNode {
	const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` } as AST.ColumnExpr;
	return new ColumnReferenceNode(scope, expr, type, attrId, 0);
}

function expectResolved(res: CollationResolution, name: string): void {
	expect(res).to.deep.equal({ kind: 'resolved', name });
}

describe('comparison-collation provenance lattice', () => {
	describe('collationContribution', () => {
		it('no collationName → no contribution', () => {
			expect(collationContribution(t())).to.equal(undefined);
		});

		it('defaulted BINARY → no contribution (the engine floor is not a preference)', () => {
			expect(collationContribution(t('BINARY', 'default'))).to.equal(undefined);
		});

		it('absent source with a present name is treated as default (safe floor)', () => {
			expect(collationContribution(t('NOCASE'))).to.deep.equal({ name: 'NOCASE', rank: 1 });
			expect(collationContribution(t('BINARY'))).to.equal(undefined);
		});

		it('ranks: explicit 3, declared 2, default 1; names normalize', () => {
			expect(collationContribution(t('nocase', 'explicit'))).to.deep.equal({ name: 'NOCASE', rank: 3 });
			expect(collationContribution(t('BINARY', 'declared'))).to.deep.equal({ name: 'BINARY', rank: 2 });
			expect(collationContribution(t('RTRIM', 'default'))).to.deep.equal({ name: 'RTRIM', rank: 1 });
		});
	});

	describe('resolveComparisonCollation rank/conflict table', () => {
		it('no contributions → BINARY', () => {
			expectResolved(resolveComparisonCollation(t(), t()), 'BINARY');
			expectResolved(resolveComparisonCollation(t('BINARY', 'default'), t()), 'BINARY');
		});

		it('headline: declared NOCASE vs defaulted BINARY → NOCASE, both spellings', () => {
			expectResolved(resolveComparisonCollation(t('NOCASE', 'declared'), t('BINARY', 'default')), 'NOCASE');
			expectResolved(resolveComparisonCollation(t('BINARY', 'default'), t('NOCASE', 'declared')), 'NOCASE');
		});

		it('higher rank wins: explicit > declared > default', () => {
			expectResolved(resolveComparisonCollation(t('BINARY', 'explicit'), t('NOCASE', 'declared')), 'BINARY');
			expectResolved(resolveComparisonCollation(t('BINARY', 'declared'), t('NOCASE', 'default')), 'BINARY');
			expectResolved(resolveComparisonCollation(t('NOCASE', 'explicit'), t('RTRIM', 'default')), 'NOCASE');
		});

		it('same rank, same name → that name', () => {
			expectResolved(resolveComparisonCollation(t('NOCASE', 'declared'), t('NOCASE', 'declared')), 'NOCASE');
			expectResolved(resolveComparisonCollation(t('NOCASE', 'explicit'), t('nocase', 'explicit')), 'NOCASE');
			expectResolved(resolveComparisonCollation(t('NOCASE', 'default'), t('NOCASE', 'default')), 'NOCASE');
		});

		it('rank-1 conflict resolves to BINARY silently (defaults are preferences)', () => {
			expectResolved(resolveComparisonCollation(t('NOCASE', 'default'), t('RTRIM', 'default')), 'BINARY');
		});

		it('rank-2 conflict, including declared BINARY (a real rank-2 preference)', () => {
			expect(resolveComparisonCollation(t('NOCASE', 'declared'), t('RTRIM', 'declared')))
				.to.deep.equal({ kind: 'conflict', level: 'declared', left: 'NOCASE', right: 'RTRIM' });
			expect(resolveComparisonCollation(t('BINARY', 'declared'), t('NOCASE', 'declared')).kind).to.equal('conflict');
		});

		it('rank-3 conflict', () => {
			expect(resolveComparisonCollation(t('NOCASE', 'explicit'), t('RTRIM', 'explicit')))
				.to.deep.equal({ kind: 'conflict', level: 'explicit', left: 'NOCASE', right: 'RTRIM' });
		});

		it('symmetry: kind and resolved name agree for flipped operands across the matrix', () => {
			const cells = [
				t(), t('BINARY', 'default'), t('NOCASE', 'default'), t('RTRIM', 'default'),
				t('BINARY', 'declared'), t('NOCASE', 'declared'), t('RTRIM', 'declared'),
				t('BINARY', 'explicit'), t('NOCASE', 'explicit'), t('RTRIM', 'explicit'),
				t('NOCASE'),
			];
			for (const a of cells) {
				for (const b of cells) {
					const ab = resolveComparisonCollation(a, b);
					const ba = resolveComparisonCollation(b, a);
					expect(ba.kind, `kind asymmetry for ${a.collationName}/${a.collationSource} vs ${b.collationName}/${b.collationSource}`).to.equal(ab.kind);
					if (ab.kind === 'resolved' && ba.kind === 'resolved') {
						expect(ba.name).to.equal(ab.name);
					}
				}
			}
		});
	});

	describe('resolveInCollation (condition vs merged RHS)', () => {
		it('literal-only list contributes nothing → condition drives', () => {
			expectResolved(resolveInCollation(t('NOCASE', 'declared'), [t(), t()]), 'NOCASE');
			expectResolved(resolveInCollation(t(), [t(), t()]), 'BINARY');
		});

		it('a declared-NOCASE element drives a plain condition', () => {
			expectResolved(resolveInCollation(t(), [t('NOCASE', 'declared')]), 'NOCASE');
		});

		it('highest-ranked element wins the RHS merge without conflict', () => {
			expectResolved(resolveInCollation(t(), [t('NOCASE', 'explicit'), t('RTRIM', 'declared')]), 'NOCASE');
		});

		it('rank-3/2 name conflicts among elements are conflicts', () => {
			expect(resolveInCollation(t(), [t('NOCASE', 'explicit'), t('RTRIM', 'explicit')]))
				.to.deep.equal({ kind: 'conflict', level: 'explicit', left: 'NOCASE', right: 'RTRIM' });
			expect(resolveInCollation(t(), [t('NOCASE', 'declared'), t('RTRIM', 'declared')]).kind).to.equal('conflict');
		});

		it('rank-1 conflicts among elements merge to no contribution → condition drives', () => {
			expectResolved(resolveInCollation(t('RTRIM', 'default'), [t('NOCASE', 'default'), t('RTRIM', 'default')]), 'RTRIM');
		});

		it('condition vs merged RHS resolves through the same lattice (conflict included)', () => {
			expect(resolveInCollation(t('NOCASE', 'declared'), [t('RTRIM', 'declared')]).kind).to.equal('conflict');
			expectResolved(resolveInCollation(t('NOCASE', 'declared'), [t('BINARY', 'explicit')]), 'BINARY');
		});
	});

	describe('mergePropagatedCollation (concat / CASE)', () => {
		it('higher rank wins and carries its source', () => {
			expect(mergePropagatedCollation([t('BINARY', 'default'), t('NOCASE', 'declared')]))
				.to.deep.equal({ collationName: 'NOCASE', collationSource: 'declared' });
			expect(mergePropagatedCollation([t('NOCASE', 'explicit'), t('RTRIM', 'declared')]))
				.to.deep.equal({ collationName: 'NOCASE', collationSource: 'explicit' });
		});

		it('equal-rank disagreement propagates NO collation (no coin-flip), at every rank', () => {
			expect(mergePropagatedCollation([t('NOCASE', 'declared'), t('RTRIM', 'declared')])).to.deep.equal({});
			expect(mergePropagatedCollation([t('NOCASE', 'explicit'), t('RTRIM', 'explicit')])).to.deep.equal({});
			expect(mergePropagatedCollation([t('NOCASE', 'default'), t('RTRIM', 'default')])).to.deep.equal({});
		});

		it('order-independent: a later same-rank duplicate cannot resurrect a conflicted name', () => {
			const branches = [t('NOCASE', 'declared'), t('RTRIM', 'declared'), t('NOCASE', 'declared')];
			expect(mergePropagatedCollation(branches)).to.deep.equal({});
			expect(mergePropagatedCollation([...branches].reverse())).to.deep.equal({});
		});

		it('no contributions → no collation', () => {
			expect(mergePropagatedCollation([])).to.deep.equal({});
			expect(mergePropagatedCollation([t(), t('BINARY', 'default')])).to.deep.equal({});
		});
	});

	describe('throwing wrappers', () => {
		it('effectiveComparisonCollation throws QuereusError with the declared-conflict message', () => {
			const left = colNode(t('NOCASE', 'declared'), 1);
			const right = colNode(t('RTRIM', 'declared'), 2);
			expect(() => effectiveComparisonCollation(left, right))
				.to.throw(QuereusError, /ambiguous collation .* NOCASE vs RTRIM .* explicit COLLATE/);
		});

		it('explicit conflicts use the conflicting-COLLATE-clauses message', () => {
			const left = colNode(t('NOCASE', 'explicit'), 1);
			const right = colNode(t('RTRIM', 'explicit'), 2);
			expect(() => effectiveComparisonCollation(left, right))
				.to.throw(QuereusError, /conflicting COLLATE clauses .* NOCASE vs RTRIM/);
		});

		it('resolved cases return the normalized name', () => {
			expect(effectiveComparisonCollation(colNode(t('nocase', 'declared'), 1), colNode(t(), 2))).to.equal('NOCASE');
		});
	});

	describe('isComparisonOperator', () => {
		it('covers the comparison class (incl. IS forms) and excludes combiners', () => {
			for (const op of ['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'IS', 'IS NOT', 'is not']) {
				expect(isComparisonOperator(op), op).to.equal(true);
			}
			for (const op of ['||', 'AND', 'OR', '+', 'LIKE', 'IN']) {
				expect(isComparisonOperator(op), op).to.equal(false);
			}
		});
	});
});
