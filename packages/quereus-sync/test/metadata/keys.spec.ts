/**
 * Tests for sync metadata key encoding.
 *
 * Three load-bearing invariants:
 *  - the lexicographic byte order of `cl:` keys MUST equal `compareHLC`, so that a
 *    range scan over the key space visits entries in HLC order. The opSeq bytes sit
 *    after siteId (the last tiebreak), so they must round-trip and must order facts
 *    of the same transaction;
 *  - every variable-length component (schema, table, generation, pk identity,
 *    column) is length-prefixed, so a name containing `:` or `.` can neither shift
 *    a parse nor let one table's scan bounds swallow another's keys;
 *  - the per-row families (`cv:`/`tb:`/`cl:`) are keyed by the table's GENERATION,
 *    never its name; the name lives only in the `tg:` record that maps it to the
 *    generation (format version 6, `metadata/table-identity.ts`).
 */

import { expect } from 'chai';
import { type HLC, compareHLC, createHLC } from '../../src/clock/hlc.js';
import {
  serializeHLCForKey,
  deserializeHLCFromKey,
  buildChangeLogKey,
  parseChangeLogKey,
  buildChangeLogScanBoundsAfter,
  buildColumnVersionKey,
  parseColumnVersionKey,
  buildTombstoneKey,
  parseTombstoneKey,
  buildSchemaMigrationKey,
  parseSchemaMigrationKey,
  buildTableGenerationKey,
  parseTableGenerationKey,
  buildAllTableGenerationScanBounds,
  buildTableColumnVersionScanBounds,
  buildColumnVersionScanBounds,
  buildTombstoneScanBounds,
  buildSchemaMigrationScanBounds,
  buildQuarantineKey,
  buildQuarantineScanBounds,
  encodeRawPkIdentity,
  encodePkIdentity,
  mintTableGeneration,
  tableGenerationToBytes,
  tableGenerationFromBytes,
  RAW_PK_KEYING,
  SYNC_METADATA_FORMAT_VERSION,
} from '../../src/metadata/keys.js';

const siteA = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const siteB = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Two fixed generations (22 base64url chars each), so key bytes are deterministic. */
const GEN_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const GEN_B = 'BBBBBBBBBBBBBBBBBBBBBB';

