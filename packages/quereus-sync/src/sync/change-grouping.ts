/**
 * Group a flat stream of filed changes and migrations into {@link ChangeSet}s, in the
 * order the serving replica filed them.
 *
 * Every fact a transaction produces shares one base HLC `(wallTime, counter, siteId)`
 * and differs only in `opSeq`; that triple **is** the transaction's identity. A replica
 * files the facts it receives from one transaction together, at one clock tick of its
 * own (`metadata/filing-position.ts`), so the unit read back out of its change log is
 * "one transaction's facts filed at one tick": one group, one `ChangeSet`. A transaction
 * written here is filed at its own HLC, so it is one group. A transaction whose facts
 * this replica filed at two ticks (part of it applied, the rest held and replayed
 * later) is two groups, and so two `ChangeSet`s carrying the same `transactionId`:
 * each must carry its own resume position, or a reply cut between them would move the
 * consumer past facts it was never sent.
 *
 * Groups are ordered by filing position and bounded by `batchSize` on that order: whole
 * groups accumulate until the cumulative data-change count reaches the bound; a group
 * is never split to hit it. A single oversized group (more facts than `batchSize`) is
 * returned whole and reported via `onOversized`.
 */

import { type HLC, compareHLC, createHLC, deterministicTxnId, maxHLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import { type FiledAt, filingPosition } from '../metadata/filing-position.js';
import type { Change, ChangeSet, SchemaMigration } from './protocol.js';

/** A change paired with where the serving replica filed it. */
export interface FiledChange {
	readonly change: Change;
	readonly position: HLC;
}

/**
 * Changes filed at their own origin timestamps: what a replica wrote itself, and
 * anything grouped on the origin axis alone (a push, or a held change being relayed,
 * which was never filed).
 */
export function filedAtOrigin(changes: readonly Change[]): FiledChange[] {
	return changes.map(change => ({ change, position: change.hlc }));
}

/** One transaction's facts filed at one tick. */
interface FilingGroup {
	/** Base HLC `(wallTime, counter, siteId)` with `opSeq` 0 — the transaction identity. */
	readonly base: HLC;
	readonly siteId: SiteId;
	readonly changes: FiledChange[];
	readonly migrations: SchemaMigration[];
}

/**
 * The group a filed fact belongs to: its transaction and the tick it was filed at.
 * `deterministicTxnId` excludes `opSeq`, so it names a transaction when given an origin
 * timestamp and a filing tick when given a position. Facts of one group are contiguous
 * in filing order (the filing rule gives each transaction in a tick a run of `opSeq`s
 * to itself), so a scan in that order crosses a group boundary exactly when this key
 * changes.
 */
export function filingGroupKey(filed: FiledAt): string {
	return `${deterministicTxnId(filed.hlc)}|${deterministicTxnId(filingPosition(filed))}`;
}

/**
 * Group changes and migrations by (transaction, filing tick). Input order is
 * irrelevant — groups are ordered by filing position and each group's facts and
 * migrations by their own positions, which within one group is their `opSeq` order.
 */
export function groupByTransactionAndTick(
	changes: readonly FiledChange[],
	migrations: readonly SchemaMigration[],
): FilingGroup[] {
	const groups = new Map<string, FilingGroup>();

	const groupFor = (filed: FiledAt): FilingGroup => {
		const key = filingGroupKey(filed);
		let group = groups.get(key);
		if (!group) {
			group = {
				base: createHLC(filed.hlc.wallTime, filed.hlc.counter, filed.hlc.siteId, 0),
				siteId: filed.hlc.siteId,
				changes: [],
				migrations: [],
			};
			groups.set(key, group);
		}
		return group;
	};

	for (const filed of changes) groupFor({ hlc: filed.change.hlc, position: filed.position }).changes.push(filed);
	for (const migration of migrations) groupFor(migration).migrations.push(migration);

	const ordered = [...groups.values()];
	for (const group of ordered) {
		group.changes.sort((a, b) => compareHLC(a.position, b.position));
		group.migrations.sort((a, b) => compareHLC(filingPosition(a), filingPosition(b)));
	}
	ordered.sort((a, b) => compareHLC(lastPosition(a), lastPosition(b)));
	return ordered;
}

/**
 * The group's greatest filing position: where a consumer that received the whole group
 * resumes from. `getChangesSince` returns what is filed strictly after its argument, and
 * a group's positions are contiguous, so resuming here skips the group and nothing else.
 */
function lastPosition(group: FilingGroup): HLC {
	return maxHLC([
		...group.changes.map(filed => filed.position),
		...group.migrations.map(filingPosition),
	])!; // a group is created by its first fact, so it is never empty
}

/** The group's greatest origin timestamp: the transaction's commit boundary, as far as this group holds it. */
function lastOrigin(group: FilingGroup): HLC {
	return maxHLC([
		...group.changes.map(filed => filed.change.hlc),
		...group.migrations.map(migration => migration.hlc),
	])!;
}

/** A migration as it travels in a `ChangeSet`: without the serving replica's position (the set's `cursor` covers it). */
function withoutPosition(migration: SchemaMigration): SchemaMigration {
	const { position: _position, ...rest } = migration;
	return rest;
}

function toChangeSet(group: FilingGroup): ChangeSet {
	const hlc = lastOrigin(group);
	const cursor = lastPosition(group);
	return {
		siteId: group.siteId,
		transactionId: deterministicTxnId(group.base),
		hlc,
		changes: group.changes.map(filed => filed.change),
		schemaMigrations: group.migrations.map(withoutPosition),
		...(compareHLC(cursor, hlc) !== 0 ? { cursor } : {}),
	};
}

/**
 * Build {@link ChangeSet}s from a flat stream of filed changes and migrations, one per
 * (transaction, filing tick), in filing order, bounded at group granularity by
 * `batchSize`. Each set's `cursor` is its greatest filing position, left off when that
 * equals its `hlc` (every set of facts the serving replica wrote itself).
 *
 * @param onOversized - called once per group whose data-change count exceeds
 *   `batchSize`; the group is still returned whole.
 */
export function buildTransactionChangeSets(
	changes: readonly FiledChange[],
	migrations: readonly SchemaMigration[],
	batchSize: number,
	onOversized?: (transactionId: string, changeCount: number) => void,
): ChangeSet[] {
	if (changes.length === 0 && migrations.length === 0) return [];

	const result: ChangeSet[] = [];
	let cumulative = 0;

	for (const group of groupByTransactionAndTick(changes, migrations)) {
		const changeSet = toChangeSet(group);
		result.push(changeSet);

		if (group.changes.length > batchSize) {
			onOversized?.(changeSet.transactionId, group.changes.length);
		}

		// Accumulate WHOLE groups; stop once the bound is reached. The rest come on the
		// next call, which the consumer makes from this reply's watermark
		// (`replyWatermark`): everything filed at or below it is in `result`.
		cumulative += group.changes.length;
		if (cumulative >= batchSize) break;
	}

	return result;
}
