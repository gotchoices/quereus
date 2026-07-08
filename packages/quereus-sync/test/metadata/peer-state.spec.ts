/**
 * Tests for PeerStateStore, in particular the `ps:` key round-trip that
 * getAllPeers() depends on to reconstruct a peer's SiteId from the key.
 */

import { expect } from 'chai';
import { InMemoryKVStore } from '@quereus/store';
import { PeerStateStore } from '../../src/metadata/peer-state.js';
import { buildPeerStateKey, base64UrlToSiteId } from '../../src/metadata/keys.js';
import { generateSiteId, siteIdEquals } from '../../src/clock/site.js';
import { createHLC } from '../../src/clock/hlc.js';

describe('PeerStateStore', () => {
  describe('buildPeerStateKey / base64UrlToSiteId', () => {
    it('should round-trip a site id through the ps: key encoding', () => {
      const siteId = generateSiteId();
      const key = buildPeerStateKey(siteId);
      const keyStr = new TextDecoder().decode(key);
      expect(keyStr.startsWith('ps:')).to.be.true;

      const decoded = base64UrlToSiteId(keyStr.slice(3));
      expect(siteIdEquals(decoded, siteId)).to.be.true;
    });
  });

  describe('getAllPeers', () => {
    it('should yield back the exact SiteId used to set each peer state', async () => {
      const kv = new InMemoryKVStore();
      const store = new PeerStateStore(kv);

      const siteA = generateSiteId();
      const siteB = generateSiteId();
      const hlc = createHLC(1000n, 0, siteA, 0);

      await store.setPeerState(siteA, hlc);
      await store.setPeerState(siteB, hlc);

      const seen: Uint8Array[] = [];
      for await (const { siteId } of store.getAllPeers()) {
        seen.push(siteId);
      }

      expect(seen.length).to.equal(2);
      expect(seen.some(s => siteIdEquals(s, siteA))).to.be.true;
      expect(seen.some(s => siteIdEquals(s, siteB))).to.be.true;
    });
  });
});
