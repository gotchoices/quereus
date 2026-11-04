/**
 * `items` reordered so each comes after the items it depends on, moving as little as that
 * allows. The earliest item whose dependencies are all placed goes next, so an order that
 * already satisfies every dependency comes back unchanged.
 *
 * Items in a cycle cannot all follow each other, so the edges between them are ignored: they
 * keep their relative order, and everything outside the cycle is still ordered around them.
 *
 * `keyOf` and `dependenciesOf` must spell a key the same way. A dependency on the item itself,
 * or on a key no item has, is ignored.
 */
export function orderDependenciesFirst<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	dependenciesOf: (item: T) => Iterable<string>,
): T[] {
	const edges = resolveEdges(items, keyOf, dependenciesOf);
	if (edges.every(dependencies => dependencies.length === 0)) return [...items];

	const acyclic = edges.map((dependencies, item) => dependencies.filter(d => !reaches(edges, d, item)));
	const placed = new Set<number>();
	const ordered: T[] = [];
	// NOTE: rescans from the start for each placement. That is quadratic in the items, and only
	// runs when an edge exists; if a plan with thousands of them shows up in profiles, use a heap.
	while (ordered.length < items.length) {
		const next = acyclic.findIndex((dependencies, item) => !placed.has(item) && dependencies.every(d => placed.has(d)));
		placed.add(next);
		ordered.push(items[next]);
	}
	return ordered;
}

/** {@link orderDependenciesFirst} with the edges reversed: each item comes BEFORE the items it depends on. */
export function orderDependentsFirst<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	dependenciesOf: (item: T) => Iterable<string>,
): T[] {
	const dependents = new Map<string, string[]>();
	for (const item of items) {
		for (const dependency of dependenciesOf(item)) {
			const known = dependents.get(dependency);
			if (known) known.push(keyOf(item));
			else dependents.set(dependency, [keyOf(item)]);
		}
	}
	return orderDependenciesFirst(items, keyOf, item => dependents.get(keyOf(item)) ?? []);
}

/** Per item (by position), the positions of the other items it depends on. */
function resolveEdges<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	dependenciesOf: (item: T) => Iterable<string>,
): number[][] {
	const positions = new Map(items.map((item, position) => [keyOf(item), position]));
	return items.map((item, position) => {
		const resolved = new Set<number>();
		for (const dependency of dependenciesOf(item)) {
			const target = positions.get(dependency);
			if (target !== undefined && target !== position) resolved.add(target);
		}
		return [...resolved];
	});
}

/** Whether `to` is `from`, or is reachable from `from` along `edges`. */
function reaches(edges: readonly number[][], from: number, to: number): boolean {
	const seen = new Set<number>();
	const pending = [from];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (current === to) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		pending.push(...edges[current]);
	}
	return false;
}
