import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/index.js';
import { BlocksController } from './controllers/blocks.controller.js';
import { ReportsController } from './controllers/reports.controller.js';
import { BlockService } from './services/block.service.js';
import { ReportQueueService } from './services/report-queue.service.js';
import { ReportService } from './services/report.service.js';

/** Moderation (Layer 0): blocks, report filing and the report queue (Admin reads and closes reports through `ReportQueueService`). It imports no other domain module. */
@Module({
  imports: [AuditModule],
  controllers: [BlocksController, ReportsController],
  providers: [BlockService, ReportService, ReportQueueService],
  exports: [BlockService, ReportQueueService],
})
export class ModerationModule {}
