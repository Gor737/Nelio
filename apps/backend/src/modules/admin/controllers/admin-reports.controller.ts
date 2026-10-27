import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import {
  AdminReportDetailDto,
  AdminReportsPageDto,
  ReportContextDto,
  ReportQueueQueryDto,
  ResolveReportDto,
} from '../../moderation/index.js';
import { ActionReportDto } from '../dto/admin.dto.js';
import { AdminReportsService } from '../services/admin-reports.service.js';

const ADMIN_ONLY = 'Admins only: 403 FORBIDDEN for anyone else.';

/** The report queue (Decisions 77, 132). Admins see the report, its snapshot and, through `context`, about ten messages around it. */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@Roles('ADMIN')
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'The report queue',
    description: `OPEN by default, oldest first; \`status\`, \`targetType\` and \`reason\` filter. The reporter is shown to Admins. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminReportsPageDto })
  list(@Query() query: ReportQueueQueryDto): Promise<AdminReportsPageDto> {
    return this.reports.list(query);
  }

  @Get(':reportId')
  @ApiOperation({
    summary: 'One report with its evidence snapshot',
    description: `Does not show the conversation and writes no audit row. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminReportDetailDto })
  get(
    @Param('reportId', ParseUuidPipe) reportId: string,
  ): Promise<AdminReportDetailDto> {
    return this.reports.get(reportId);
  }

  @Get(':reportId/context')
  @ApiOperation({
    summary: 'The reported message with about ten messages each side',
    description: `Private conversations stay private except for this window, so EVERY call writes a REPORT_CONTEXT_VIEWED audit row (the other report endpoints write none). The text of a deleted message is never returned. 400 for a report about a user. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: ReportContextDto })
  context(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('reportId', ParseUuidPipe) reportId: string,
  ): Promise<ReportContextDto> {
    return this.reports.context(admin.id, reportId);
  }

  @Post(':reportId/dismiss')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Dismiss a report',
    description: `Closes only this report. 409 REPORT_ALREADY_RESOLVED when it is not OPEN (also when a parallel resolution closed it). ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminReportDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  dismiss(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ResolveReportDto,
  ): Promise<AdminReportDetailDto> {
    return this.reports.dismiss(admin.id, reportId, dto.note);
  }

  @Post(':reportId/action')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Act on a report',
    description: `ACTIONED. With \`deleteMessage: true\` the reported message is deleted (the only way an Admin deletes someone else's message) and every OPEN report about it is closed with this one. 409 REPORT_ALREADY_RESOLVED when it is not OPEN; 400 when asked to delete the message of a user report. ${ADMIN_ONLY}`,
  })
  @ApiOkResponse({ type: AdminReportDetailDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  action(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('reportId', ParseUuidPipe) reportId: string,
    @Body() dto: ActionReportDto,
  ): Promise<AdminReportDetailDto> {
    return this.reports.action(admin.id, reportId, dto);
  }
}
