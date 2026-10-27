import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/index.js';
import { FilesModule } from '../files/index.js';
import { MeController } from './controllers/me.controller.js';
import { UsersController } from './controllers/users.controller.js';
import { TeacherApplicationService } from './services/teacher-application.service.js';
import { UserAccountService } from './services/user-account.service.js';
import { UsersService } from './services/users.service.js';

/**
 * Users (Layer 1): the account, profile, name search and the Teacher application. It reads Files for avatar URLs and writes `User` and
 * `UserRole`; the primitives Auth and Admin compose are exported through `index.ts`.
 */
@Module({
  imports: [AuditModule, FilesModule],
  controllers: [MeController, UsersController],
  providers: [UsersService, TeacherApplicationService, UserAccountService],
  exports: [UserAccountService],
})
export class UsersModule {}
