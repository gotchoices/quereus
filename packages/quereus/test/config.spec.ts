import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import {
  interpolateEnvVars,
  interpolateConfigEnvVars,
  validateConfig,
  type QuoombConfig
} from '@quereus/plugin-loader';

describe('Config Loader', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  describe('interpolateEnvVars', () => {
    it('should interpolate simple environment variables', () => {
      const env = { PORT: '8080', HOST: 'localhost' };
      const value = 'http://${HOST}:${PORT}';
      const result = interpolateEnvVars(value, env);
      expect(result).to.equal('http://localhost:8080');
    });

    it('should use default values when variable is not set', () => {
      const env = { PORT: '8080' };
      const value = '${HOST:-localhost}:${PORT}';
      const result = interpolateEnvVars(value, env);
      expect(result).to.equal('localhost:8080');
    });

    it('should handle nested objects', () => {
      const env = { API_KEY: 'secret123' };
      const value = {
        url: 'https://api.example.com',
        key: '${API_KEY}',
        nested: {
          token: '${TOKEN:-default-token}'
        }
      };
      const result = interpolateEnvVars(value, env);
      expect(result).to.deep.equal({
        url: 'https://api.example.com',
        key: 'secret123',
        nested: {
          token: 'default-token'
        }
      });
    });

    it('should handle arrays', () => {
      const env = { PORT: '8080' };
      const value = ['${HOST:-localhost}', '${PORT}', 'static'];
      const result = interpolateEnvVars(value, env);
      expect(result).to.deep.equal(['localhost', '8080', 'static']);
    });

    it('should leave non-string values unchanged', () => {
      const env = { NUM: '42' };
      const value = { count: 42, enabled: true, data: null };
      const result = interpolateEnvVars(value, env);
      expect(result).to.deep.equal({ count: 42, enabled: true, data: null });
    });

    it('should handle missing variables without defaults', () => {
      const env = {};
      const value = '${MISSING}';
      const result = interpolateEnvVars(value, env);
      expect(result).to.equal('${MISSING}');
    });
  });

  describe('interpolateConfigEnvVars', () => {
    it('should interpolate config with environment variables', () => {
      const env = { OPTIMYSTIC_PORT: '8011', NETWORK_NAME: 'test-mesh' };
      const config: QuoombConfig = {
        plugins: [
          {
            source: 'npm:@optimystic/quereus-plugin-optimystic',
            config: {
              port: '${OPTIMYSTIC_PORT}',
              networkName: '${NETWORK_NAME}'
            }
          }
        ]
      };
      const result = interpolateConfigEnvVars(config, env);
      expect(result.plugins?.[0].config).to.deep.equal({
        port: '8011',
        networkName: 'test-mesh'
      });
    });

    it('should use defaults when env vars are not set', () => {
      const env = {};
      const config: QuoombConfig = {
        plugins: [
          {
            source: 'npm:@optimystic/quereus-plugin-optimystic',
            config: {
              port: '${OPTIMYSTIC_PORT:-8011}',
              networkName: '${NETWORK_NAME:-optimystic-dev}'
            }
          }
        ]
      };
      const result = interpolateConfigEnvVars(config, env);
      expect(result.plugins?.[0].config).to.deep.equal({
        port: '8011',
        networkName: 'optimystic-dev'
      });
    });
  });

  describe('validateConfig', () => {
    it('should validate a valid config', () => {
      const config: QuoombConfig = {
        plugins: [
          {
            source: 'npm:@scope/plugin',
            config: { key: 'value' }
          }
        ],
        autoload: true
      };
      expect(validateConfig(config)).to.be.true;
    });

    it('should validate config with no plugins', () => {
      const config: QuoombConfig = {
        autoload: true
      };
      expect(validateConfig(config)).to.be.true;
    });

    it('should validate config with empty plugins array', () => {
      const config: QuoombConfig = {
        plugins: [],
        autoload: false
      };
      expect(validateConfig(config)).to.be.true;
    });

    it('should reject non-object config', () => {
      expect(validateConfig(null)).to.be.false;
      expect(validateConfig('string')).to.be.false;
      expect(validateConfig(123)).to.be.false;
    });

    it('should reject config with invalid plugins array', () => {
      const config = {
        plugins: 'not-an-array'
      };
      expect(validateConfig(config)).to.be.false;
    });

    it('should reject plugin without source', () => {
      const config = {
        plugins: [
          {
            config: { key: 'value' }
          }
        ]
      };
      expect(validateConfig(config)).to.be.false;
    });

    it('should reject config with invalid autoload', () => {
      const config = {
        plugins: [],
        autoload: 'yes'
      };
      expect(validateConfig(config)).to.be.false;
    });

    it('should reject plugin with invalid config', () => {
      const config = {
        plugins: [
          {
            source: 'npm:@scope/plugin',
            config: 'not-an-object'
          }
        ]
      };
      expect(validateConfig(config)).to.be.false;
    });
  });
});

