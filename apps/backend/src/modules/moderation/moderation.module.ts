import { Module } from '@nestjs/common';
import { BlocksController } from './controllers/blocks.controller.js';
import { ReportsController } from './controllers/reports.controller.js';
import { BlockService } from './services/block.service.js';
import { ReportService } from './services/report.service.js';

/** Moderation (Layer 0): blocks and report filing. Handling reports is M12 (Admin). It imports no other domain module. */
@Module({
  controllers: [BlocksController, ReportsController],
  providers: [BlockService, ReportService],
  exports: [BlockService],
})
export class ModerationModule {}
