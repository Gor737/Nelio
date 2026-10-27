import { Logger } from '@nestjs/common';
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
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      abortOnError: false, // let a ConfigError reach the handler below instead of Nest printing a stack trace and aborting
      autoFlushLogs: false, // a failure must not dump the buffered start-up lines and a stack trace: the handler below decides
      bufferLogs: true, // the start-up lines are written by the JSON logger that configureApp installs, not by Nest's text logger
    });
    configureApp(app);
    app.enableShutdownHooks();
    await app.listen(app.get<AppConfig>(APP_CONFIG).port);
  } catch (error) {
    // A configuration problem lists every missing/invalid variable by name (never by value) and exits non-zero.
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    Logger.flush(); // anything else: show what was buffered before the error is raised
    throw error;
  }
}
void bootstrap();
