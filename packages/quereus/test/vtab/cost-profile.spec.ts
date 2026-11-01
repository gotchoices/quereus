/**
 * `resolveModuleCostProfile` is the one rule for reading a module's declared cost
 * profile: an omitted field is 0, `0` is a valid latency, and a negative or
 * non-finite field reads as 0 with a warning — so no `NaN` ever reaches a cost sum.
 */

import { expect } from 'chai';
import { resolveModuleCostProfile, type ModuleCostProfile } from '../../src/vtab/cost-profile.js';

describe('resolveModuleCostProfile', () => {
	function resolveCollecting(declared: ModuleCostProfile | undefined) {
		const warnings: string[] = [];
		const resolved = resolveModuleCostProfile(declared, message => warnings.push(message));
		return { resolved, warnings };
	}

	for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		it(`replaces ${bad} with 0 and warns once naming the field`, () => {
			const first = resolveCollecting({ firstRowLatencyMs: bad, perRowLatencyMs: 2 });
			expect(first.resolved).to.deep.equal({ firstRowLatencyMs: 0, perRowLatencyMs: 2 });
			expect(first.warnings).to.have.length(1);
			expect(first.warnings[0]).to.contain('firstRowLatencyMs');

			const perRow = resolveCollecting({ firstRowLatencyMs: 3, perRowLatencyMs: bad });
			expect(perRow.resolved).to.deep.equal({ firstRowLatencyMs: 3, perRowLatencyMs: 0 });
			expect(perRow.warnings).to.have.length(1);
			expect(perRow.warnings[0]).to.contain('perRowLatencyMs');
		});
	}

	it('accepts 0 silently', () => {
		const { resolved, warnings } = resolveCollecting({ firstRowLatencyMs: 0, perRowLatencyMs: 0 });
		expect(resolved).to.deep.equal({ firstRowLatencyMs: 0, perRowLatencyMs: 0 });
		expect(warnings).to.be.empty;
	});

	it('resolves an undeclared profile to zeros without warning', () => {
		const { resolved, warnings } = resolveCollecting(undefined);
		expect(resolved).to.deep.equal({ firstRowLatencyMs: 0, perRowLatencyMs: 0 });
		expect(warnings).to.be.empty;
	});
});
