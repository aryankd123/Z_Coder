'use strict';

/**
 * Configuration: the ONLY place that reads process.env.
 *
 * Every variable is validated with zod at boot. If anything required is
 * missing or malformed, loadConfig() throws and the server refuses to start.
 * There are no silent fallbacks such as `secret || "unknown"`.
 *
 * Error messages name the variable and the rule it broke, but never echo
 * the value, so a mistyped secret can't end up in logs.
 */
const { z } = require('zod');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // Required: no defaults, so a missing value stops the boot.
  MONGODB_URI: z
    .string({ error: 'is required' })
    .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  JWT_ACCESS_SECRET: z
    .string({ error: 'is required' })
    .min(32, 'must be at least 32 characters (generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))")'),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),

  // Comma-separated list of browser origins allowed to call the API directly.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  // Number of reverse proxies in front of the API (Render = 1). Needed so
  // req.ip is the real client IP, which the per-IP rate limits depend on.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  // Per 15 minutes. Generous because a campus NAT puts many users on one IP.
  AUTH_RATE_LIMIT_PER_IP: z.coerce.number().int().min(1).default(50),
  LOGIN_FAILURES_PER_EMAIL: z.coerce.number().int().min(1).default(5),
  // Wrong room passwords per user per 15 minutes (stops password guessing on a room).
  ROOM_JOIN_FAILURES_PER_USER: z.coerce.number().int().min(1).default(10),
  // Chat messages per user per 10 seconds, across all of that user's sockets.
  CHAT_MESSAGES_PER_10S: z.coerce.number().int().min(1).default(20),
  // Save a room's Yjs document this long after the last edit (debounce).
  YJS_PERSIST_DEBOUNCE_MS: z.coerce.number().int().min(10).max(60_000).default(2000),

  // ---- code execution ----
  // local  = child processes on this machine, NO sandbox (development only;
  //          refused when NODE_ENV=production, see the check below)
  // judge0 = Judge0 API called from the server (RapidAPI or self-hosted)
  EXECUTOR: z.enum(['local', 'judge0']).default('local'),
  EXECUTION_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // Backpressure: at most this many runs waiting; beyond that, 503 QUEUE_FULL.
  EXECUTION_QUEUE_MAX: z.coerce.number().int().min(1).max(10_000).default(50),
  EXECUTIONS_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  RUN_TIMEOUT_MS: z.coerce.number().int().min(100).max(15_000).default(3000),
  COMPILE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(20_000),
  RUN_MEMORY_MB: z.coerce.number().int().min(32).max(512).default(256),
  JUDGE0_URL: z.url().default('https://judge0-ce.p.rapidapi.com'),
  // `KEY=` (empty, as in .env.example) means "not set".
  JUDGE0_RAPIDAPI_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  JUDGE0_AUTH_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  // Local executor toolchain (dev). Windows' Python launcher is `python`.
  LOCAL_CXX: z.string().min(1).default('g++'),
  LOCAL_PYTHON: z.string().min(1).default(process.platform === 'win32' ? 'python' : 'python3'),
}).superRefine((e, ctx) => {
  if (e.EXECUTOR === 'local' && e.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['EXECUTOR'],
      message: 'local runs user code without a sandbox and is refused in production; use EXECUTOR=judge0',
    });
  }
  if (e.EXECUTOR === 'judge0' && /rapidapi\.com$/i.test(new URL(e.JUDGE0_URL).hostname) && !e.JUDGE0_RAPIDAPI_KEY) {
    ctx.addIssue({ code: 'custom', path: ['JUDGE0_RAPIDAPI_KEY'], message: 'is required when JUDGE0_URL is a RapidAPI host' });
  }
});

/**
 * Parse and validate configuration from an env-like object.
 * @param {Record<string, string | undefined>} env usually process.env
 * @returns {Readonly<ReturnType<typeof toConfig>>}
 * @throws {Error} listing every invalid variable (names only, never values)
 */
function loadConfig(env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration, refusing to start:\n${lines.join('\n')}`);
  }
  return toConfig(result.data);
}

/** Convert validated env vars into a camelCase, frozen config object. */
function toConfig(e) {
  const isProduction = e.NODE_ENV === 'production';
  return Object.freeze({
    env: e.NODE_ENV,
    isProduction,
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    mongodbUri: e.MONGODB_URI,
    jwtAccessSecret: e.JWT_ACCESS_SECRET,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlMs: e.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    bcryptCost: e.BCRYPT_COST,
    corsOrigins: Object.freeze(e.CORS_ORIGINS),
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL,
    yjsPersistDebounceMs: e.YJS_PERSIST_DEBOUNCE_MS,
    execution: Object.freeze({
      executor: e.EXECUTOR,
      concurrency: e.EXECUTION_CONCURRENCY,
      queueMax: e.EXECUTION_QUEUE_MAX,
      perMinute: e.EXECUTIONS_PER_MINUTE,
      limits: Object.freeze({
        runTimeoutMs: e.RUN_TIMEOUT_MS,
        compileTimeoutMs: e.COMPILE_TIMEOUT_MS,
        memoryMb: e.RUN_MEMORY_MB,
        outputBytes: 64 * 1024,
      }),
      judge0: Object.freeze({ url: e.JUDGE0_URL, rapidApiKey: e.JUDGE0_RAPIDAPI_KEY, authToken: e.JUDGE0_AUTH_TOKEN }),
      local: Object.freeze({ cxx: e.LOCAL_CXX, python: e.LOCAL_PYTHON }),
    }),
    // Secure cookies need HTTPS. Browsers treat http://localhost as secure, but
    // we only force it in production, where the site is always HTTPS.
    cookieSecure: isProduction,
    rateLimits: Object.freeze({
      authPerIp: e.AUTH_RATE_LIMIT_PER_IP,
      loginFailuresPerEmail: e.LOGIN_FAILURES_PER_EMAIL,
      roomJoinFailuresPerUser: e.ROOM_JOIN_FAILURES_PER_USER,
      chatMessagesPer10s: e.CHAT_MESSAGES_PER_10S,
    }),
  });
}

let cached;

/**
 * The process-wide config, loaded from process.env on first use.
 * @returns {ReturnType<typeof toConfig>}
 */
function getConfig() {
  if (!cached) cached = loadConfig(process.env);
  return cached;
}

module.exports = { loadConfig, getConfig };
