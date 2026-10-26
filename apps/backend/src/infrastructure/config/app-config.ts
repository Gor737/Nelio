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
 *   SMTP_HOST         host name                                  (required in production; default 127.0.0.1 = Mailpit)
 *   SMTP_PORT         1-65535                                    (default 1025 = Mailpit)
 *   SMTP_SECURE       true | false  implicit TLS (port 465)      (default false; STARTTLS is used when the server offers it)
 *   SMTP_USER, SMTP_PASSWORD   both or neither                   (optional; the password is never logged)
 *   MAIL_FROM         sender address, "Name <a@b>" or "a@b"      (required in production; default Nelio <no-reply@nelio.local>)
 *   S3_ENDPOINT       http(s) URL of the S3-compatible store     (default http://127.0.0.1:9000 = MinIO; optional in production, where it
 *                     may be left out for AWS S3)
 *   S3_REGION         region name                                (default us-east-1)
 *   S3_BUCKET         bucket name                                (required in production; default nelio-files)
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY   credentials         (required in production, both; outside production they default to
 *                     MINIO_ROOT_USER and MINIO_ROOT_PASSWORD, and when neither is set file storage is simply "not configured"
 *                     and the Files endpoints answer 503; the secret is never logged)
 *   S3_FORCE_PATH_STYLE  true | false                            (default true when an endpoint is set, as MinIO needs)
 *   S3_PUBLIC_BASE_URL   public URL of the bucket root           (required in production; default <endpoint>/<bucket>)
 */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface MailConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly password: string | undefined;
  readonly from: string;
}

export interface StorageConfig {
  readonly endpoint: string | undefined;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  readonly forcePathStyle: boolean;
  /** Where objects under `public/` can be read without a signature, without a trailing slash. */
  readonly publicBaseUrl: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly frontendOrigin: string;
  readonly trustProxy: number;
  readonly logLevel: LogLevel;
  readonly swaggerEnabled: boolean;
  readonly mail: MailConfig;
  readonly storage: StorageConfig;
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
const DEV_MAIL_FROM = 'Nelio <no-reply@nelio.local>';
/** The numeric loopback address, not the name `localhost`: resolving the name stalled the first SMTP connection by about 5 s. */
const DEV_SMTP_HOST = '127.0.0.1';
/** MinIO from docker-compose.yml; the numeric address for the same reason as the SMTP host. */
const DEV_S3_ENDPOINT = 'http://127.0.0.1:9000';
const DEV_S3_BUCKET = 'nelio-files';
/** `a@b.c` or `Display Name <a@b.c>`; no line breaks (header injection) and exactly one address. */
const MAIL_FROM = /^(?:[^<>\r\n@]+ <[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/;
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

  const smtpHost = env.SMTP_HOST ?? '';
  if (smtpHost === '' && production)
    problems.push('SMTP_HOST is required in production');
  const smtpPort = integer(
    env.SMTP_PORT,
    'SMTP_PORT',
    1,
    65535,
    1025,
    problems,
  );
  let smtpSecure = false;
  if (env.SMTP_SECURE !== undefined && env.SMTP_SECURE !== '') {
    if (['true', 'false'].includes(env.SMTP_SECURE))
      smtpSecure = env.SMTP_SECURE === 'true';
    else problems.push('SMTP_SECURE must be true or false');
  }
  const smtpUser = env.SMTP_USER === '' ? undefined : env.SMTP_USER;
  const smtpPassword = env.SMTP_PASSWORD === '' ? undefined : env.SMTP_PASSWORD;
  if ((smtpUser === undefined) !== (smtpPassword === undefined))
    problems.push(
      'SMTP_USER and SMTP_PASSWORD must be set together or not at all',
    );
  let mailFrom = env.MAIL_FROM ?? '';
  if (mailFrom === '') {
    if (production) problems.push('MAIL_FROM is required in production');
    mailFrom = DEV_MAIL_FROM;
  } else if (!MAIL_FROM.test(mailFrom)) {
    problems.push(
      'MAIL_FROM must be an address like no-reply@example.com or "Nelio <no-reply@example.com>"',
    );
  }

  const httpUrl = (name: string, raw: string): string | undefined => {
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('protocol');
      return raw.replace(/\/+$/, '');
    } catch {
      problems.push(`${name} must be an http(s) URL`);
      return undefined;
    }
  };
  const s3EndpointRaw = env.S3_ENDPOINT ?? '';
  const s3Endpoint =
    s3EndpointRaw === ''
      ? production
        ? undefined
        : DEV_S3_ENDPOINT
      : httpUrl('S3_ENDPOINT', s3EndpointRaw);
  const s3Region =
    env.S3_REGION && env.S3_REGION !== '' ? env.S3_REGION : 'us-east-1';
  if (!/^[a-z0-9-]{2,32}$/.test(s3Region))
    problems.push('S3_REGION must be a region name such as us-east-1');
  let s3Bucket = env.S3_BUCKET ?? '';
  if (s3Bucket === '') {
    if (production) problems.push('S3_BUCKET is required in production');
    s3Bucket = DEV_S3_BUCKET;
  } else if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3Bucket)) {
    problems.push(
      'S3_BUCKET must be a valid bucket name (3-63 lowercase letters, digits, dots or hyphens)',
    );
  }
  const emptyToUndefined = (value: string | undefined) =>
    value === undefined || value === '' ? undefined : value;
  const s3AccessKeyId =
    emptyToUndefined(env.S3_ACCESS_KEY_ID) ??
    (production ? undefined : emptyToUndefined(env.MINIO_ROOT_USER));
  const s3SecretKey =
    emptyToUndefined(env.S3_SECRET_ACCESS_KEY) ??
    (production ? undefined : emptyToUndefined(env.MINIO_ROOT_PASSWORD));
  if (
    production &&
    (s3AccessKeyId === undefined || s3SecretKey === undefined)
  ) {
    problems.push(
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required in production',
    );
  } else if ((s3AccessKeyId === undefined) !== (s3SecretKey === undefined)) {
    problems.push(
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together or not at all',
    );
  }
  let s3PathStyle = s3Endpoint !== undefined;
  if (env.S3_FORCE_PATH_STYLE !== undefined && env.S3_FORCE_PATH_STYLE !== '') {
    if (['true', 'false'].includes(env.S3_FORCE_PATH_STYLE))
      s3PathStyle = env.S3_FORCE_PATH_STYLE === 'true';
    else problems.push('S3_FORCE_PATH_STYLE must be true or false');
  }
  let s3PublicBase = emptyToUndefined(env.S3_PUBLIC_BASE_URL);
  if (s3PublicBase === undefined) {
    if (production)
      problems.push('S3_PUBLIC_BASE_URL is required in production');
    s3PublicBase = s3Endpoint !== undefined ? `${s3Endpoint}/${s3Bucket}` : '';
  } else {
    s3PublicBase = httpUrl('S3_PUBLIC_BASE_URL', s3PublicBase) ?? '';
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
    mail: {
      host: smtpHost === '' ? DEV_SMTP_HOST : smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      user: smtpUser,
      password: smtpPassword,
      from: mailFrom,
    },
    storage: {
      endpoint: s3Endpoint,
      region: s3Region,
      bucket: s3Bucket,
      accessKeyId: s3AccessKeyId,
      secretAccessKey: s3SecretKey,
      forcePathStyle: s3PathStyle,
      publicBaseUrl: s3PublicBase,
    },
  };
}
