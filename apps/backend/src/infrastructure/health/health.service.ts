import { Injectable } from '@nestjs/common';
import { ApiException } from '../../common/filters/index.js';
import { PrismaService } from '../database/index.js';

export interface HealthReport {
  readonly status: 'ok';
  readonly database: 'up';
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  /** Succeeds only when the database answers; otherwise 503 SERVICE_UNAVAILABLE. */
  async check(): Promise<HealthReport> {
    if (!(await this.prisma.ping()))
      throw new ApiException('SERVICE_UNAVAILABLE');
    return { status: 'ok', database: 'up' };
  }
}
