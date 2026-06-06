import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { RowDescriptor, RowGetter, TableDescriptor, TableGetter } from '../planner/nodes/plan-node.js';
import { RowContextMap } from './context-helpers.js';

/**
 * Strict-fork test harness.
 *
 * Production behavior is unchanged: when `QUEREUS_FORK_STRICT` is unset, every
 * helper here is a no-op pass-through. When set, the helpers wrap each
 * RuntimeContext's `tableContexts` and `context` maps so that mutating the
 * *parent* while one of its forks is being driven throws a contract violation.
 *
 * State is tracked **per parent map** (not globally) so that:
 *   - concurrent unrelated drivers don't interfere,
 *   - forks may mutate their own (fresh, fork-local) maps freely,
 *   - sub-forks (fork of a fork) are independently tracked.
 *
 * See docs/runtime.md § Parallel runtime fork contract for the rules this
 * harness enforces.
 */

// Cross-platform guard: `process` is unavailable in browser / RN / edge workers.
// Strict mode is a Node-only test harness, so silently disable elsewhere.
const flag = typeof process !== 'undefined' ? process.env?.QUEREUS_FORK_STRICT : undefined;
const STRICT_MODE = flag === '1' || flag === 'true';

/** Per-wrapped-map state: how many forks of this map are currently being driven. */
interface ForkState {
	activeForks: number;
}

/** Wrapped map → its state. Used by the proxy/subclass to know when to throw. */
const stateByWrappedMap = new WeakMap<object, ForkState>();

/** Forked map → state of the parent map it was forked from. Used by drive() to bump parent. */
const parentStateOfFork = new WeakMap<object, ForkState>();

export function strictForkEnabled(): boolean {
	return STRICT_MODE;
}

function violation(target: string, count: number): never {
	throw new QuereusError(
		`strict-fork: parent context mutated ${target} while ${count} fork(s) are active. ` +
		`This is a fork-contract violation. See docs/runtime.md § Parallel runtime fork contract.`,
		StatusCode.INTERNAL,
	);
}

/**
 * Wrap a fresh `tableContexts` Map. In non-strict mode returns the input
 * unchanged; in strict mode returns a Proxy that throws on set/delete/clear
 * while any fork of this map is being driven.
 */
export function wrapTableContextsStrict(
	map: Map<TableDescriptor, TableGetter>,
): Map<TableDescriptor, TableGetter> {
	if (!STRICT_MODE) return map;
	const state: ForkState = { activeForks: 0 };
	const proxy = new Proxy(map, {
		get(target, prop, _receiver) {
			const raw = Reflect.get(target, prop, target);
			if (typeof raw !== 'function') return raw;
			if (prop === 'set' || prop === 'delete' || prop === 'clear') {
				return function strictMutation(...args: unknown[]): unknown {
					if (state.activeForks > 0) violation('tableContexts', state.activeForks);
					return (raw as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			return (raw as (...a: unknown[]) => unknown).bind(target);
		},
	});
	stateByWrappedMap.set(proxy, state);
	return proxy;
}

class StrictRowContextMap extends RowContextMap {
	private readonly forkState: ForkState;

	constructor(state: ForkState) {
		super();
		this.forkState = state;
	}

	override set(descriptor: RowDescriptor, rowGetter: RowGetter): this {
		if (this.forkState.activeForks > 0) violation('context (RowContextMap)', this.forkState.activeForks);
		return super.set(descriptor, rowGetter);
	}

	override delete(descriptor: RowDescriptor): boolean {
		if (this.forkState.activeForks > 0) violation('context (RowContextMap)', this.forkState.activeForks);
		return super.delete(descriptor);
	}
}

/**
 * Construct a `RowContextMap`. In strict mode returns a subclass that throws
 * on set/delete while forks of it are being driven; otherwise returns the
 * vanilla map. Use at any RuntimeContext construction site instead of
 * `new RowContextMap()`.
 */
export function createStrictRowContextMap(): RowContextMap {
	if (!STRICT_MODE) return new RowContextMap();
	const state: ForkState = { activeForks: 0 };
	const map = new StrictRowContextMap(state);
	stateByWrappedMap.set(map, state);
	return map;
}

/**
 * Record that `child` was forked from `parent`. The child carries a hidden
 * reference back to the parent's ForkState so drive() can bump it.
 * No-op outside strict mode.
 */
export function markForkOf(child: object, parent: object): void {
	if (!STRICT_MODE) return;
	const parentState = stateByWrappedMap.get(parent);
	if (parentState) parentStateOfFork.set(child, parentState);
}

/**
 * Bump the parent's active-forks counter for the given forked map.
 * Returns the state object (or null) so the caller can drop it later.
 * No-op outside strict mode.
 */
export function bumpParentForkCounter(forkedMap: object): ForkState | null {
	if (!STRICT_MODE) return null;
	const state = parentStateOfFork.get(forkedMap);
	if (!state) return null;
	state.activeForks++;
	return state;
}

/** Drop a counter previously bumped via {@link bumpParentForkCounter}. */
export function dropParentForkCounter(state: ForkState | null): void {
	if (!STRICT_MODE || state === null) return;
	state.activeForks--;
}
