import { PlanNode } from '../nodes/plan-node.js';

/**
 * Output column-name disambiguation, shared by every node that publishes a
 * user-visible `RelationType.columns` list.
 *
 * A result row is delivered to callers as an object keyed by column name
 * (`rowToObject`), so two output columns sharing a name silently drop one of the
 * values — `select l.a, r.a, count(*) c from l join r … group by l.a, r.a` would
 * hand back a single `a`. Later occurrences therefore take a `:<n>` suffix:
 * `a`, `a:1`, `a:2`.
 */
export function disambiguateColumnNames(baseNames: readonly string[]): string[] {
	const nameCount = new Map<string, number>();
	return baseNames.map(baseName => {
		const currentCount = nameCount.get(baseName) ?? 0;
		nameCount.set(baseName, currentCount + 1);
		// First occurrence keeps the base name; subsequent ones are numbered.
		return currentCount === 0 ? baseName : `${baseName}:${currentCount}`;
	});
}

/**
 * The attribute-id counterpart of {@link disambiguateColumnNames}, for nodes that
 * forward a source id for a bare column reference: returns `id` the first time the
 * node publishes it and a fresh id at any later position, so `select id as x, id as y`
 * gives `y` its own id. A repeated id binds both positions to one row slot
 * (`buildRowDescriptor`). That is harmless while both hold the same value, and wrong
 * once a union mirrors the ids over a branch whose two columns differ.
 */
export function uniqueOutputId(published: Set<number>, id: number): number {
	if (published.has(id)) return PlanNode.nextAttrId();
	published.add(id);
	return id;
}
