import { DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './app-config.js';

/**
 * Global module providing the validated configuration under the APP_CONFIG token.
 * `forRoot()` validates `process.env` while the module graph is being built, so a bad or missing secret stops the
 * application before it listens on a port. Tests pass an explicit environment.
 */
@Module({})
export class AppConfigModule {
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule {
    return {
      module: AppConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(env) }],
      exports: [APP_CONFIG],
    };
  }
}
