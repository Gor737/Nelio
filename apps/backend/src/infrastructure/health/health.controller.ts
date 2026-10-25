import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/index.js';
import { ErrorResponseDto } from '../../common/filters/index.js';
import { HealthService } from './health.service.js';

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({
    enum: ['up'],
    example: 'up',
    description: 'The database answered `SELECT 1`.',
  })
  database!: 'up';
}

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness and database readiness probe',
    description: 'Public. Never returns configuration or connection details.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: 'SERVICE_UNAVAILABLE: the database is not reachable.',
  })
  check(): Promise<HealthResponseDto> {
    return this.health.check();
  }
}
