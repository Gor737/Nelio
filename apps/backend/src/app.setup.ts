import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DocumentBuilder,
  getSchemaPath,
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
} from './infrastructure/logging/index.js';
import { APP_CONFIG, type AppConfig } from './infrastructure/config/index.js';

export const API_PREFIX = 'api/v1';
/** Routes served without the prefix: infrastructure probes (architecture: "`GET /health`", Decision 167). */
export const UNPREFIXED_ROUTES = ['health'];
export const DOCS_PATH = 'api/docs';

/** Builds the OpenAPI document that is the contract for the frontend (also written to openapi.json by `npm run openapi:export`). */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('Nelio API')
    .setDescription(
      [
        'Backend API of the Nelio learning platform. All paths are under `/api/v1`, except the unversioned probe `GET /health`.',
        '',
        'Every error has the shape `{ statusCode, code, message, errors? }`; branch on `code`, not on `message`.',
        'Check order: 429 -> 401 -> 403 ACCOUNT_SUSPENDED -> guards -> 400 -> 409.',
        '',
        'Any endpoint can answer 429 TOO_MANY_REQUESTS (with a `Retry-After` header), 500 INTERNAL_ERROR and 503 SERVICE_UNAVAILABLE. 503 means a dependency (the database) is temporarily unavailable, including a deadlock that survived the server-side retries; the request changed nothing and may be repeated later. No `Retry-After` is sent with 503, so use your own backoff.',
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
  const document = SwaggerModule.createDocument(app, options, {
    extraModels: [ErrorResponseDto, FieldErrorDto],
  });
  addCommonErrorResponses(document);
  return document;
}

const COMMON_ERRORS: Record<string, string> = {
  '429': 'TOO_MANY_REQUESTS: rate limit exceeded; see the Retry-After header.',
  '500': 'INTERNAL_ERROR: unexpected server error.',
  '503':
    'SERVICE_UNAVAILABLE: a dependency is temporarily unavailable; safe to retry later.',
};

/** Every operation can fail with these three whatever its own logic, so the contract lists them once, here. */
function addCommonErrorResponses(document: OpenAPIObject): void {
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item)) {
      if (
        typeof operation !== 'object' ||
        operation === null ||
        !('responses' in operation)
      )
        continue;
      for (const [status, description] of Object.entries(COMMON_ERRORS)) {
        operation.responses[status] ??= {
          description,
          content: {
            'application/json': {
              schema: { $ref: getSchemaPath(ErrorResponseDto) },
            },
          },
        };
      }
    }
  }
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
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });

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
