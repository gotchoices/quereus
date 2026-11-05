import type { Database } from '../../core/database.js';
import type { MaybePromise } from '../../common/types.js';
import type { VirtualTableConnection } from '../connection.js';

/** Handle returned by {@link installConnectionLifecycleCheck}. */
export interface ConnectionLifecycleCheck {
	/** Every violation recorded so far. */
	readonly violations: readonly string[];
	/** Throws if any violation was recorded or, with no statement running in autocommit, a registered connection is open. */
	assertClean(): void;
}

type LifecycleMethod = 'begin' | 'commit' | 'rollback' | 'createSavepoint' | 'releaseSavepoint' | 'rollbackToSavepoint';
type LifecycleCall = (...args: number[]) => MaybePromise<void>;
type LifecycleState = 'idle' | 'open' | 'commit-failed';

interface ConnectionRecord {
	state: LifecycleState;
	/** Savepoints the connection holds while open; the next `createSavepoint` must name this depth. */
	depth: number;
	/** The call that has not settled yet, if any. */
	inFlight: string | null;
	/** The most recent calls, oldest first. */
	history: string[];
}

interface Transition {
	/** Whether the call is legal for the connection as it stands. */
	legal(record: ConnectionRecord, depth: number): boolean;
	/** Applies the call's outcome once it has resolved or rejected. */
	settle(record: ConnectionRecord, depth: number, resolved: boolean): void;
}

const HISTORY_LENGTH = 8;

function holdsDepth(record: ConnectionRecord, depth: number): boolean {
	return record.state === 'open' && Number.isInteger(depth) && depth >= 0 && depth < record.depth;
}

function becomeIdle(record: ConnectionRecord): void {
	record.state = 'idle';
	record.depth = 0;
}

/**
 * The lifecycle the engine owes a registered connection (docs/invariants.md TXN-001).
 * A call that rejects leaves the connection as it was, with two exceptions: a
 * rejected commit leaves it able to take only a rollback, and a rollback ends the
 * transaction whether it resolves or rejects.
 */
const TRANSITIONS: Record<LifecycleMethod, Transition> = {
	begin: {
		legal: record => record.state === 'idle',
		settle: (record, _depth, resolved) => {
			if (resolved) record.state = 'open';
		},
	},
	commit: {
		legal: record => record.state === 'open',
		settle: (record, _depth, resolved) => {
			if (resolved) becomeIdle(record);
			else record.state = 'commit-failed';
		},
	},
	rollback: {
		legal: record => record.state !== 'idle',
		settle: record => becomeIdle(record),
	},
	createSavepoint: {
		legal: (record, depth) => record.state === 'open' && depth === record.depth,
		settle: (record, depth, resolved) => {
			if (resolved) record.depth = depth + 1;
		},
	},
	releaseSavepoint: {
		legal: holdsDepth,
		settle: (record, depth, resolved) => {
			if (resolved) record.depth = depth;
		},
	},
	// The target savepoint itself survives a rollback to it.
	rollbackToSavepoint: {
		legal: holdsDepth,
		settle: (record, depth, resolved) => {
			if (resolved) record.depth = depth + 1;
		},
	},
};

const LIFECYCLE_METHODS = Object.keys(TRANSITIONS) as LifecycleMethod[];

function describeState(record: ConnectionRecord): string {
	return record.state === 'open' ? `open at savepoint depth ${record.depth}` : record.state;
}

function describeConnection(connection: VirtualTableConnection): string {
	return `connection '${connection.connectionId}' (table '${connection.tableName}')`;
}

function describeHistory(record: ConnectionRecord): string {
	return record.history.length > 0 ? record.history.join(', ') : 'none';
}

function remember(record: ConnectionRecord, call: string): void {
	record.history.push(call);
	if (record.history.length > HISTORY_LENGTH) record.history.shift();
}

function isThenable(value: MaybePromise<void>): value is Promise<void> {
	return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}

