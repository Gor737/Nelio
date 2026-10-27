// Connection settings shared by prisma.config.ts, the database scripts and the test harness.
// Resolution order: DATABASE_URL (CI, production), then POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB from the
// environment (the same variables docker-compose.yml reads from .env), host and port defaulting to the Compose service
// published on localhost:5433. The result contains credentials: never log it.

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '5433';
const DEFAULT_DATABASE = 'nelio';

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const user = env.POSTGRES_USER;
  const password = env.POSTGRES_PASSWORD;
  if (!user || !password) {
    // No credentials: commands that never connect (prisma generate, prisma validate) still work; anything that
    // connects fails with an authentication error instead of silently using a wrong database.
    return `postgresql://${DEFAULT_HOST}:${DEFAULT_PORT}/${DEFAULT_DATABASE}`;
  }
  const host = env.POSTGRES_HOST ?? DEFAULT_HOST;
  const port = env.POSTGRES_PORT ?? DEFAULT_PORT;
  const database = env.POSTGRES_DB ?? DEFAULT_DATABASE;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/** @param {string} url */
export function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/**
 * The same server and credentials, another database.
 * @param {string} url
 * @param {string} database
 */
export function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * `prisma migrate diff --from-migrations` needs an explicit shadow database: `<name>_shadow`.
 * @param {string} url
 */
export function shadowDatabaseUrl(url) {
  return withDatabase(url, `${databaseNameOf(url)}_shadow`);
}
