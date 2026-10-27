// M14: the configuration is complete and documented. `.env.example` (the one place an operator looks) and the code agree in both directions,
// and every setting a production deployment needs is refused individually when it is missing, by name.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadConfig,
} from '../../src/infrastructure/config/index.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const example = readFileSync(join(root, '../../.env.example'), 'utf8');

function files(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'generated' || name === 'dist')
      return [];
    return statSync(path).isDirectory()
      ? files(path, accept)
      : accept(name)
        ? [path]
        : [];
  });
}

/** Every environment variable the code, the scripts and Prisma's configuration read. */
function variablesRead(): Set<string> {
  const sources = [
    ...files(join(root, 'src'), (n) => n.endsWith('.ts')),
    ...files(join(root, 'scripts'), (n) => n.endsWith('.mjs')),
    ...files(join(root, 'prisma'), (n) => n.endsWith('.mjs')),
    join(root, 'prisma.config.ts'),
  ];
  const found = new Set<string>();
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{2,})\b/g,
    ))
      found.add(m[1]);
  }
  return found;
}

/** Names that appear as `NAME=` in the example, commented out or not. */
function variablesDocumented(): Set<string> {
  return new Set(
    [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]),
  );
}

/** Set by the platform or the test runner, not by the operator. */
const NOT_SETTINGS = new Set(['PATH', 'HOME', 'CI']);
/** Read by Docker Compose, not by the application. */
const COMPOSE_ONLY = new Set([
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
]);
/** Read only by the test tooling or the OpenAPI export, which have their own placeholders. */
const TOOLING_ONLY = new Set([
  'DATABASE_URL_TEST',
  'SMOKE_DATABASE_URL',
  'NELIO_TEST_DATABASE_URL',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
]);

describe('.env.example and the code agree', () => {
  it('every variable the code reads is documented in .env.example', () => {
    const documented = variablesDocumented();
    const missing = [...variablesRead()].filter(
      (name) =>
        !documented.has(name) &&
        !NOT_SETTINGS.has(name) &&
        !TOOLING_ONLY.has(name) &&
        !name.startsWith('NELIO_') &&
        !name.startsWith('SMOKE_') &&
        !name.startsWith('REHEARSAL_'), // tooling of the release scripts, documented in docs/release.md
    );
    expect(missing.sort()).toEqual([]);
  });

  it('every variable .env.example documents is read by the code or by Docker Compose (nothing stale)', () => {
    const read = variablesRead();
    const stale = [...variablesDocumented()].filter(
      (name) => !read.has(name) && !COMPOSE_ONLY.has(name),
    );
    expect(stale.sort()).toEqual([]);
  });

  it('the file contains no real-looking secret: every value is empty, a placeholder or a documented local default', () => {
    for (const m of example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) {
      const [, name, value] = m;
      if (/PASSWORD|SECRET|KEY|TOKEN/.test(name))
        expect([name, value === '' || /^change_me$/.test(value)]).toEqual([
          name,
          true,
        ]);
    }
  });

  it('every setting a production deployment needs says so next to it', () => {
    for (const name of [
      'JWT_SECRET',
      'DATABASE_URL',
      'FRONTEND_ORIGIN',
      'SMTP_HOST',
      'MAIL_FROM',
      'S3_PUBLIC_BASE_URL',
    ]) {
      const at = example.search(new RegExp(`^#?\\s*${name}=`, 'm'));
      expect(at).toBeGreaterThan(-1);
      const before = example.slice(Math.max(0, at - 700), at);
      expect([name, /required/i.test(before)]).toEqual([name, true]);
    }
  });
});

describe('a production deployment', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@db.example.test:5432/nelio',
    JWT_SECRET: 'k9Xz'.repeat(12),
    FRONTEND_ORIGIN: 'https://app.example.test',
    TRUST_PROXY: '1',
    SMTP_HOST: 'smtp.example.test',
    MAIL_FROM: 'Nelio <no-reply@example.test>',
    S3_BUCKET: 'nelio-files',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret-value-123',
    S3_PUBLIC_BASE_URL: 'https://files.example.test/nelio-files',
  };
  const problems = (env: NodeJS.ProcessEnv): readonly string[] => {
    try {
      loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    return [];
  };

  it('starts with the complete environment, with Swagger off and no development default in use', () => {
    const config = loadConfig(production);
    expect(config.nodeEnv).toBe('production');
    expect(config.swaggerEnabled).toBe(false);
    expect(config.frontendOrigin).toBe('https://app.example.test');
    expect(config.mail.host).toBe('smtp.example.test');
    expect(config.storage.publicBaseUrl).toBe(
      'https://files.example.test/nelio-files',
    );
    expect(config.storage.endpoint).toBeUndefined(); // AWS-style: no custom endpoint
    expect(config.trustProxy).toBe(1);
  });

  it.each([
    'DATABASE_URL',
    'JWT_SECRET',
    'FRONTEND_ORIGIN',
    'SMTP_HOST',
    'MAIL_FROM',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_PUBLIC_BASE_URL',
  ])('refuses to start without %s, and says which', (name) => {
    const env: NodeJS.ProcessEnv = { ...production };
    delete env[name];
    const found = problems(env);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((p) => p.includes(name))).toBe(true);
    expect(found.join(' ')).not.toContain(production.S3_SECRET_ACCESS_KEY);
  });

  it('never falls back to a development default for the database, the secret, the object store keys or the origin', () => {
    const found = problems({
      NODE_ENV: 'production',
      MINIO_ROOT_USER: 'u',
      MINIO_ROOT_PASSWORD: 'p',
      POSTGRES_USER: 'u',
      POSTGRES_PASSWORD: 'p',
    });
    for (const name of [
      'DATABASE_URL',
      'JWT_SECRET',
      'FRONTEND_ORIGIN',
      'S3_ACCESS_KEY_ID',
    ]) {
      expect([name, found.some((p) => p.includes(name))]).toEqual([name, true]);
    }
  });

  it('the proxy hop count is bounded (a wrong value is refused rather than trusted)', () => {
    expect(problems({ ...production, TRUST_PROXY: '11' }).join()).toContain(
      'TRUST_PROXY',
    );
    expect(problems({ ...production, TRUST_PROXY: '-1' }).join()).toContain(
      'TRUST_PROXY',
    );
    expect(problems({ ...production, TRUST_PROXY: 'yes' }).join()).toContain(
      'TRUST_PROXY',
    );
  });

  it('refuses a weak or placeholder JWT secret and a frontend origin that is not an origin', () => {
    expect(problems({ ...production, JWT_SECRET: 'short' }).join()).toContain(
      'JWT_SECRET',
    );
    expect(
      problems({ ...production, JWT_SECRET: 'changeme'.repeat(8) }).join(),
    ).toContain('JWT_SECRET');
    expect(problems({ ...production, FRONTEND_ORIGIN: '*' }).join()).toContain(
      'FRONTEND_ORIGIN',
    );
    expect(
      problems({
        ...production,
        FRONTEND_ORIGIN: 'https://app.example.test/path',
      }).join(),
    ).toContain('FRONTEND_ORIGIN');
  });
});
