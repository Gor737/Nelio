import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import helmet from 'helmet';
import { ERROR_CODES } from './common/constants/error-codes.js';
import { ErrorResponseDto, FieldErrorDto } from './common/filters/index.js';
import {
  JsonLogger,
  httpLoggingMiddleware,
  requestIdMiddleware,
} from './common/logging/index.js';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/index.js';

export const API_PREFIX = 'api/v1';
export const DOCS_PATH = 'api/docs';

/** Builds the OpenAPI document that is the contract for the frontend (also written to openapi.json by `npm run openapi:export`). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('Nelio API')
    .setDescription(
      [
        'Backend API of the Nelio learning platform. All paths are under `/api/v1`.',
        '',
        'Every error has the shape `{ statusCode, code, message, errors? }`; branch on `code`, not on `message`.',
        'Check order: 429 -> 401 -> 403 ACCOUNT_SUSPENDED -> guards -> 400 -> 409.',
        '',
        'Error codes: ' + Object.keys(ERROR_CODES).join(', ') + '.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token (15 minutes) from POST /auth/login.',
      },
      'access-token',
    )
    .build();
  return SwaggerModule.createDocument(app, options, {
    extraModels: [ErrorResponseDto, FieldErrorDto],
  });
}

/**
 * Everything that is not a provider: routing prefix, security headers, CORS, proxy trust, request id and access log,
 * the JSON logger and (when enabled) the Swagger UI. Shared by main.ts and the tests so tests run the real setup.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(APP_CONFIG);

  const logger = new JsonLogger(config.logLevel);
  app.useLogger(logger);
  app.set('trust proxy', config.trustProxy);
  app.setGlobalPrefix(API_PREFIX);

  // Registered before helmet on purpose: Swagger UI needs inline scripts that helmet's default CSP blocks, and the docs
  // carry no data. They are disabled in production unless SWAGGER_ENABLED=true.
  if (config.swaggerEnabled) {
    SwaggerModule.setup(DOCS_PATH, app, buildOpenApiDocument(app), {
      jsonDocumentUrl: `${DOCS_PATH}-json`,
    });
  }

  app.use(requestIdMiddleware);
  app.use(httpLoggingMiddleware(logger));
  app.use(helmet());
  app.enableCors({
    origin: config.frontendOrigin,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });
}
