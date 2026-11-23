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
    const c = loadConfig({ ...minimal, NODE_ENV: 'production', CORS_ORIGINS: 'https://a.app, https://b.app' });
    expect(c.corsOrigins).toEqual(['https://a.app', 'https://b.app']);
    expect(c.isProduction).toBe(true);
    expect(c.cookieSecure).toBe(true);
  });
});
