import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/index.js';
import { ChatModule } from '../chat/index.js';
import { FilesModule } from '../files/index.js';
import { ProgressModule } from '../progress/index.js';
import { EnrollmentsController } from './controllers/enrollments.controller.js';
import { InvitationsController } from './controllers/invitations.controller.js';
import { EnrollmentMachine } from './services/enrollment-machine.service.js';
import { EnrollmentsService } from './services/enrollments.service.js';
import { InvitationsService } from './services/invitations.service.js';

/**
 * Enrollments (Layer 2): the enrollment state machine, invitations, last-visited, student lists and "my courses". It owns `Enrollment` and
 * `Invitation`. It calls Chat (`CourseChannelService`) and Progress (`CompletionService`) inside its own transactions, reads courses through
 * SQL, and never imports Courses (a Layer 2 peer). Admin reuses `EnrollmentsService` for removal and reinstatement.
 */
@Module({
  imports: [AuditModule, ChatModule, FilesModule, ProgressModule],
  controllers: [EnrollmentsController, InvitationsController],
  providers: [EnrollmentMachine, EnrollmentsService, InvitationsService],
  exports: [EnrollmentsService],
})
export class EnrollmentsModule {}
