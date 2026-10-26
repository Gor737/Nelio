import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/index.js';
import { AuthModule } from '../auth/index.js';
import { CatalogModule } from '../catalog/index.js';
import { ChatModule } from '../chat/index.js';
import { CoursesModule } from '../courses/index.js';
import { EnrollmentsModule } from '../enrollments/index.js';
import { ModerationModule } from '../moderation/index.js';
import { UsersModule } from '../users/index.js';
import { AdminCatalogController } from './controllers/admin-catalog.controller.js';
import { AdminCoursesController } from './controllers/admin-courses.controller.js';
import { AdminInsightsController } from './controllers/admin-insights.controller.js';
import { AdminReportsController } from './controllers/admin-reports.controller.js';
import { AdminUsersController } from './controllers/admin-users.controller.js';
import { AdminCatalogService } from './services/admin-catalog.service.js';
import { AdminCoursesService } from './services/admin-courses.service.js';
import { AdminInsightsService } from './services/admin-insights.service.js';
import { AdminReportsService } from './services/admin-reports.service.js';
import { AdminUsersService } from './services/admin-users.service.js';
import { FirstAdminSeeder } from './services/first-admin.seeder.js';

/**
 * Admin (Layer 3): orchestration only (Decision 47). It owns no table and no business rule: every write is one transaction that calls the
 * owner's primitive (Users, Auth, Courses, Enrollments, Moderation, Chat, Catalog) in the global lock order, and writes the audit rows of
 * the catalog actions that are its own. Every route is `/admin/*` and `@Roles('ADMIN')`.
 */
@Module({
  imports: [
    AuditModule,
    UsersModule,
    AuthModule,
    CoursesModule,
    EnrollmentsModule,
    ModerationModule,
    ChatModule,
    CatalogModule,
  ],
  controllers: [
    AdminUsersController,
    AdminCoursesController,
    AdminCatalogController,
    AdminReportsController,
    AdminInsightsController,
  ],
  providers: [
    AdminUsersService,
    AdminCoursesService,
    AdminCatalogService,
    AdminReportsService,
    AdminInsightsService,
    FirstAdminSeeder,
  ],
  exports: [FirstAdminSeeder],
})
export class AdminModule {}
