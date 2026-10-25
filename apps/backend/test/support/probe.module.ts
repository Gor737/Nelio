// A throwaway module for HTTP tests of the shared infrastructure (validation, UUID pipe, throttling, error mapping). It has
// no database, so it runs in the plain e2e suite. It lives in test/ and is never imported by src/.
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { RateLimit } from '../../src/common/decorators/index.js';
import { ApiException } from '../../src/common/filters/index.js';
import { ParseUuidPipe } from '../../src/common/pipes/index.js';

export class ProbeItemDto {
  @IsString()
  @Length(1, 10)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  count?: number;
}

export class ProbeLoginDto {
  @IsString()
  email!: string;
}

/** The shape Prisma 7 + adapter-pg gives a database error (Spike A finding E2). */
const dbError = (sqlstate: string, constraint?: string) =>
  Object.assign(new Error(`db error ${sqlstate}`), {
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: sqlstate,
          originalMessage: constraint ? `constraint "${constraint}"` : 'x',
        },
      },
    },
  });

@Controller('probe')
export class ProbeController {
  @Post('items')
  create(@Body() dto: ProbeItemDto) {
    return dto;
  }

  @Get('items/:id')
  one(@Param('id', ParseUuidPipe) id: string) {
    return { id };
  }

  @Post('login')
  @RateLimit('STRICT')
  login(@Body() dto: ProbeLoginDto) {
    return { ok: true, email: dto.email };
  }

  @Get('throw/:kind')
  fail(@Param('kind') kind: string): never {
    switch (kind) {
      case 'api':
        throw new ApiException('COURSE_ARCHIVED');
      case 'two-status-403':
        throw new ApiException('COURSE_ADMIN_LOCKED', { status: 403 });
      case 'two-status-409':
        throw new ApiException('COURSE_ADMIN_LOCKED', { status: 409 });
      case 'unique':
        throw dbError('23505', 'users_email_key');
      case 'fk':
        throw dbError('23503', 'x_fkey');
      case 'restrict':
        throw dbError('23001', 'x_fkey');
      case 'check':
        throw dbError('23514', 'blocks_no_self_block');
      case 'deadlock':
        throw dbError('40P01');
      case 'lock-timeout':
        throw dbError('55P03');
      default:
        throw new Error('secret internal detail: postgresql://user:pw@host/db');
    }
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
