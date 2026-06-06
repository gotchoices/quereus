import { expect } from 'chai';
import { DatabaseOptionsManager } from '../../src/core/database-options.js';
import type { OptionChangeEvent } from '../../src/core/database-options.js';

describe('DatabaseOptionsManager', () => {
	let mgr: DatabaseOptionsManager;

	beforeEach(() => {
		mgr = new DatabaseOptionsManager();
	});

	describe('registerOption', () => {
		it('should register a boolean option with default', () => {
			mgr.registerOption('debug', { type: 'boolean', defaultValue: false });
			expect(mgr.getOption('debug')).to.equal(false);
		});

		it('should register a string option with default', () => {
			mgr.registerOption('mode', { type: 'string', defaultValue: 'normal' });
			expect(mgr.getOption('mode')).to.equal('normal');
		});

		it('should register a number option with default', () => {
			mgr.registerOption('timeout', { type: 'number', defaultValue: 30 });
			expect(mgr.getOption('timeout')).to.equal(30);
		});

		it('should register an object option with default', () => {
			mgr.registerOption('config', { type: 'object', defaultValue: { key: 'val' } });
			expect(mgr.getOption('config')).to.deep.equal({ key: 'val' });
		});

		it('should throw on duplicate registration', () => {
			mgr.registerOption('dup', { type: 'boolean', defaultValue: false });
			expect(() => mgr.registerOption('dup', { type: 'boolean', defaultValue: true }))
				.to.throw(/already registered/);
		});

		it('should register aliases', () => {
			mgr.registerOption('verbose', {
				type: 'boolean',
				defaultValue: false,
				aliases: ['v', 'verb'],
			});
			expect(mgr.getOption('v')).to.equal(false);
			expect(mgr.getOption('verb')).to.equal(false);
		});

		it('should throw on duplicate alias', () => {
			mgr.registerOption('opt1', {
				type: 'boolean',
				defaultValue: false,
				aliases: ['shared'],
			});
			expect(() => mgr.registerOption('opt2', {
				type: 'boolean',
				defaultValue: true,
				aliases: ['shared'],
			})).to.throw(/alias.*already registered/i);
		});
	});

	describe('setOption', () => {
		beforeEach(() => {
			mgr.registerOption('flag', { type: 'boolean', defaultValue: false });
			mgr.registerOption('name', { type: 'string', defaultValue: 'default' });
			mgr.registerOption('count', { type: 'number', defaultValue: 0 });
			mgr.registerOption('data', { type: 'object', defaultValue: {} });
		});

		it('should set a boolean value', () => {
			mgr.setOption('flag', true);
			expect(mgr.getOption('flag')).to.equal(true);
		});

		it('should throw for unknown option', () => {
			expect(() => mgr.setOption('nonexistent', 42)).to.throw(/Unknown option/);
		});

		it('should short-circuit when value is unchanged', () => {
			let callCount = 0;
			mgr.registerOption('watched', {
				type: 'boolean',
				defaultValue: false,
				onChange: () => callCount++,
			});
			mgr.setOption('watched', true);
			expect(callCount).to.equal(1);
			mgr.setOption('watched', true); // same value
			expect(callCount).to.equal(1); // no additional call
		});

		it('should rollback on listener error', () => {
			mgr.registerOption('rollback_test', {
				type: 'number',
				defaultValue: 10,
				onChange: () => { throw new Error('listener error'); },
			});

			expect(() => mgr.setOption('rollback_test', 20)).to.throw(/listener error/);
			expect(mgr.getOption('rollback_test')).to.equal(10); // rolled back
		});

		it('should resolve via alias', () => {
			mgr.registerOption('aliased', {
				type: 'string',
				defaultValue: 'old',
				aliases: ['a'],
			});
			mgr.setOption('a', 'new');
			expect(mgr.getOption('aliased')).to.equal('new');
		});
	});

	describe('boolean conversion', () => {
		beforeEach(() => {
			mgr.registerOption('b', { type: 'boolean', defaultValue: false });
		});

		for (const [input, expected] of [
			[true, true],
			[false, false],
			['true', true],
			['false', false],
			['1', true],
			['0', false],
			['on', true],
			['off', false],
			['yes', true],
			['no', false],
			['TRUE', true],
			['FALSE', false],
			['ON', true],
			['OFF', false],
			[1, true],
			[0, false],
			[42, true],
			[-1, true],
		] as [unknown, boolean][]) {
			it(`should convert ${JSON.stringify(input)} to ${expected}`, () => {
				mgr.setOption('b', input);
				expect(mgr.getBooleanOption('b')).to.equal(expected);
			});
		}

		it('should throw for invalid boolean value', () => {
			expect(() => mgr.setOption('b', 'maybe')).to.throw(/Invalid boolean/);
		});

		it('should throw for null as boolean', () => {
			expect(() => mgr.setOption('b', null)).to.throw();
		});
	});

	describe('number conversion', () => {
		beforeEach(() => {
			mgr.registerOption('n', { type: 'number', defaultValue: 0 });
		});

		it('should accept a number directly', () => {
			mgr.setOption('n', 42);
			expect(mgr.getOption('n')).to.equal(42);
		});

		it('should convert string to number', () => {
			mgr.setOption('n', '123');
			expect(mgr.getOption('n')).to.equal(123);
		});

		it('should convert float string', () => {
			mgr.setOption('n', '3.14');
			expect(mgr.getOption('n')).to.equal(3.14);
		});

		it('should throw for non-numeric string', () => {
			expect(() => mgr.setOption('n', 'abc')).to.throw(/Invalid number/);
		});

		it('should throw for object as number', () => {
			expect(() => mgr.setOption('n', {})).to.throw(/Invalid number/);
		});
	});

	describe('object conversion', () => {
		beforeEach(() => {
			mgr.registerOption('o', { type: 'object', defaultValue: {} });
		});

		it('should accept an object directly', () => {
			mgr.setOption('o', { key: 'val' });
			expect(mgr.getObjectOption('o')).to.deep.equal({ key: 'val' });
		});

		it('should parse JSON string to object', () => {
			mgr.setOption('o', '{"a": 1}');
			expect(mgr.getObjectOption('o')).to.deep.equal({ a: 1 });
		});

		it('should throw for array value', () => {
			expect(() => mgr.setOption('o', [1, 2])).to.throw(/Invalid object/);
		});

		it('should throw for null value', () => {
			expect(() => mgr.setOption('o', null)).to.throw(/Invalid object/);
		});

		it('should throw for JSON string that parses to array', () => {
			expect(() => mgr.setOption('o', '[1,2]')).to.throw(/Invalid object/);
		});

		it('should throw for invalid JSON string', () => {
			expect(() => mgr.setOption('o', '{bad json')).to.throw(/Invalid object/);
		});

		it('should throw for JSON string that parses to non-object', () => {
			expect(() => mgr.setOption('o', '"just a string"')).to.throw(/Invalid object/);
		});
	});

	describe('getOption type safety', () => {
		beforeEach(() => {
			mgr.registerOption('bool', { type: 'boolean', defaultValue: true });
			mgr.registerOption('str', { type: 'string', defaultValue: 'hello' });
			mgr.registerOption('obj', { type: 'object', defaultValue: { x: 1 } });
		});

		it('should throw when getBooleanOption called on string', () => {
			expect(() => mgr.getBooleanOption('str')).to.throw(/not a boolean/);
		});

		it('should throw when getStringOption called on boolean', () => {
			expect(() => mgr.getStringOption('bool')).to.throw(/not a string/);
		});

		it('should throw when getObjectOption called on boolean', () => {
			expect(() => mgr.getObjectOption('bool')).to.throw(/not an object/);
		});

		it('should throw getOption for unknown key', () => {
			expect(() => mgr.getOption('nope')).to.throw(/Unknown option/);
		});
	});

	describe('case insensitivity', () => {
		it('should resolve keys case-insensitively', () => {
			mgr.registerOption('CamelCase', { type: 'string', defaultValue: 'test' });
			expect(mgr.getOption('camelcase')).to.equal('test');
			expect(mgr.getOption('CAMELCASE')).to.equal('test');
		});

		it('should resolve aliases case-insensitively', () => {
			mgr.registerOption('opt', {
				type: 'number',
				defaultValue: 5,
				aliases: ['MyAlias'],
			});
			expect(mgr.getOption('myalias')).to.equal(5);
			expect(mgr.getOption('MYALIAS')).to.equal(5);
		});
	});

	describe('getAllOptions', () => {
		it('should return all registered options', () => {
			mgr.registerOption('a', { type: 'boolean', defaultValue: true });
			mgr.registerOption('b', { type: 'string', defaultValue: 'x' });

			const all = mgr.getAllOptions();
			expect(all).to.have.property('a', true);
			expect(all).to.have.property('b', 'x');
		});
	});

	describe('getOptionDefinitions', () => {
		it('should return copies of definitions', () => {
			mgr.registerOption('d', { type: 'number', defaultValue: 42, description: 'test' });

			const defs = mgr.getOptionDefinitions();
			expect(defs).to.have.property('d');
			expect(defs['d'].type).to.equal('number');
			expect(defs['d'].description).to.equal('test');
		});
	});

	describe('onChange listener', () => {
		it('should call onChange with correct event', () => {
			const events: OptionChangeEvent[] = [];
			mgr.registerOption('listen', {
				type: 'number',
				defaultValue: 0,
				onChange: (e) => events.push(e),
			});

			mgr.setOption('listen', 10);
			expect(events).to.have.length(1);
			expect(events[0].key).to.equal('listen');
			expect(events[0].oldValue).to.equal(0);
			expect(events[0].newValue).to.equal(10);
		});

		it('should not call onChange when value is unchanged', () => {
			let calls = 0;
			mgr.registerOption('nochange', {
				type: 'string',
				defaultValue: 'same',
				onChange: () => calls++,
			});

			mgr.setOption('nochange', 'same');
			expect(calls).to.equal(0);
		});
	});

	describe('object value equality', () => {
		it('should detect equal objects and skip update', () => {
			let calls = 0;
			mgr.registerOption('obj_eq', {
				type: 'object',
				defaultValue: { a: 1, b: 2 },
				onChange: () => calls++,
			});

			mgr.setOption('obj_eq', { a: 1, b: 2 });
			expect(calls).to.equal(0);
		});

		it('should detect different objects and trigger update', () => {
			let calls = 0;
			mgr.registerOption('obj_neq', {
				type: 'object',
				defaultValue: { a: 1 },
				onChange: () => calls++,
			});

			mgr.setOption('obj_neq', { a: 2 });
			expect(calls).to.equal(1);
		});
	});
});
