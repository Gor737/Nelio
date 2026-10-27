import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/index.js';
import { CatalogModule } from '../catalog/index.js';
import { ChatModule } from '../chat/index.js';
import { ContentModule } from '../content/index.js';
import { FilesModule } from '../files/index.js';
import { CoursesController } from './controllers/courses.controller.js';
import { TeamController } from './controllers/team.controller.js';
import { CourseAdminService } from './services/course-admin.service.js';
import { CourseTeamService } from './services/course-team.service.js';
import { CoursesService } from './services/courses.service.js';

/**
 * Courses (Layer 2): the course itself, its lifecycle, tags, the public catalog and the teaching team. It owns `Course` and
 * `CourseTeacher`; it calls Catalog (tags), Chat (`CourseChannelService`), Content (the syllabus) and Files (cover URLs), and writes the
 * lifecycle audit rows. Admin reuses the team primitives (`CourseTeamService`) and the takedown transitions (`CourseAdminService`) in its own transactions.
 */
@Module({
  imports: [AuditModule, CatalogModule, ChatModule, ContentModule, FilesModule],
  controllers: [CoursesController, TeamController],
  providers: [CoursesService, CourseTeamService, CourseAdminService],
  exports: [CoursesService, CourseTeamService, CourseAdminService],
})
export class CoursesModule {}
