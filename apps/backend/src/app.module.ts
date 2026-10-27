import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthCoreModule } from './common/auth-core.module.js';
import { GLOBAL_PROVIDERS } from './common/global-providers.js';
import { HealthModule } from './infrastructure/health/index.js';
import { AuditModule } from './infrastructure/audit/index.js';
import { AppConfigModule } from './infrastructure/config/index.js';
import { DatabaseModule } from './infrastructure/database/index.js';
import { EventsModule } from './infrastructure/events/index.js';
import { MailModule } from './infrastructure/mail/index.js';
import { RealtimeModule } from './infrastructure/realtime/index.js';
import { AdminModule } from './modules/admin/index.js';
import { AuthModule } from './modules/auth/index.js';
import { CatalogModule } from './modules/catalog/index.js';
import { ChatModule } from './modules/chat/index.js';
import { ContentModule } from './modules/content/index.js';
import { CoursesModule } from './modules/courses/index.js';
import { EnrollmentsModule } from './modules/enrollments/index.js';
import { FilesModule } from './modules/files/index.js';
import { ModerationModule } from './modules/moderation/index.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { ProgressModule } from './modules/progress/index.js';
import { UsersModule } from './modules/users/index.js';

@Module({
  imports: [
    // Infrastructure (never imports a domain)
    AppConfigModule.forRoot(),
    DatabaseModule,
    AuthCoreModule,
    HealthModule,
    AuditModule,
    MailModule,
    EventsModule,
    RealtimeModule,
    // The nightly jobs (cleanups and safety-net sweepers): in-process, so single instance only (Decision 162, JOB_SCHEDULE)
    ScheduleModule.forRoot(),
    // Layer 0
    FilesModule,
    CatalogModule,
    ProgressModule,
    ModerationModule,
    NotificationsModule,
    // Layer 1
    UsersModule,
    ContentModule,
    ChatModule,
    // Layer 2
    AuthModule,
    CoursesModule,
    EnrollmentsModule,
    // Layer 3
    AdminModule,
  ],
  providers: GLOBAL_PROVIDERS,
})
export class AppModule {}
