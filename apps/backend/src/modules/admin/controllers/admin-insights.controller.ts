import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../../common/decorators/index.js';
import {
  AuditLogPageDto,
  AuditLogQueryDto,
  StatsDto,
} from '../dto/admin.dto.js';
import { AdminInsightsService } from '../services/admin-insights.service.js';

/** The audit-log viewer and the read-only statistics. */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN')
@Controller('admin')
export class AdminInsightsController {
  constructor(private readonly insights: AdminInsightsService) {}

  @Get('audit-logs')
  @ApiOperation({
    summary: 'The audit log',
    description:
      'Newest first, cursor pagination (`nextCursor`). Filter by actor, action, target type and target id. The log is immutable. Admins only: 403 FORBIDDEN for anyone else.',
  })
  @ApiOkResponse({ type: AuditLogPageDto })
  auditLogs(@Query() query: AuditLogQueryDto): Promise<AuditLogPageDto> {
    return this.insights.auditLogs(query);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Platform counts',
    description:
      'A read-only snapshot of counts (users, roles, courses by status, enrollments, open reports). Admins only: 403 FORBIDDEN for anyone else.',
  })
  @ApiOkResponse({ type: StatsDto })
  stats(): Promise<StatsDto> {
    return this.insights.stats();
  }
}
