import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ERROR_CODES } from '../constants/error-codes.js';

export class FieldErrorDto {
  @ApiProperty({
    example: 'email',
    description: 'Property path of the invalid field.',
  })
  field!: string;

  @ApiProperty({ type: [String], example: ['email must be an email'] })
  messages!: string[];
}

/** The body of every error response (docs/architecture.md section 13). */
export class ErrorResponseDto {
  @ApiProperty({ example: 400, description: 'The HTTP status code.' })
  statusCode!: number;

  @ApiProperty({
    enum: Object.keys(ERROR_CODES),
    example: 'VALIDATION_FAILED',
    description:
      'Machine-readable error code; the frontend branches on this, never on `message`.',
  })
  code!: string;

  @ApiProperty({
    example: 'Validation failed',
    description: 'Human-readable text, safe to show but not to parse.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: [FieldErrorDto],
    description: 'Present for VALIDATION_FAILED: one entry per invalid field.',
  })
  errors?: FieldErrorDto[];
}
