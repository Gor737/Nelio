import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigError } from './infrastructure/config/index.js';
import { FirstAdminSeeder, SeedError } from './modules/admin/index.js';

/**
 * `npm run seed:admin`: creates the first Admin from SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and (optionally) SEED_ADMIN_NAME, only when no
 * active Admin exists. Safe to run on every deploy. Exit code 0 when it created the Admin or found one, 1 when the settings are wrong.
 * Nothing about the values is printed.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? '';
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  const fullName = process.env.SEED_ADMIN_NAME ?? 'Administrator';
  if (!email || !password) {
    console.error(
      'Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to seed the first Admin.',
    );
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
    abortOnError: false,
  });
  try {
    const outcome = await app
      .get(FirstAdminSeeder)
      .run({ email, password, fullName });
    console.log(
      outcome.created
        ? 'The first Admin was created.'
        : 'An Admin already exists; nothing was changed.',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SeedError || error instanceof ConfigError)
    console.error(error.message);
  else console.error('Seeding the first Admin failed.', error);
  process.exit(1);
});
