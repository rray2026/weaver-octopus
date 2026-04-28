import { afterEach, describe, expect, it } from 'vitest';
import { optionalEnv, requireEnv } from './env.js';

describe('env', () => {
  afterEach(() => {
    delete process.env['TEST_VAR'];
  });

  describe('requireEnv', () => {
    it('returns the value when set', () => {
      process.env['TEST_VAR'] = 'hello';
      expect(requireEnv('TEST_VAR')).toBe('hello');
    });

    it('throws when missing', () => {
      expect(() => requireEnv('TEST_VAR')).toThrow('Missing required environment variable: TEST_VAR');
    });

    it('throws when empty string', () => {
      process.env['TEST_VAR'] = '';
      expect(() => requireEnv('TEST_VAR')).toThrow('Missing required environment variable: TEST_VAR');
    });
  });

  describe('optionalEnv', () => {
    it('returns the value when set', () => {
      process.env['TEST_VAR'] = 'world';
      expect(optionalEnv('TEST_VAR', 'default')).toBe('world');
    });

    it('returns default when missing', () => {
      expect(optionalEnv('TEST_VAR', 'default')).toBe('default');
    });
  });
});
