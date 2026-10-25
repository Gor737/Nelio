import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import {
  APP_CONFIG,
  ConfigError,
  type AppConfig,
} from './infrastructure/config/index.js';

async function bootstrap() {
  try {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    configureApp(app);
    app.enableShutdownHooks();
    await app.listen(app.get<AppConfig>(APP_CONFIG).port);
  } catch (error) {
    // A configuration problem lists every missing/invalid variable by name (never by value) and exits non-zero.
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
void bootstrap();
