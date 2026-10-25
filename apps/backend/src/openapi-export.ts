// Writes the OpenAPI document to openapi.json (the frontend contract) without listening on a port or connecting to the
// database: providers are created but `init()` (which would run PrismaService.onModuleInit) is never called.
// Usage: npm run openapi:export [-- <output path>]
import { writeFile } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

// Placeholders so the export works with no .env; nothing is ever connected to or signed with them.
process.env.DATABASE_URL ??=
  'postgresql://openapi-export:unused@localhost:1/unused';
process.env.JWT_SECRET ??= 'openapi-export-only-secret-never-used-for-signing';

async function main() {
  const { AppModule } = await import('./app.module.js');
  const { API_PREFIX, buildOpenApiDocument } = await import('./app.setup.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
  });
  app.setGlobalPrefix(API_PREFIX);
  const output = process.argv[2] ?? 'openapi.json';
  await writeFile(
    output,
    JSON.stringify(buildOpenApiDocument(app), null, 2) + '\n',
  );
  await app.close();
  console.log(`OpenAPI document written to ${output}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
