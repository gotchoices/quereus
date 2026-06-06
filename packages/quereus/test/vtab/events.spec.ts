import { expect } from 'chai';
import { DefaultVTableEventEmitter } from '../../src/vtab/events.js';
import type { VTableDataChangeEvent, VTableSchemaChangeEvent } from '../../src/vtab/events.js';

describe('DefaultVTableEventEmitter', () => {
	let emitter: DefaultVTableEventEmitter;

	beforeEach(() => {
		emitter = new DefaultVTableEventEmitter();
	});

	function makeDataEvent(type: 'insert' | 'update' | 'delete' = 'insert'): VTableDataChangeEvent {
		return { type, schemaName: 'main', tableName: 'test', key: [1] };
	}

	function makeSchemaEvent(type: 'create' | 'alter' | 'drop' = 'create'): VTableSchemaChangeEvent {
		return { type, objectType: 'table', schemaName: 'main', objectName: 'test' };
	}

	// --- Data listeners ---

	describe('data change listeners', () => {
		it('should report no listeners initially', () => {
			expect(emitter.hasDataListeners()).to.be.false;
		});

		it('should register and invoke a data listener', () => {
			const events: VTableDataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			expect(emitter.hasDataListeners()).to.be.true;

			emitter.emitDataChange(makeDataEvent());
			expect(events).to.have.length(1);
			expect(events[0].type).to.equal('insert');
		});

		it('should support multiple data listeners', () => {
			let count1 = 0;
			let count2 = 0;
			emitter.onDataChange(() => count1++);
			emitter.onDataChange(() => count2++);

			emitter.emitDataChange(makeDataEvent());
			expect(count1).to.equal(1);
			expect(count2).to.equal(1);
		});

		it('should unsubscribe via returned function', () => {
			const events: string[] = [];
			const unsub = emitter.onDataChange(e => events.push(e.type));

			emitter.emitDataChange(makeDataEvent());
			expect(events).to.have.length(1);

			unsub();
			expect(emitter.hasDataListeners()).to.be.false;

			emitter.emitDataChange(makeDataEvent('delete'));
			expect(events).to.have.length(1); // no new event
		});

		it('should continue dispatching when a listener throws', () => {
			const events: string[] = [];
			emitter.onDataChange(() => { throw new Error('boom'); });
			emitter.onDataChange(e => events.push(e.type));

			emitter.emitDataChange(makeDataEvent());
			expect(events).to.have.length(1);
		});
	});

	// --- Batching ---

	describe('event batching', () => {
		it('should queue events when batching is active', () => {
			const events: string[] = [];
			emitter.onDataChange(e => events.push(e.type));

			emitter.startBatch();
			emitter.emitDataChange(makeDataEvent('insert'));
			emitter.emitDataChange(makeDataEvent('update'));
			expect(events).to.have.length(0); // queued, not dispatched

			emitter.flushBatch();
			expect(events).to.have.length(2);
			expect(events[0]).to.equal('insert');
			expect(events[1]).to.equal('update');
		});

		it('should discard queued events on discardBatch', () => {
			const events: string[] = [];
			emitter.onDataChange(e => events.push(e.type));

			emitter.startBatch();
			emitter.emitDataChange(makeDataEvent('insert'));
			emitter.emitDataChange(makeDataEvent('delete'));

			emitter.discardBatch();
			expect(events).to.have.length(0);

			// After discard, events should dispatch immediately again
			emitter.emitDataChange(makeDataEvent('update'));
			expect(events).to.have.length(1);
			expect(events[0]).to.equal('update');
		});

		it('should flush empty batch without error', () => {
			emitter.startBatch();
			emitter.flushBatch();
			// No error
		});

		it('should handle flushBatch without startBatch gracefully', () => {
			const events: string[] = [];
			emitter.onDataChange(e => events.push(e.type));

			// flushBatch without startBatch should be a safe no-op
			emitter.flushBatch();
			expect(events).to.have.length(0);
		});

		it('should handle listener error during flush', () => {
			const events: string[] = [];
			emitter.onDataChange(() => { throw new Error('flush-boom'); });
			emitter.onDataChange(e => events.push(e.type));

			emitter.startBatch();
			emitter.emitDataChange(makeDataEvent());
			emitter.flushBatch();

			// Second listener still got the event
			expect(events).to.have.length(1);
		});

		it('should start a new batch after flush', () => {
			const events: string[] = [];
			emitter.onDataChange(e => events.push(e.type));

			emitter.startBatch();
			emitter.emitDataChange(makeDataEvent('insert'));
			emitter.flushBatch();

			// Not batching anymore — immediate dispatch
			emitter.emitDataChange(makeDataEvent('delete'));
			expect(events).to.have.length(2);
		});
	});

	// --- Schema listeners ---

	describe('schema change listeners', () => {
		it('should report no schema listeners initially', () => {
			expect(emitter.hasSchemaListeners()).to.be.false;
		});

		it('should register and invoke a schema listener', () => {
			const events: VTableSchemaChangeEvent[] = [];
			emitter.onSchemaChange(e => events.push(e));

			expect(emitter.hasSchemaListeners()).to.be.true;

			emitter.emitSchemaChange(makeSchemaEvent());
			expect(events).to.have.length(1);
			expect(events[0].type).to.equal('create');
		});

		it('should unsubscribe schema listener', () => {
			const events: string[] = [];
			const unsub = emitter.onSchemaChange(e => events.push(e.type));

			emitter.emitSchemaChange(makeSchemaEvent());
			unsub();
			emitter.emitSchemaChange(makeSchemaEvent('drop'));

			expect(events).to.have.length(1);
		});

		it('should continue dispatching schema events when a listener throws', () => {
			const events: string[] = [];
			emitter.onSchemaChange(() => { throw new Error('schema-boom'); });
			emitter.onSchemaChange(e => events.push(e.type));

			emitter.emitSchemaChange(makeSchemaEvent('alter'));
			expect(events).to.have.length(1);
			expect(events[0]).to.equal('alter');
		});
	});

	// --- removeAllListeners ---

	describe('removeAllListeners', () => {
		it('should clear all data and schema listeners', () => {
			emitter.onDataChange(() => {});
			emitter.onSchemaChange(() => {});

			expect(emitter.hasDataListeners()).to.be.true;
			expect(emitter.hasSchemaListeners()).to.be.true;

			emitter.removeAllListeners();

			expect(emitter.hasDataListeners()).to.be.false;
			expect(emitter.hasSchemaListeners()).to.be.false;
		});

		it('should clear batched events and reset batching state', () => {
			const events: string[] = [];
			emitter.onDataChange(e => events.push(e.type));

			emitter.startBatch();
			emitter.emitDataChange(makeDataEvent());

			emitter.removeAllListeners();

			// Re-add listener and emit — should dispatch immediately (not batching)
			emitter.onDataChange(e => events.push(e.type));
			emitter.emitDataChange(makeDataEvent('delete'));
			expect(events).to.have.length(1);
			expect(events[0]).to.equal('delete');
		});
	});
});
