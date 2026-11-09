/**
 * `items` reordered so each comes after the items it depends on. The earliest item whose
 * dependencies are all placed goes next, so an order that already satisfies every dependency
 * comes back unchanged.
 *
 * Items in a cycle cannot all follow each other, so the edges between them are replaced by their
 * input order: they keep their relative order, and everything outside the cycle is still ordered
 * around them.
 *
 * A preferred dependency orders items the same way, but gives way to the others: it is skipped
 * when the graph built so far already needs its target to follow the item that prefers it.
 * `preferredTiers` is strongest first, so a weaker preference cannot crowd out a stronger one.
 * A cycle's input order is weakest of all: it gives way to a preferred dependency.
 *
 * `keyOf` and the dependency functions must spell a key the same way. A dependency on the item
 * itself, or on a key no item has, is ignored.
 */
export function orderDependenciesFirst<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
	dependenciesOf: (item: T) => Iterable<string>,
	preferredTiers: ReadonlyArray<(item: T) => Iterable<string>> = [],
): T[] {
	const edges = resolveEdges(items, keyOf, dependenciesOf);
	const preferred = preferredTiers.map(tier => resolveEdges(items, keyOf, tier));
	if ([edges, ...preferred].flat().every(dependencies => dependencies.length === 0)) return [...items];

	const acyclic = edges.map((dependencies, item) => dependencies.filter(d => !reaches(edges, d, item)));
	const cycleInputOrder = cycleMembersInInputOrder(acyclic, edges);
	for (const tier of preferred) addEdgesThatCloseNoCycle(acyclic, tier);
	addEdgesThatCloseNoCycle(acyclic, cycleInputOrder);
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

/**
 * Per item (by position), the previous member of its own cycle. Without these edges, a member that
 * also waits on an item outside the cycle falls behind the members after it.
 *
 * A cycle's members are exactly the items that lost an edge to `acyclic`, so call this before adding
 * to `acyclic`. On their own these edges cannot close a cycle: each cycle has lost all its internal
 * edges and becomes one chain, and the edges left between cycles form no cycle of their own.
 *
 * A preferred dependency can close one, through an item outside the cycle. It wins: it is a read the
 * item may need, where a cycle's order is only a tie-break among edges already ignored.
 */
function cycleMembersInInputOrder(acyclic: readonly number[][], edges: readonly number[][]): number[][] {
	const lastMemberOfEachCycle: number[] = [];
	return acyclic.map((kept, item) => {
		if (kept.length === edges[item].length) return [];
		const cycle = lastMemberOfEachCycle.findIndex(last => reaches(edges, item, last) && reaches(edges, last, item));
		if (cycle === -1) {
			lastMemberOfEachCycle.push(item);
			return [];
		}
		const previous = lastMemberOfEachCycle[cycle];
		lastMemberOfEachCycle[cycle] = item;
		return [previous];
	});
}

/**
 * Adds `candidates` to the acyclic `graph` one at a time. Each is checked against the edges added
 * before it, because candidates that each pass alone can still form a cycle together.
 *
 * NOTE: one graph walk per candidate. A plan has a candidate per new view or maintained table per
 * altered table (500 materialized views over 20 altered tables planned in 11 ms); if plans with
 * thousands of those show up in profiles, compute reachability once and update it.
 */
function addEdgesThatCloseNoCycle(graph: number[][], candidates: readonly number[][]): void {
	candidates.forEach((dependencies, item) => {
		for (const dependency of dependencies) {
			if (!reaches(graph, dependency, item)) graph[item].push(dependency);
		}
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
