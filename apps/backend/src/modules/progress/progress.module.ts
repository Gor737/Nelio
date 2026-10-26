import { Module } from '@nestjs/common';
import { ProgressController } from './controllers/progress.controller.js';
import { CompletionService } from './services/completion.service.js';
import { ProgressQueries } from './services/progress-queries.js';

/**
 * Progress (Layer 0, a leaf): lesson completion, the permanent course-completion snapshot, progress reads. It reads Enrollment and
 * Lesson through SQL and imports no other domain module; Enrollments and Content call `CompletionService` inside their own transaction.
 */
@Module({
  controllers: [ProgressController],
  providers: [CompletionService, ProgressQueries],
  exports: [CompletionService, ProgressQueries],
})
export class ProgressModule {}
