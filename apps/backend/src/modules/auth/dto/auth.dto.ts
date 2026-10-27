import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { TEXT_LIMITS } from '../../../common/constants/limits.js';
import { TextLength } from '../../../common/decorators/index.js';

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

class EmailField {
  @ApiProperty({ maxLength: TEXT_LIMITS.EMAIL.max })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(TEXT_LIMITS.EMAIL.max)
  email!: string;
}

export class RegisterDto extends EmailField {
  @ApiProperty({
    minLength: TEXT_LIMITS.USER_FULL_NAME.min,
    maxLength: TEXT_LIMITS.USER_FULL_NAME.max,
  })
  @Transform(trim)
  @TextLength(TEXT_LIMITS.USER_FULL_NAME)
  fullName!: string;

  @ApiProperty({
    minLength: TEXT_LIMITS.PASSWORD.min,
    maxLength: TEXT_LIMITS.PASSWORD.max,
    description:
      '10-128 characters, no composition rules; very common passwords are refused (400).',
  })
  @TextLength(TEXT_LIMITS.PASSWORD)
  password!: string;
}

export class LoginDto extends EmailField {
  @ApiProperty({ maxLength: TEXT_LIMITS.PASSWORD.max })
  @IsString()
  @MinLength(1)
  @MaxLength(TEXT_LIMITS.PASSWORD.max * 4)
  password!: string;
}

export class EmailOnlyDto extends EmailField {}

export class TokenDto {
  @ApiProperty({ description: 'The token from the link in the email.' })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty({
    minLength: TEXT_LIMITS.PASSWORD.min,
    maxLength: TEXT_LIMITS.PASSWORD.max,
  })
  @TextLength(TEXT_LIMITS.PASSWORD)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(TEXT_LIMITS.PASSWORD.max * 4)
  currentPassword!: string;

  @ApiProperty({
    minLength: TEXT_LIMITS.PASSWORD.min,
    maxLength: TEXT_LIMITS.PASSWORD.max,
  })
  @TextLength(TEXT_LIMITS.PASSWORD)
  newPassword!: string;
}

export class GoogleDto {
  @ApiProperty({ description: 'The Google ID token the frontend obtained.' })
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  idToken!: string;
}

/** `login`, `google` and `refresh` return the access token in the body; the refresh token travels only in the HttpOnly cookie. */
export class AuthTokensDto {
  @ApiProperty({
    description:
      'JWT, HS256, 15 minutes. Keep it in memory only; send it as `Authorization: Bearer …`.',
  })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Lifetime in seconds.' })
  expiresIn!: number;
}

export class AcceptedDto {
  @ApiProperty()
  message!: string;
}