/** Lexicographic comparison of two byte arrays (the KV store's key order). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('change-log key encoding', () => {
  describe('serializeHLCForKey / deserializeHLCFromKey', () => {
    it('should round-trip a 30-byte HLC component including opSeq', () => {
      const hlc = createHLC(1234567890123n, 42, siteA, 0xCAFEBABE);
      const bytes = serializeHLCForKey(hlc);
      expect(bytes.length).to.equal(30);

      const back = deserializeHLCFromKey(bytes);
      expect(back.wallTime).to.equal(hlc.wallTime);
      expect(back.counter).to.equal(hlc.counter);
      expect(back.opSeq).to.equal(0xCAFEBABE);
      expect(compareHLC(back, hlc)).to.equal(0);
    });

    it('should place opSeq after siteId so byte order == compareHLC', () => {
      // A representative set spanning every component, intentionally NOT sorted.
      const hlcs: HLC[] = [
        createHLC(2000n, 0, siteA, 0),     // wallTime dominates
        createHLC(1000n, 2, siteA, 0),     // counter beats siteId/opSeq
        createHLC(1000n, 1, siteB, 0),     // siteId beats opSeq
        createHLC(1000n, 1, siteA, 5),     // opSeq is the last tiebreak
        createHLC(1000n, 1, siteA, 0),
        createHLC(1000n, 0, siteA, 0xFFFFFFFF),
      ];

      for (const x of hlcs) {
        for (const y of hlcs) {
          const byCompare = sign(compareHLC(x, y));
          const byBytes = sign(compareBytes(serializeHLCForKey(x), serializeHLCForKey(y)));
          expect(byBytes).to.equal(byCompare,
            `byte order disagreed with compareHLC for ${x.opSeq} vs ${y.opSeq}`);
        }
      }
    });

    it('should keep a counter rollover ordered above an opSeq increment', () => {
      // (counter+1, opSeq 0) must outrank (same counter, large opSeq).
      const opBump = createHLC(1000n, 1, siteA, 0xFFFFFFFF);
      const counterBump = createHLC(1000n, 2, siteA, 0);
      expect(compareHLC(opBump, counterBump)).to.be.lessThan(0);
      expect(sign(compareBytes(serializeHLCForKey(opBump), serializeHLCForKey(counterBump))))
        .to.equal(-1);
    });
  });

  describe('buildChangeLogKey / parseChangeLogKey', () => {
    it('should round-trip a column entry at the new 30-byte offsets', () => {
      const hlc = createHLC(1000n, 7, siteA, 99);
      const identity = encodeRawPkIdentity([1, 'x']);
      const key = buildChangeLogKey(hlc, 'column', GEN_A, identity, 'name');
      // cl:(3) + hlc(30) + type(1) + suffix
      expect(key.length).to.be.greaterThan(34);

      const parsed = parseChangeLogKey(key);
      expect(parsed).to.not.be.null;
      expect(parsed!.entryType).to.equal('column');
      expect(parsed!.generation).to.equal(GEN_A);
      expect(parsed!.column).to.equal('name');
      expect(parsed!.identity).to.equal(identity);
      expect(parsed!.hlc.opSeq).to.equal(99);
      expect(compareHLC(parsed!.hlc, hlc)).to.equal(0);
    });

    it('should round-trip a delete entry (no column)', () => {
      const hlc = createHLC(1000n, 1, siteB, 3);
      const identity = encodeRawPkIdentity([42]);
      const key = buildChangeLogKey(hlc, 'delete', GEN_A, identity);
      const parsed = parseChangeLogKey(key);
      expect(parsed).to.not.be.null;
      expect(parsed!.entryType).to.equal('delete');
      expect(parsed!.column).to.be.undefined;
      expect(parsed!.generation).to.equal(GEN_A);
      expect(parsed!.identity).to.equal(identity);
      expect(parsed!.hlc.opSeq).to.equal(3);
    });

    it('should produce keys whose byte order matches compareHLC', () => {
      const hlcs: HLC[] = [
        createHLC(1000n, 1, siteA, 0),
        createHLC(1000n, 1, siteA, 1),
        createHLC(1000n, 1, siteA, 2),
        createHLC(1000n, 1, siteB, 0),
        createHLC(1000n, 2, siteA, 0),
        createHLC(2000n, 0, siteA, 0),
      ];
      const keyFor = (h: HLC): Uint8Array =>
        buildChangeLogKey(h, 'column', GEN_A, encodeRawPkIdentity([1]), 'c');

      for (const x of hlcs) {
        for (const y of hlcs) {
          expect(sign(compareBytes(keyFor(x), keyFor(y))))
            .to.equal(sign(compareHLC(x, y)));
        }
      }
    });

    it('should reject buffers shorter than the minimum length', () => {
      expect(parseChangeLogKey(new Uint8Array(34))).to.be.null;
    });
  });

  describe('buildChangeLogScanBoundsAfter', () => {
    it('should exclude <= sinceHLC (incl. non-zero opSeq) and include the next', () => {
      // sinceHLC is the last fact of a transaction (opSeq 5).
      const since = createHLC(1000n, 1, siteA, 5);
      const next = createHLC(1000n, 1, siteA, 6); // next fact, strictly after
      const { gte, lt } = buildChangeLogScanBoundsAfter(since);

      const sinceKey = buildChangeLogKey(since, 'column', GEN_A, encodeRawPkIdentity([1]), 'c');
      const nextKey = buildChangeLogKey(next, 'column', GEN_A, encodeRawPkIdentity([1]), 'c');

      // The boundary entry itself is excluded (key < gte).
      expect(compareBytes(sinceKey, gte)).to.be.lessThan(0);
      // The next entry is included (gte <= key < lt).
      expect(compareBytes(nextKey, gte)).to.be.greaterThanOrEqual(0);
      expect(compareBytes(nextKey, lt)).to.be.lessThan(0);
    });

    it('should exclude an equal-(wallTime,counter,site) entry with smaller opSeq', () => {
      const since = createHLC(5000n, 3, siteB, 10);
      const { gte } = buildChangeLogScanBoundsAfter(since);
      const earlier = createHLC(5000n, 3, siteB, 0);
      const earlierKey = buildChangeLogKey(earlier, 'delete', GEN_A, encodeRawPkIdentity([7]));
      expect(compareBytes(earlierKey, gte)).to.be.lessThan(0);
    });

    it('rejects a column name carrying an unpaired surrogate rather than folding it to U+FFFD', () => {
      // Mirrors @quereus/store's catalog-key guard (bug-store-catalog-key-lone-surrogate-
      // identifier-collision): `TextEncoder` folds an unpaired surrogate to U+FFFD, so two
      // distinct column names differing only in a lone surrogate would otherwise share one
      // change-log key. `buildChangeLogKey` guards the column identifier argument via
      // `assertNoUnpairedSurrogate` (imported from `@quereus/store`) before building the
      // key; the table NAME no longer appears in the key at all (see `tg:` below).
      const hlc = createHLC(1000n, 1, siteA, 0);
      const identity = encodeRawPkIdentity([1]);
      expect(() => buildChangeLogKey(hlc, 'column', GEN_A, identity, '\uD800'))
        .to.throw(/unpaired surrogate/i);
    });

    it('should carry from opSeq into siteId when opSeq is at max (0xFFFFFFFF)', () => {
      // The generic last-byte increment must roll all four opSeq bytes to 0 and
      // carry into the low byte of siteId — there is no opSeq beyond max, so the
      // next possible key is (wallTime, counter, siteId+1, opSeq 0).
      const since = createHLC(1000n, 1, siteA, 0xFFFFFFFF);
      const { gte } = buildChangeLogScanBoundsAfter(since);

      // Decode the HLC component of gte (skip the 3-byte 'cl:' prefix).
      const carried = deserializeHLCFromKey(gte.slice(3, 33));
      expect(carried.wallTime).to.equal(1000n);
      expect(carried.counter).to.equal(1);
      expect(carried.opSeq).to.equal(0); // rolled over

      // siteA is [1, 0, …, 0]; the carry lands in the last siteId byte.
      const expectedSite = new Uint8Array(siteA);
      expectedSite[15] = 1;
      expect(Array.from(carried.siteId)).to.deep.equal(Array.from(expectedSite));

      // The boundary fact (max opSeq) is therefore excluded by the scan.
      const boundaryKey = buildChangeLogKey(since, 'column', GEN_A, encodeRawPkIdentity([1]), 'c');
      expect(compareBytes(boundaryKey, gte)).to.be.lessThan(0);
    });
  });

  describe('encodePkIdentity / length-prefixed keys', () => {
    it('bigint and number pks of equal value share one identity (n: tag)', () => {
      expect(encodeRawPkIdentity([5n])).to.equal(encodeRawPkIdentity([5]));
      // The former JSON.stringify encoding threw outright on a bigint pk.
      expect(() => encodeRawPkIdentity([9007199254740993n])).to.not.throw();
    });

    it('normalizers and transforms shape the identity', () => {
      const nocase = { normalizers: [(v: string) => v.toLowerCase()], transforms: [undefined] };
      expect(encodePkIdentity(['APPLE'], nocase)).to.equal(encodePkIdentity(['apple'], nocase));
      const double = { normalizers: [], transforms: [(v: unknown) => (v as number) * 2] };
      expect(encodePkIdentity([2], double)).to.equal(encodePkIdentity([2], double));
      expect(encodePkIdentity([2], double)).to.not.equal(encodePkIdentity([2], RAW_PK_KEYING));
    });

    it('parses identity and column unambiguously even when both contain separators', () => {
      // A string pk containing ':' and a column name containing ':' — the length
      // prefix keeps the split exact where a last-colon split would misparse.
      const identity = encodeRawPkIdentity(['a:b']);
      const key = buildColumnVersionKey(GEN_A, identity, 'col:on');
      const parsed = parseColumnVersionKey(key);
      expect(parsed).to.not.be.null;
      expect(parsed!.generation).to.equal(GEN_A);
      expect(parsed!.identity).to.equal(identity);
      expect(parsed!.column).to.equal('col:on');
    });

    it('null pk members produce a grouping identity, not a poisoned key', () => {
      expect(encodeRawPkIdentity([null])).to.equal(encodeRawPkIdentity([null]));
      expect(encodeRawPkIdentity([null])).to.not.equal(encodeRawPkIdentity(['']));
    });
  });

  describe('buildColumnVersionKey', () => {
    it('rejects a column name carrying an unpaired surrogate', () => {
      const identity = encodeRawPkIdentity([1]);
      expect(() => buildColumnVersionKey(GEN_A, identity, '\uD800')).to.throw(/unpaired surrogate/i);
    });

    it('still builds a key for a clean identifier', () => {
      expect(() => buildColumnVersionKey(GEN_A, encodeRawPkIdentity([1]), 'c')).to.not.throw();
    });
  });

  // Format version 6: the per-row families carry the table's GENERATION, never its
  // name, so a rename moves one `tg:` record and a drop retires one generation
  // without touching a single row record. The name ↔ generation record is the only
  // name-keyed per-table family, and it carries the same length-prefix guarantees
  // the row families used to need for names.
  describe('table generation (tg:) keys', () => {
    const NASTY = ['a:b', 'a.b', 'x:y.z:', '.:', 'a', ''];

    it('the format version is 6 — generation-keyed per-row records', () => {
      expect(SYNC_METADATA_FORMAT_VERSION).to.equal(6);
    });

    it('a minted generation is 22 base64url characters that round-trip through 16 bytes', () => {
      const generation = mintTableGeneration();
      expect(generation).to.match(/^[A-Za-z0-9_-]{22}$/);
      const bytes = tableGenerationToBytes(generation);
      expect(bytes.length).to.equal(16);
      expect(tableGenerationFromBytes(bytes)).to.equal(generation);
      expect(mintTableGeneration(), 'two mints differ').to.not.equal(generation);
    });

    it('parseTableGenerationKey recovers schema and table verbatim', () => {
      for (const schema of NASTY) {
        for (const table of NASTY) {
          const parsed = parseTableGenerationKey(buildTableGenerationKey(schema, table));
          expect(parsed, `tg ${schema}/${table}`).to.not.be.null;
          expect(parsed!).to.deep.equal({ schema, table });
        }
      }
    });

    it('rejects a schema or table name carrying an unpaired surrogate', () => {
      expect(() => buildTableGenerationKey('\uD800', 't')).to.throw(/unpaired surrogate/i);
      expect(() => buildTableGenerationKey('main', '\uD800')).to.throw(/unpaired surrogate/i);
    });

    it('every tg: key falls inside the all-generations scan bounds and no cv: key does', () => {
      const within = (key: Uint8Array, bounds: { gte: Uint8Array; lt: Uint8Array }): boolean =>
        compareBytes(key, bounds.gte) >= 0 && compareBytes(key, bounds.lt) < 0;
      const all = buildAllTableGenerationScanBounds();
      expect(within(buildTableGenerationKey('main', 'orders'), all)).to.be.true;
      expect(within(buildTableGenerationKey('', ''), all)).to.be.true;
      expect(within(buildColumnVersionKey(GEN_A, encodeRawPkIdentity([1]), 'c'), all)).to.be.false;
    });

    it('parsers reject a foreign prefix, a truncated key, and trailing bytes', () => {
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
      expect(parseTableGenerationKey(enc('tb:4:main1:t'))).to.be.null;
      expect(parseTableGenerationKey(enc('tg:99:main'))).to.be.null;
      expect(parseTableGenerationKey(enc('tg:4:main1:t!'))).to.be.null;
    });
  });

  // The pk identity and column are arbitrary text: a pk identity freely contains `:`
  // (type tags) and `\0`, and `create table t ("a:b" text)` is legal SQL. Every
  // component is length-prefixed, so none of that can shift a parse.
  describe('separator-bearing components round-trip through every per-row key family', () => {
    const NASTY = ['a:b', 'a.b', 'x:y.z:', '.:', 'a'];

    it('parseColumnVersionKey recovers every component verbatim', () => {
      for (const generation of [GEN_A, GEN_B]) {
        const identity = encodeRawPkIdentity([`pk:${generation}.`]);
        for (const column of NASTY) {
          const parsed = parseColumnVersionKey(buildColumnVersionKey(generation, identity, column));
          expect(parsed, `cv ${generation}/${column}`).to.not.be.null;
          expect(parsed!).to.deep.equal({ generation, identity, column });
        }
      }
    });

    it('parseTombstoneKey recovers every component verbatim (no cross-generation misattribution)', () => {
      for (const generation of [GEN_A, GEN_B]) {
        for (const pk of NASTY) {
          const identity = encodeRawPkIdentity([pk]);
          const parsed = parseTombstoneKey(buildTombstoneKey(generation, identity));
          expect(parsed, `tb ${generation}/${pk}`).to.not.be.null;
          expect(parsed!).to.deep.equal({ generation, identity });
        }
      }
    });

    it('parseSchemaMigrationKey recovers schema, kind, object name and version', () => {
      for (const schema of NASTY) {
        for (const table of NASTY) {
          for (const kind of ['table', 'index'] as const) {
            const parsed = parseSchemaMigrationKey(buildSchemaMigrationKey(schema, kind, table, 7));
            expect(parsed, `sm ${schema}/${kind}/${table}`).to.not.be.null;
            expect(parsed!).to.deep.equal({ schema, kind, table, version: 7 });
          }
        }
      }
    });

    it('a table and a same-named index key to different sm: records', () => {
      // The defect this layout removes: with the kind absent from the key, an
      // index named `orders` shared table `orders`'s version counter, so one
      // object's migration silently suppressed the other's on a peer.
      const tableKey = buildSchemaMigrationKey('main', 'table', 'orders', 1);
      const indexKey = buildSchemaMigrationKey('main', 'index', 'orders', 1);
      expect(compareBytes(tableKey, indexKey), 'distinct keys').to.not.equal(0);

      expect(parseSchemaMigrationKey(tableKey)!.kind).to.equal('table');
      expect(parseSchemaMigrationKey(indexKey)!.kind).to.equal('index');
    });

    it('parseChangeLogKey recovers every component verbatim, column and delete alike', () => {
      const hlc = createHLC(1000n, 1, siteA, 0);
      for (const generation of [GEN_A, GEN_B]) {
        const identity = encodeRawPkIdentity(['a:b.c']);
        for (const column of NASTY) {
          const parsed = parseChangeLogKey(
            buildChangeLogKey(hlc, 'column', generation, identity, column));
          expect(parsed, `cl column ${generation}/${column}`).to.not.be.null;
          expect(parsed!.generation).to.equal(generation);
          expect(parsed!.identity).to.equal(identity);
          expect(parsed!.column).to.equal(column);
        }

        const del = parseChangeLogKey(buildChangeLogKey(hlc, 'delete', generation, identity));
        expect(del, `cl delete ${generation}`).to.not.be.null;
        expect(del!.generation).to.equal(generation);
        expect(del!.identity).to.equal(identity);
        expect(del!.column).to.be.undefined;
      }
    });
  });

  describe('empty components and malformed keys', () => {
    it('a zero-length column still round-trips as a present component', () => {
      // The builders test `column !== undefined`, not truthiness: an empty column
      // must still emit its (empty) component, or a `column` entry would carry 2
      // parts where the parser demands 3 and read back as unparseable.
      const identity = encodeRawPkIdentity([1]);
      const cv = parseColumnVersionKey(buildColumnVersionKey(GEN_A, identity, ''));
      expect(cv!.column).to.equal('');

      const hlc = createHLC(1000n, 1, siteA, 0);
      const cl = parseChangeLogKey(buildChangeLogKey(hlc, 'column', GEN_A, identity, ''));
      expect(cl, 'an empty column name is still a parseable column entry').to.not.be.null;
      expect(cl!.column).to.equal('');
      expect(cl!.identity).to.equal(identity);
    });

    it('empty identity and column round-trip', () => {
      const cv = parseColumnVersionKey(buildColumnVersionKey(GEN_A, '', ''));
      expect(cv!).to.deep.equal({ generation: GEN_A, identity: '', column: '' });
      expect(parseTombstoneKey(buildTombstoneKey(GEN_A, ''))!)
        .to.deep.equal({ generation: GEN_A, identity: '' });
    });

    it('parsers reject a foreign prefix, a truncated key, and the older layouts', () => {
      const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
      // Wrong family.
      expect(parseColumnVersionKey(enc('tb:4:main1:t'))).to.be.null;
      // Length runs past the end of the key.
      expect(parseColumnVersionKey(enc('cv:99:main'))).to.be.null;
      // Non-numeric length, and a leading separator.
      expect(parseTombstoneKey(enc('tb:x:main'))).to.be.null;
      expect(parseTombstoneKey(enc('tb::main'))).to.be.null;
      // Trailing bytes beyond the declared components.
      expect(parseTombstoneKey(enc('tb:1:a1:b!'))).to.be.null;
      // A version-2 key (bare `.`/`:` layout) must not read back as version 6.
      expect(parseColumnVersionKey(enc('cv:main.t:3:s:1:v'))).to.be.null;
      expect(parseTombstoneKey(enc('tb:main.t:s:1'))).to.be.null;
      // A version-5 key (name-keyed: schema, table, identity, column — FOUR parts for
      // a cell) must not read back as version 6 (generation, identity, column — three):
      // its extra component is trailing garbage to the three-part parser.
      expect(parseColumnVersionKey(enc('cv:4:main1:t3:s:11:v'))).to.be.null;
      expect(parseTombstoneKey(enc('tb:4:main1:t3:s:1'))).to.be.null;
      expect(parseSchemaMigrationKey(enc('sm:main.t:0000000007'))).to.be.null;
      // A version-3 sm: key (length-prefixed, but no object kind) must not read
      // back as version 4 — its `t` would otherwise parse as the kind component.
      expect(parseSchemaMigrationKey(enc('sm:4:main1:t0000000007'))).to.be.null;
      // Nor may an unknown kind component parse.
      expect(parseSchemaMigrationKey(enc('sm:4:main4:view1:t0000000007'))).to.be.null;
    });
  });

  describe('scan bounds stay exact per generation and per row', () => {
    const within = (key: Uint8Array, bounds: { gte: Uint8Array; lt: Uint8Array }): boolean =>
      compareBytes(key, bounds.gte) >= 0 && compareBytes(key, bounds.lt) < 0;

    const identity = encodeRawPkIdentity([1]);

    it('two generations do not share cv: bounds', () => {
      const keyA = buildColumnVersionKey(GEN_A, identity, 'v');
      const keyB = buildColumnVersionKey(GEN_B, identity, 'v');

      const boundsA = buildTableColumnVersionScanBounds(GEN_A);
      const boundsB = buildTableColumnVersionScanBounds(GEN_B);

      expect(within(keyA, boundsA), 'A in its own bounds').to.be.true;
      expect(within(keyB, boundsB), 'B in its own bounds').to.be.true;
      expect(within(keyB, boundsA), 'B must NOT scan under A').to.be.false;
      expect(within(keyA, boundsB), 'A must NOT scan under B').to.be.false;
    });

    it('tb: bounds are likewise disjoint per generation, and sm: bounds per name', () => {
      const tbA = buildTombstoneKey(GEN_A, identity);
      const tbB = buildTombstoneKey(GEN_B, identity);
      expect(within(tbA, buildTombstoneScanBounds(GEN_A))).to.be.true;
      expect(within(tbB, buildTombstoneScanBounds(GEN_A))).to.be.false;
      expect(within(tbA, buildTombstoneScanBounds(GEN_B))).to.be.false;

      // Sibling names chosen so a bare-`.`/bare-`:` layout would overlap: `a`'s
      // prefix `…a:` is a prefix of `a:b`'s `…a:b:` under the old encoding.
      const smA = buildSchemaMigrationKey('main', 'table', 'a', 1);
      const smAB = buildSchemaMigrationKey('main', 'table', 'a:b', 1);
      expect(within(smA, buildSchemaMigrationScanBounds('main', 'table', 'a'))).to.be.true;
      expect(within(smAB, buildSchemaMigrationScanBounds('main', 'table', 'a'))).to.be.false;
      expect(within(smA, buildSchemaMigrationScanBounds('main', 'table', 'a:b'))).to.be.false;
    });

    it('sm: bounds for a table and a same-named index are disjoint', () => {
      const smTable = buildSchemaMigrationKey('main', 'table', 'orders', 1);
      const smIndex = buildSchemaMigrationKey('main', 'index', 'orders', 1);
      const tableBounds = buildSchemaMigrationScanBounds('main', 'table', 'orders');
      const indexBounds = buildSchemaMigrationScanBounds('main', 'index', 'orders');

      expect(within(smTable, tableBounds), 'table key in table bounds').to.be.true;
      expect(within(smIndex, indexBounds), 'index key in index bounds').to.be.true;
      expect(within(smIndex, tableBounds), 'index key must NOT scan as the table').to.be.false;
      expect(within(smTable, indexBounds), 'table key must NOT scan as the index').to.be.false;
    });

    it('a row scan does not pick up a different row whose identity extends it', () => {
      // encodeRawPkIdentity('a') vs 'ab': one identity is a prefix of the other.
      const idA = encodeRawPkIdentity(['a']);
      const idAB = encodeRawPkIdentity(['ab']);
      const keyA = buildColumnVersionKey(GEN_A, idA, 'v');
      const keyAB = buildColumnVersionKey(GEN_A, idAB, 'v');

      expect(within(keyA, buildColumnVersionScanBounds(GEN_A, idA))).to.be.true;
      expect(within(keyAB, buildColumnVersionScanBounds(GEN_A, idA))).to.be.false;
      expect(within(keyA, buildColumnVersionScanBounds(GEN_A, idAB))).to.be.false;
    });

    it('the schema-only quarantine prefix cannot match a different schema', () => {
      const hlc = createHLC(1000n, 1, siteA, 0);
      const inS = buildQuarantineKey('s', 't', hlc, 'column', [1], 'v');
      const inSx = buildQuarantineKey('s:x', 't', hlc, 'column', [1], 'v');

      expect(within(inS, buildQuarantineScanBounds('s')), '"s" entry under schema "s"').to.be.true;
      expect(within(inSx, buildQuarantineScanBounds('s')), '"s:x" must NOT scan under "s"').to.be.false;
      expect(within(inSx, buildQuarantineScanBounds('s:x'))).to.be.true;

      // Per-table form: table "t" must not swallow table "t:u".
      const inTU = buildQuarantineKey('s', 't:u', hlc, 'column', [1], 'v');
      expect(within(inS, buildQuarantineScanBounds('s', 't'))).to.be.true;
      expect(within(inTU, buildQuarantineScanBounds('s', 't'))).to.be.false;

      // The no-argument (GC sweep) form still covers everything.
      const all = buildQuarantineScanBounds();
      expect(within(inS, all) && within(inSx, all) && within(inTU, all)).to.be.true;
    });
  });
});