/**
 * Installs a check of the connection lifecycle contract on `db`: every begin,
 * commit, rollback and savepoint call the engine makes on a connection passed to
 * `Database.registerConnection` is compared with what the contract allows. See
 * `docs/module-authoring-transactions.md` § "Connection lifecycle".
 *
 * A call the contract forbids is recorded in `violations` and then thrown, before
 * the connection's own method runs. It is recorded as well as thrown because the
 * engine swallows some of these throws on its error paths. A legal call returns
 * exactly what the connection's method returns, with no added ticks.
 *
 * Only the object handed to `registerConnection` is watched. Calls a wrapper
 * connection makes on the connections inside it are that wrapper's own business.
 * Install the check before the module under test registers its connections; one
 * registered earlier is not watched.
 *
 * TEST SUPPORT ONLY: the patch is permanent for the life of `db` and there is no
 * uninstall. Use a database you own.
 */
export function installConnectionLifecycleCheck(db: Database): ConnectionLifecycleCheck {
	const violations: string[] = [];
	const records = new WeakMap<VirtualTableConnection, ConnectionRecord>();

	function refusalReason(record: ConnectionRecord, method: LifecycleMethod, depth: number): string | null {
		if (!db._isExecuting()) return 'was called without the execution mutex held';
		if (record.inFlight !== null) return `was called before ${record.inFlight} on the same connection settled`;
		if (!TRANSITIONS[method].legal(record, depth)) return 'is not a legal call';
		return null;
	}

	function checkedCall(connection: VirtualTableConnection, record: ConnectionRecord, method: LifecycleMethod, real: LifecycleCall): LifecycleCall {
		return (...args: number[]) => {
			const depth = args[0];
			const call = method.endsWith('Savepoint') ? `${method}(${depth})` : method;

			const reason = refusalReason(record, method, depth);
			if (reason) {
				const message = `Connection lifecycle violation: ${call} on ${describeConnection(connection)} ${reason}; `
					+ `state: ${describeState(record)}; last calls: ${describeHistory(record)}`;
				violations.push(message);
				remember(record, `${call} (refused)`);
				throw new Error(message);
			}

			record.inFlight = call;
			const settle = (resolved: boolean): void => {
				record.inFlight = null;
				TRANSITIONS[method].settle(record, depth, resolved);
				remember(record, resolved ? call : `${call} (rejected)`);
			};

			let result: MaybePromise<void>;
			try {
				result = real(...args);
			} catch (error) {
				settle(false);
				throw error;
			}
			if (isThenable(result)) {
				// Observed, never replaced: the caller awaits the connection's own promise.
				result.then(() => settle(true), () => settle(false));
				return result;
			}
			settle(true);
			return result;
		};
	}

	function watch(connection: VirtualTableConnection): void {
		if (records.has(connection)) return;
		const record: ConnectionRecord = { state: 'idle', depth: 0, inFlight: null, history: [] };
		records.set(connection, record);
		const methods = connection as unknown as Record<LifecycleMethod, LifecycleCall>;
		for (const method of LIFECYCLE_METHODS) {
			methods[method] = checkedCall(connection, record, method, methods[method].bind(connection));
		}
	}

	const original = db.registerConnection.bind(db);
	(db as unknown as { registerConnection: typeof db.registerConnection }).registerConnection =
		(connection: VirtualTableConnection) => {
			watch(connection);
			return original(connection);
		};

	function connectionsLeftOpen(): string[] {
		if (db._isExecuting() || !db.getAutocommit()) return [];
		const leftOpen: string[] = [];
		for (const connection of db.getAllConnections()) {
			const record = records.get(connection);
			if (record && record.state !== 'idle') {
				leftOpen.push(`Connection lifecycle violation: ${describeConnection(connection)} is ${describeState(record)} `
					+ `with no statement running and the database in autocommit; last calls: ${describeHistory(record)}`);
			}
		}
		return leftOpen;
	}

	return {
		violations,
		assertClean() {
			const problems = [...violations, ...connectionsLeftOpen()];
			if (problems.length > 0) {
				throw new Error(problems.join('\n'));
			}
		},
	};
}
