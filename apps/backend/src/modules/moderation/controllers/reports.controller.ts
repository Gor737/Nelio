import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, RateLimit } from '../../../common/decorators/index.js';
import { ErrorResponseDto } from '../../../common/filters/index.js';
import type { AuthenticatedUser } from '../../../common/guards/index.js';
import { ParseUuidPipe } from '../../../common/pipes/index.js';
import { CreateReportDto, ReportReceiptDto } from '../dto/moderation.dto.js';
import { ReportService } from '../services/report.service.js';

@ApiTags('Moderation')
@ApiBearerAuth('access-token')
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportService) {}

  @Post('users/:id/report')
  @HttpCode(201)
  @RateLimit('TIGHT')
  @ApiOperation({
    summary: 'Report a user',
    description:
      'One open report per reporter and user; a new one is possible once the old one is handled.',
  })
  @ApiCreatedResponse({ type: ReportReceiptDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Reporting yourself, or an invalid body.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'RESOURCE_CONFLICT: you already have an open report on this user.',
  })
  reportUser(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: CreateReportDto,
  ): Promise<ReportReceiptDto> {
    return this.reports.reportUser(user.id, id, dto);
  }

  @Post('conversations/:conversationId/messages/:messageId/report')
  @HttpCode(201)
  @RateLimit('TIGHT')
  @ApiOperation({
    summary: 'Report a message',
    description:
      'You must be an active member of the conversation. The text of the message is saved with the report as it is now, so editing or deleting it later does not change the evidence. Not found (404) for a message you cannot see.',
  })
  @ApiCreatedResponse({ type: ReportReceiptDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: 'Your own message, or an invalid body.',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'RESOURCE_CONFLICT: you already have an open report on this message.',
  })
  reportMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId', ParseUuidPipe) conversationId: string,
    @Param('messageId', ParseUuidPipe) messageId: string,
    @Body() dto: CreateReportDto,
  ): Promise<ReportReceiptDto> {
    return this.reports.reportMessage(user.id, conversationId, messageId, dto);
  }
}
