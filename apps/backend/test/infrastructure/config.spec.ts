import {
  ConfigError,
  loadConfig,
} from '../../src/infrastructure/config/index.js';

const secretOf = (n: number) => 'k9Xz'.repeat(Math.ceil(n / 4)).slice(0, n);
const valid = {
  JWT_SECRET: secretOf(48),
  DATABASE_URL: 'postgresql://u:p@localhost:5432/nelio',
};

const problemsOf = (env: NodeJS.ProcessEnv): readonly string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error('expected loadConfig to throw');
};

describe('configuration', () => {
  it('loads a minimal valid environment and applies the documented defaults', () => {
    expect(loadConfig(valid)).toEqual({
      nodeEnv: 'development',
      port: 3000,
      databaseUrl: valid.DATABASE_URL,
      jwtSecret: valid.JWT_SECRET,
      frontendOrigin: 'http://localhost:3001',
      trustProxy: 0,
      logLevel: 'info',
      swaggerEnabled: true,
    });
  });

  describe('JWT_SECRET (the application refuses to start without a strong secret)', () => {
    it('is required', () => {
      expect(problemsOf({ DATABASE_URL: valid.DATABASE_URL })).toEqual([
        'JWT_SECRET is required',
      ]);
    });

    it('must be at least 32 BYTES: 31 is rejected, 32 accepted, multibyte characters count as bytes', () => {
      expect(problemsOf({ ...valid, JWT_SECRET: secretOf(31) })[0]).toContain(
        'at least 32 bytes',
      );
      expect(
        loadConfig({ ...valid, JWT_SECRET: secretOf(32) }).jwtSecret,
      ).toHaveLength(32);
      expect(
        loadConfig({ ...valid, JWT_SECRET: 'աբգդեզէըթժիլխծկհ' }).jwtSecret,
      ).toBe('աբգդեզէըթժիլխծկհ'); // 16 chars x 2 bytes
      expect(
        problemsOf({ ...valid, JWT_SECRET: 'աբգդեզէըթժիլխծկ' })[0],
      ).toContain('at least 32 bytes');
    });

    it('rejects placeholders and a single repeated character', () => {
      for (const weak of [
        'change_me_change_me_change_me_change_me',
        'x'.repeat(40),
        'my-secret-here-my-secret-here-1234',
        'example-example-example-example-example',
      ]) {
        expect(problemsOf({ ...valid, JWT_SECRET: weak })[0]).toContain(
          'placeholder',
        );
      }
    });

    it('error messages never contain the secret value or the database password', () => {
      const secret = 'short-VALUE-that-must-not-leak';
      const message = (() => {
        try {
          loadConfig({
            JWT_SECRET: secret,
            DATABASE_URL: 'mysql://root:topsecretpw@host/db',
          });
        } catch (e) {
          return (e as Error).message;
        }
        return '';
      })();
      expect(message).toContain('JWT_SECRET');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('topsecretpw');
    });
  });

  describe('database url', () => {
    it('is required in production, even when POSTGRES_* variables exist', () => {
      expect(
        problemsOf({
          NODE_ENV: 'production',
          JWT_SECRET: valid.JWT_SECRET,
          FRONTEND_ORIGIN: 'https://app.example.com',
          POSTGRES_USER: 'u',
          POSTGRES_PASSWORD: 'p',
        }),
      ).toEqual(['DATABASE_URL is required in production']);
    });

    it('outside production it is built from the variables docker-compose.yml uses, with special characters encoded', () => {
      const cfg = loadConfig({
        JWT_SECRET: valid.JWT_SECRET,
        POSTGRES_USER: 'nelio',
        POSTGRES_PASSWORD: 'p@ss/w:rd',
        POSTGRES_DB: 'nelio',
      });
      expect(cfg.databaseUrl).toBe(
        'postgresql://nelio:p%40ss%2Fw%3Ard@localhost:5433/nelio',
      );
    });

    it('must be a postgres URL', () => {
      expect(problemsOf({ ...valid, DATABASE_URL: 'mysql://x/y' })).toEqual([
        'DATABASE_URL must start with postgres:// or postgresql://',
      ]);
    });

    it('is required when neither DATABASE_URL nor the POSTGRES_* pair is given', () => {
      expect(problemsOf({ JWT_SECRET: valid.JWT_SECRET })[0]).toContain(
        'DATABASE_URL is required',
      );
    });
  });

  describe('production', () => {
    const production = {
      NODE_ENV: 'production',
      ...valid,
      FRONTEND_ORIGIN: 'https://app.example.com',
    };

    it('requires FRONTEND_ORIGIN and turns Swagger off by default', () => {
      expect(problemsOf({ ...production, FRONTEND_ORIGIN: undefined })).toEqual(
        ['FRONTEND_ORIGIN is required in production'],
      );
      const cfg = loadConfig(production);
      expect(cfg.swaggerEnabled).toBe(false);
      expect(cfg.nodeEnv).toBe('production');
    });

    it('Swagger can be enabled explicitly', () => {
      expect(
        loadConfig({ ...production, SWAGGER_ENABLED: 'true' }).swaggerEnabled,
      ).toBe(true);
    });
  });

  describe('other variables', () => {
    it('FRONTEND_ORIGIN is one http(s) origin: no wildcard (credentials are on), no path, no other scheme', () => {
      for (const bad of [
        '*',
        'https://app.example.com/path',
        'ftp://app.example.com',
        'not a url',
      ]) {
        expect(problemsOf({ ...valid, FRONTEND_ORIGIN: bad })).toHaveLength(1);
      }
      expect(
        loadConfig({ ...valid, FRONTEND_ORIGIN: 'https://app.example.com/' })
          .frontendOrigin,
      ).toBe('https://app.example.com');
      expect(
        loadConfig({ ...valid, FRONTEND_ORIGIN: 'http://localhost:4200' })
          .frontendOrigin,
      ).toBe('http://localhost:4200');
    });

    it('PORT, TRUST_PROXY, LOG_LEVEL, SWAGGER_ENABLED and NODE_ENV are validated', () => {
      expect(problemsOf({ ...valid, PORT: '0' })).toEqual([
        'PORT must be an integer between 1 and 65535',
      ]);
      expect(problemsOf({ ...valid, PORT: '80x' })).toHaveLength(1);
      expect(problemsOf({ ...valid, TRUST_PROXY: '11' })).toEqual([
        'TRUST_PROXY must be an integer between 0 and 10',
      ]);
      expect(problemsOf({ ...valid, LOG_LEVEL: 'trace' })).toEqual([
        'LOG_LEVEL must be one of debug, info, warn, error',
      ]);
      expect(problemsOf({ ...valid, SWAGGER_ENABLED: 'yes' })).toEqual([
        'SWAGGER_ENABLED must be true or false',
      ]);
      expect(problemsOf({ ...valid, NODE_ENV: 'staging' })).toEqual([
        'NODE_ENV must be one of development, test, production',
      ]);
      expect(
        loadConfig({
          ...valid,
          PORT: '8080',
          TRUST_PROXY: '2',
          LOG_LEVEL: 'warn',
        }),
      ).toMatchObject({ port: 8080, trustProxy: 2, logLevel: 'warn' });
    });

    it('reports every problem at once, not only the first', () => {
      expect(
        problemsOf({ NODE_ENV: 'production', PORT: 'x', LOG_LEVEL: 'loud' }),
      ).toEqual([
        'PORT must be an integer between 1 and 65535',
        'DATABASE_URL is required in production',
        'JWT_SECRET is required',
        'FRONTEND_ORIGIN is required in production',
        'LOG_LEVEL must be one of debug, info, warn, error',
      ]);
    });
  });
});
