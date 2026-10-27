/**
 * Where file bytes live (Decision 64: "S3-compatible object storage behind a small interface in the Files module"). The interface
 * is internal to the Files module (docs/architecture.md section 16): no other module imports it, so none of them knows whether the
 * bytes are in S3, MinIO or something else. It is an abstract class so that it can be an injection token.
 *
 * Every method throws `ApiException('SERVICE_UNAVAILABLE')` when the storage is not configured or does not answer; what to do about
 * that (roll back, or just log) is the caller's decision.
 */
export interface SignedUrlOptions {
  /** How long the URL works, in seconds. */
  readonly expiresInSeconds: number;
  /** The name the browser should save the file under (sent as `Content-Disposition: attachment`). */
  readonly downloadName?: string;
  /** Overrides the content type of the response. */
  readonly contentType?: string;
}

export abstract class StorageDriver {
  /** Writes (or replaces) an object. */
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Deletes an object; deleting an object that does not exist is not an error. */
  abstract delete(key: string): Promise<void>;
  /** A time-limited URL that downloads a private object without credentials. */
  abstract signedGetUrl(
    key: string,
    options: SignedUrlOptions,
  ): Promise<string>;
  /** The URL of an object under `public/`, readable by anyone. A pure function of the key: no request is made. */
  abstract publicUrl(key: string): string;
}
