import { defineConfig } from 'prisma/config';
import { resolveDatabaseUrl, shadowDatabaseUrl } from './prisma/database-url.mjs';

// Multi-file schema: `schema` is a directory with one .prisma file per domain (Decision 101, verified in Spike A).
// Migrations are created with `--create-only` and hand-written SQL is appended (Decision 102).
const url = resolveDatabaseUrl();

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: { url, shadowDatabaseUrl: shadowDatabaseUrl(url) },
});
