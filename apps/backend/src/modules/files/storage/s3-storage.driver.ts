import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../../../common/filters/index.js';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../infrastructure/config/index.js';
import { type SignedUrlOptions, StorageDriver } from './storage-driver.js';

/** Public objects never change under their key (the key contains a fresh UUID), so they can be cached for a long time. */
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PRIVATE_CACHE_CONTROL = 'private, no-store';

/**
 * S3 and S3-compatible stores (MinIO and the like) through the AWS SDK v3. The client is created on first use, so an application
 * without storage settings still starts (the Files endpoints then answer 503 SERVICE_UNAVAILABLE).
 */
@Injectable()
export class S3StorageDriver extends StorageDriver {
  private readonly logger = new Logger(S3StorageDriver.name);
  private client?: S3Client;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  private s3(): S3Client {
    const { accessKeyId, secretAccessKey, endpoint, region, forcePathStyle } =
      this.config.storage;
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw new ApiException('SERVICE_UNAVAILABLE', {
        message: 'File storage is not configured',
      });
    }
    this.client ??= new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 2,
      requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 },
    });
    return this.client;
  }

  /** Turns an SDK failure into a 503 and logs what is safe to log (the error name and HTTP status), never keys or credentials. */
  private unavailable(operation: string, error: unknown): never {
    if (error instanceof ApiException) throw error;
    const failure = error as {
      name?: string;
      $metadata?: { httpStatusCode?: number };
    };
    this.logger.error({
      event: 'storage_failed',
      operation,
      error: failure.name,
      status: failure.$metadata?.httpStatusCode,
    });
    throw new ApiException('SERVICE_UNAVAILABLE', {
      message: 'File storage is temporarily unavailable',
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: contentType,
          CacheControl: key.startsWith('public/')
            ? PUBLIC_CACHE_CONTROL
            : PRIVATE_CACHE_CONTROL,
        }),
      );
    } catch (error) {
      this.unavailable('put', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.s3().send(
        new DeleteObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      this.unavailable('delete', error);
    }
  }

  async signedGetUrl(key: string, options: SignedUrlOptions): Promise<string> {
    try {
      return await getSignedUrl(
        this.s3(),
        new GetObjectCommand({
          Bucket: this.config.storage.bucket,
          Key: key,
          ResponseContentType: options.contentType,
          ResponseContentDisposition:
            options.downloadName === undefined
              ? undefined
              : contentDisposition(options.downloadName),
        }),
        { expiresIn: options.expiresInSeconds },
      );
    } catch (error) {
      this.unavailable('sign', error);
    }
  }

  publicUrl(key: string): string {
    return `${this.config.storage.publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}

/** `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded name>` (RFC 6266 / RFC 5987). */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
