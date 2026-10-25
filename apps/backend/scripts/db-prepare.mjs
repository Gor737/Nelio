#!/usr/bin/env node
// Creates the database that Prisma needs next to the application database: `<name>_shadow` (shadow database for
// `prisma migrate dev` and `prisma migrate diff`). Only ever CREATEs; never drops or touches an existing database.
// Usage: node --env-file-if-exists=../../.env scripts/db-prepare.mjs
import pg from 'pg';
import {
  databaseNameOf,
  resolveDatabaseUrl,
  shadowDatabaseUrl,
  withDatabase,
} from '../prisma/database-url.mjs';

const url = resolveDatabaseUrl();
const wanted = [databaseNameOf(shadowDatabaseUrl(url))];

const admin = new pg.Client({
  connectionString: withDatabase(url, 'postgres'),
});
await admin.connect();
try {
  for (const name of wanted) {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
      console.log(`created database ${name}`);
    } else {
      console.log(`database ${name} already exists`);
    }
  }
} finally {
  await admin.end();
}
