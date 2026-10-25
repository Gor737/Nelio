/**
 * Validated configuration (docs/architecture.md section 20, roadmap M6): the application refuses to boot with missing or
 * weak secrets. Error messages name the variable and the rule, never the value.
 *
 * Variables
 *   NODE_ENV          development | test | production            (default development)
 *   PORT              1-65535                                    (default 3000)
 *   DATABASE_URL      postgres:// or postgresql:// URL           (required in production; elsewhere it may be built
 *                     from POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB and optionally POSTGRES_HOST/POSTGRES_PORT,
 *                     the variables docker-compose.yml reads)
 *   JWT_SECRET        at least 32 bytes, not a placeholder       (required everywhere)
 *   FRONTEND_ORIGIN   one origin, no path, no "*"                (required in production; default http://localhost:3001)
 *   TRUST_PROXY       number of reverse proxies in front, 0-10   (default 0 = do not trust X-Forwarded-*)
 *   LOG_LEVEL         debug | info | warn | error                (default info)
 *   SWAGGER_ENABLED   true | false                               (default true outside production, false in production)
 */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly frontendOrigin: string;
  readonly trustProxy: number;
  readonly logLevel: LogLevel;
  readonly swaggerEnabled: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid configuration (the application will not start):\n - ${problems.join('\n - ')}`,
    );
    this.name = 'ConfigError';
  }
}

const DEV_FRONTEND_ORIGIN = 'http://localhost:3001';
const PLACEHOLDER =
  /change[_-]?me|placeholder|example|secret-here|your[_-]?secret|^(.)\1+$/i;

function integer(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
  fallback: number,
  problems: string[],
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return Number(raw);
}

function composeDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const { POSTGRES_USER: user, POSTGRES_PASSWORD: password } = env;
  if (!user || !password) return undefined;
  const host = env.POSTGRES_HOST ?? 'localhost';
  const port = env.POSTGRES_PORT ?? '5433';
  const database = env.POSTGRES_DB ?? 'nelio';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const rawEnv = env.NODE_ENV ?? 'development';
  let nodeEnv: NodeEnv = 'development';
  if ((NODE_ENVS as readonly string[]).includes(rawEnv))
    nodeEnv = rawEnv as NodeEnv;
  else problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);
  const production = nodeEnv === 'production';

  const port = integer(env.PORT, 'PORT', 1, 65535, 3000, problems);
  const trustProxy = integer(
    env.TRUST_PROXY,
    'TRUST_PROXY',
    0,
    10,
    0,
    problems,
  );

  let databaseUrl = env.DATABASE_URL;
  if (!databaseUrl && !production) databaseUrl = composeDatabaseUrl(env);
  if (!databaseUrl) {
    problems.push(
      production
        ? 'DATABASE_URL is required in production'
        : 'DATABASE_URL is required (or POSTGRES_USER and POSTGRES_PASSWORD outside production)',
    );
    databaseUrl = '';
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must start with postgres:// or postgresql://');
  }

  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret === '') problems.push('JWT_SECRET is required');
  else if (Buffer.byteLength(jwtSecret) < 32)
    problems.push(
      'JWT_SECRET must be at least 32 bytes (use 48 random bytes, base64-encoded)',
    );
  else if (PLACEHOLDER.test(jwtSecret))
    problems.push(
      'JWT_SECRET looks like a placeholder; generate a random value',
    );

  let frontendOrigin = env.FRONTEND_ORIGIN ?? '';
  if (frontendOrigin === '') {
    if (production) problems.push('FRONTEND_ORIGIN is required in production');
    frontendOrigin = DEV_FRONTEND_ORIGIN;
  } else {
    try {
      const parsed = new URL(frontendOrigin);
      const isOrigin =
        ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.origin === frontendOrigin.replace(/\/$/, '');
      if (!isOrigin)
        problems.push(
          'FRONTEND_ORIGIN must be a single http(s) origin without a path, for example https://app.example.com',
        );
      else frontendOrigin = parsed.origin;
    } catch {
      problems.push(
        'FRONTEND_ORIGIN must be a valid origin URL ("*" is not allowed: credentials are enabled)',
      );
    }
  }

  const logLevel = (env.LOG_LEVEL ?? 'info') as LogLevel;
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel))
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  let swaggerEnabled = !production;
  if (env.SWAGGER_ENABLED !== undefined && env.SWAGGER_ENABLED !== '') {
    if (['true', 'false'].includes(env.SWAGGER_ENABLED))
      swaggerEnabled = env.SWAGGER_ENABLED === 'true';
    else problems.push('SWAGGER_ENABLED must be true or false');
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    nodeEnv,
    port,
    databaseUrl,
    jwtSecret,
    frontendOrigin,
    trustProxy,
    logLevel,
    swaggerEnabled,
  };
}
