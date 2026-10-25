import { Injectable, type PipeTransform } from '@nestjs/common';
import { ApiException } from '../filters/api-exception.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path/query UUID parameters: a malformed id is a 400 (the request is wrong whatever the data), never a 404 (Decision 140). */
@Injectable()
export class ParseUuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new ApiException('VALIDATION_FAILED', {
        message: 'Validation failed',
        errors: [{ field: 'id', messages: ['id must be a UUID'] }],
      });
    }
    return value.toLowerCase();
  }
}
