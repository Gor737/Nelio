// Jest globalSetup for the integration suite: build the test database from the migrations once per run.
import { buildTestDatabase } from './test-database.mjs';

export default async function globalSetup() {
  const applied = await buildTestDatabase();
  console.log(
    `\nnelio_test built from ${applied.length} migration(s): ${applied.join(', ')}`,
  );
}
