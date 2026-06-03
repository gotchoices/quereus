import { expect } from 'chai';
import {
	validateReservedTags,
	getReservedTag,
	getReservedTagByTemplate,
	RESERVED_TAGS,
	type TagSite,
} from '../../src/schema/reserved-tags.js';
import type { SqlValue } from '../../src/common/types.js';

/** Validate `tags` at `site` and return the diagnostics. */
function check(tags: Record<string, SqlValue>, site: TagSite) {
	return validateReservedTags(tags, site);
}

describe('Reserved tag registry', () => {
	describe('namespace gate', () => {
		it('passes free-form user tags through untouched', () => {
			const diags = check({ display_name: 'X', audit: true }, 'logical-table');
			expect(diags).to.have.length(0);
		});

		it('ignores user tags even alongside reserved ones', () => {
			const diags = check(
				{ display_name: 'X', 'quereus.update.policy': 'strict' },
				'view-ddl',
			);
			expect(diags).to.have.length(0);
		});

		it('returns no diagnostics for undefined tags', () => {
			expect(validateReservedTags(undefined, 'logical-table')).to.have.length(0);
		});
	});

	describe('unknown-reserved-tag', () => {
		it('flags a typo on an exact key', () => {
			const diags = check({ 'quereus.update.taget': 'a' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
			expect(diags[0].severity).to.equal('error');
			expect(diags[0].message.toLowerCase()).to.include('unknown reserved tag');
		});

		it('flags a typo on a templated key', () => {
			const diags = check({ 'quereus.lens.akc.x': 'r' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});

		it('treats an empty template remainder as unknown (default_for.)', () => {
			const diags = check({ 'quereus.update.default_for.': '1' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});

		it('treats an empty template remainder as unknown (lens.ack.)', () => {
			const diags = check({ 'quereus.lens.ack.': 'r' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
		});
	});

	describe('tag-not-allowed-here', () => {
		it('rejects delete_via on a view DDL site', () => {
			const diags = check({ 'quereus.update.delete_via': 'left_delete' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
			expect(diags[0].severity).to.equal('error');
			expect(diags[0].message.toLowerCase()).to.include('not allowed');
		});

		it('rejects lens.ack on a view DDL site', () => {
			const diags = check({ 'quereus.lens.ack.no-backing-index': 'r' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
		});

		it('rejects policy on a DML statement site', () => {
			const diags = check({ 'quereus.update.policy': 'strict' }, 'dml-stmt');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
		});
	});

	describe('invalid-tag-value: enum', () => {
		it('rejects an out-of-set policy (error)', () => {
			const diags = check({ 'quereus.update.policy': 'looose' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
			expect(diags[0].message.toLowerCase()).to.include('invalid value');
		});

		it('rejects an out-of-set delete_via (error)', () => {
			const diags = check({ 'quereus.update.delete_via': 'sideways' }, 'join');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('accepts every enum member', () => {
			expect(check({ 'quereus.update.policy': 'lenient' }, 'view-ddl')).to.have.length(0);
			expect(check({ 'quereus.update.delete_via': 'right_insert' }, 'union-branch')).to.have.length(0);
			expect(check({ 'quereus.update.delete_via': 'parent' }, 'join')).to.have.length(0);
		});
	});

	describe('invalid-tag-value: csv-of-identifiers', () => {
		it('accepts a comma-separated identifier list', () => {
			expect(check({ 'quereus.update.target': 'base_a, base_b' }, 'view-ddl')).to.have.length(0);
		});

		it('rejects an empty value (error)', () => {
			const diags = check({ 'quereus.update.exclude': '' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});

		it('rejects an empty segment (error)', () => {
			const diags = check({ 'quereus.update.target': 'a, , b' }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
		});
	});

	describe('invalid-tag-value: required-nonempty-rationale (warning)', () => {
		it('warns on an empty rationale', () => {
			const diags = check({ 'quereus.lens.ack.no-backing-index': '' }, 'logical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('warning');
		});

		it('warns on a whitespace-only rationale', () => {
			const diags = check({ 'quereus.lens.ack.no-backing-index': '   ' }, 'logical-constraint');
			expect(diags).to.have.length(1);
			expect(diags[0].severity).to.equal('warning');
		});

		it('accepts a non-empty rationale with no diagnostic', () => {
			const diags = check(
				{ 'quereus.lens.ack.no-backing-index:vin': 'low-write table; commit-time scan is acceptable' },
				'logical-table',
			);
			expect(diags).to.have.length(0);
		});
	});

	describe('invalid-tag-value: string / expression', () => {
		it('accepts a default_for expression at view DDL', () => {
			expect(check({ 'quereus.update.default_for.created': 'epoch_ms()' }, 'view-ddl')).to.have.length(0);
		});

		it('accepts a lens.access hint at a logical table', () => {
			expect(check({ 'quereus.lens.access.vin': 'lookup' }, 'logical-table')).to.have.length(0);
		});

		it('rejects a non-text default_for value (error)', () => {
			const diags = check({ 'quereus.update.default_for.created': 42 }, 'view-ddl');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('invalid-tag-value');
			expect(diags[0].severity).to.equal('error');
		});
	});

	describe('getReservedTag (typed, exact key)', () => {
		it('reads an enum value as its union', () => {
			const tags = { 'quereus.update.policy': 'strict' };
			const policy = getReservedTag(tags, 'quereus.update.policy');
			expect(policy).to.equal('strict');
		});

		it('returns undefined for an absent key', () => {
			expect(getReservedTag({}, 'quereus.update.policy')).to.be.undefined;
		});

		it('returns undefined for a null value', () => {
			expect(getReservedTag({ 'quereus.update.policy': null }, 'quereus.update.policy')).to.be.undefined;
		});
	});

	describe('getReservedTagByTemplate', () => {
		it('enumerates default_for instances with their column segment', () => {
			const tags = {
				'quereus.update.default_for.created': 'epoch_ms()',
				'quereus.update.default_for.status': "'new'",
				display_name: 'ignored',
			};
			const instances = getReservedTagByTemplate(tags, 'quereus.update.default_for.<column>');
			expect(instances.map(i => i.segment).sort()).to.deep.equal(['created', 'status']);
		});

		it('captures the whole remainder of a lens.ack code (including :target)', () => {
			const tags = { 'quereus.lens.ack.no-backing-index:vin': 'rationale' };
			const instances = getReservedTagByTemplate(tags, 'quereus.lens.ack.<code>');
			expect(instances).to.have.length(1);
			expect(instances[0].segment).to.equal('no-backing-index:vin');
			expect(instances[0].value).to.equal('rationale');
		});

		it('skips an empty remainder', () => {
			const instances = getReservedTagByTemplate({ 'quereus.lens.ack.': 'r' }, 'quereus.lens.ack.<code>');
			expect(instances).to.have.length(0);
		});
	});

	describe('quereus.update.* statement-site coverage (override surface)', () => {
		// docs/view-updateability.md § Tags shows statement-level examples:
		//   update v with ("quereus.update.target" = 'base_a') ...
		//   insert into v with ("quereus.update.default_for.created" = epoch_ms('now')) ...
		//   delete from v with ("quereus.update.delete_via" = 'right_insert') ...
		// target / exclude / default_for / delete_via are legal at the dml-stmt site so a
		// statement can override the view-level routing; policy stays view-DDL only.
		it('accepts target at a DML statement site', () => {
			expect(check({ 'quereus.update.target': 'base_a' }, 'dml-stmt')).to.have.length(0);
		});

		it('accepts exclude at a DML statement site', () => {
			expect(check({ 'quereus.update.exclude': 'base_b' }, 'dml-stmt')).to.have.length(0);
		});

		it('accepts default_for at a DML statement site (matches the doc insert example)', () => {
			expect(check({ 'quereus.update.default_for.created': "epoch_ms('now')" }, 'dml-stmt')).to.have.length(0);
		});

		it('accepts delete_via at a DML statement site (matches the doc delete example)', () => {
			expect(check({ 'quereus.update.delete_via': 'right_insert' }, 'dml-stmt')).to.have.length(0);
		});

		it('keeps default_for / delete_via out of unrelated (lens-only) sites', () => {
			// physical-table is a lens-only site; the update overrides never apply there.
			expect(check({ 'quereus.update.default_for.created': "epoch_ms('now')" }, 'physical-table'))
				.to.have.length(1);
			expect(check({ 'quereus.update.delete_via': 'left_delete' }, 'physical-table'))
				.to.have.length(1);
		});
	});

	describe('rename hints + physical declarative sites (differ path)', () => {
		const PHYSICAL_SITES: TagSite[] = [
			'physical-table',
			'physical-column',
			'view-ddl',
			'physical-index',
			'physical-constraint',
		];

		it('accepts quereus.id at every physical declarative site (incl. a hyphenated value)', () => {
			for (const site of PHYSICAL_SITES) {
				// The hyphenated value guards the `'string'` (NOT csv-of-identifiers)
				// decision — `'tbl-thing'` is a real id in 50.2-declare-schema-renames.
				expect(check({ 'quereus.id': 'tbl-thing' }, site), `quereus.id at ${site}`)
					.to.have.length(0);
			}
		});

		it('accepts quereus.previous_name at every physical declarative site', () => {
			for (const site of PHYSICAL_SITES) {
				expect(check({ 'quereus.previous_name': 'old_a, old_b' }, site), `previous_name at ${site}`)
					.to.have.length(0);
			}
		});

		it('flags a typo on previous_name as a single unknown-reserved-tag error', () => {
			const diags = check({ 'quereus.previuos_name': 'old' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
			expect(diags[0].severity).to.equal('error');
		});

		it('flags a typo on update.target at a physical site as unknown-reserved-tag', () => {
			const diags = check({ 'quereus.update.taget': 'Car' }, 'physical-table');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('unknown-reserved-tag');
			expect(diags[0].severity).to.equal('error');
		});

		it('rejects update.target on a physical table but accepts it on a view DDL', () => {
			const onTable = check({ 'quereus.update.target': 'base_a' }, 'physical-table');
			expect(onTable).to.have.length(1);
			expect(onTable[0].reason).to.equal('tag-not-allowed-here');

			expect(check({ 'quereus.update.target': 'base_a' }, 'view-ddl')).to.have.length(0);
		});

		it('keeps quereus.lens.decomp.* valid at physical-table (no regression)', () => {
			expect(check({ 'quereus.lens.decomp.role.d1': 'primary-storage' }, 'physical-table'))
				.to.have.length(0);
		});

		it('rejects a non-column-legal reserved key on a physical column', () => {
			// quereus.update.policy is view-ddl only; mis-placed on a column it is
			// now tag-not-allowed-here rather than silently escaping.
			const diags = check({ 'quereus.update.policy': 'strict' }, 'physical-column');
			expect(diags).to.have.length(1);
			expect(diags[0].reason).to.equal('tag-not-allowed-here');
		});
	});

	describe('RESERVED_TAGS table', () => {
		it('is deeply frozen (array, each spec, and each spec.sites)', () => {
			expect(Object.isFrozen(RESERVED_TAGS)).to.equal(true);
			for (const spec of RESERVED_TAGS) {
				expect(Object.isFrozen(spec), `spec ${JSON.stringify(spec.key)} frozen`).to.equal(true);
				expect(Object.isFrozen(spec.sites), `spec ${JSON.stringify(spec.key)} sites frozen`).to.equal(true);
			}
		});

		it('seeds all documented keys (rename hints + update + lens advisory + escalation policy + lens decomposition families)', () => {
			// 2 rename hints (quereus.id / quereus.previous_name) + 5 quereus.update.*
			// + 2 quereus.lens.{ack,access} + 2 quereus.lens.policy.*
			// + 9 quereus.lens.decomp.* = 20. (The decomp generator/gencadence tags were
			// retired — a surrogate's value now comes from the anchor key column's
			// declared DEFAULT, not an engine-chosen generator strategy.)
			expect(RESERVED_TAGS).to.have.length(20);
			const keys = RESERVED_TAGS.map(s => (typeof s.key === 'string' ? s.key : s.key.template));
			expect(keys).to.include('quereus.id');
			expect(keys).to.include('quereus.previous_name');
			expect(keys).to.include('quereus.lens.policy.error-on');
			expect(keys).to.include('quereus.lens.policy.require-ack');
			expect(keys).to.include('quereus.lens.decomp.role.<id>');
			expect(keys).to.include('quereus.lens.decomp.col.<id_dot_column>');
		});
	});
});
