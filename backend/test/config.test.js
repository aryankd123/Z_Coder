'use strict';

const { loadConfig } = require('../src/config');

const minimal = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/zcoder',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  test('applies safe defaults', () => {
    const c = loadConfig(minimal);
    expect(c).toMatchObject({
      env: 'development',
      port: 4000,
      accessTokenTtlSeconds: 900,
      bcryptCost: 12,
      corsOrigins: ['http://localhost:3000'],
      cookieSecure: false,
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  test('refuses to start without required secrets, naming every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/MONGODB_URI[\s\S]*JWT_ACCESS_SECRET|JWT_ACCESS_SECRET[\s\S]*MONGODB_URI/);
  });

  test('rejects a short JWT secret WITHOUT echoing the secret', () => {
    const secret = 'too-short-but-still-secret';
    expect.assertions(2);
    try {
      loadConfig({ ...minimal, JWT_ACCESS_SECRET: secret });
    } catch (err) {
      expect(err.message).toMatch(/JWT_ACCESS_SECRET: must be at least 32 characters/);
      expect(err.message).not.toContain(secret);
    }
  });

  test('rejects a non-MongoDB URI', () => {
    expect(() => loadConfig({ ...minimal, MONGODB_URI: 'postgres://x' })).toThrow(/MONGODB_URI/);
  });

  test('parses a comma-separated CORS allowlist and production flags', () => {
    const c = loadConfig({
      ...minimal,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://a.app, https://b.app',
      EXECUTOR: 'judge0',
      JUDGE0_URL: 'https://judge0.internal.example',
    });
    expect(c.corsOrigins).toEqual(['https://a.app', 'https://b.app']);
    expect(c.isProduction).toBe(true);
    expect(c.cookieSecure).toBe(true);
  });

  describe('code execution', () => {
    test('defaults to the local executor in development', () => {
      expect(loadConfig(minimal).execution).toMatchObject({ executor: 'local', concurrency: 2, perMinute: 10 });
    });

    test('REFUSES the unsandboxed local executor in production, including by default', () => {
      expect(() => loadConfig({ ...minimal, NODE_ENV: 'production' })).toThrow(/EXECUTOR: local runs user code without a sandbox/);
      expect(() => loadConfig({ ...minimal, NODE_ENV: 'production', EXECUTOR: 'local' })).toThrow(/refused in production/);
    });

    test('an empty key line (as copied from .env.example) counts as unset', () => {
      expect(loadConfig({ ...minimal, JUDGE0_RAPIDAPI_KEY: '', JUDGE0_AUTH_TOKEN: '' }).execution.judge0.rapidApiKey).toBeUndefined();
      expect(() => loadConfig({ ...minimal, EXECUTOR: 'judge0', JUDGE0_RAPIDAPI_KEY: '' })).toThrow(/JUDGE0_RAPIDAPI_KEY: is required/);
    });

    test('Judge0 on RapidAPI needs a key; a self-hosted Judge0 does not; the key is never echoed', () => {
      expect(() => loadConfig({ ...minimal, EXECUTOR: 'judge0' })).toThrow(/JUDGE0_RAPIDAPI_KEY: is required/);
      const key = 'rapidapi-key-that-must-not-be-echoed';
      const c = loadConfig({ ...minimal, EXECUTOR: 'judge0', JUDGE0_RAPIDAPI_KEY: key });
      expect(c.execution.judge0.rapidApiKey).toBe(key);
      expect(loadConfig({ ...minimal, EXECUTOR: 'judge0', JUDGE0_URL: 'http://localhost:2358' }).execution.executor).toBe('judge0');
      try {
        loadConfig({ ...minimal, EXECUTOR: 'judge0', JUDGE0_RAPIDAPI_KEY: key, RUN_TIMEOUT_MS: '1' });
      } catch (err) {
        expect(err.message).not.toContain(key);
      }
    });
  });
});
