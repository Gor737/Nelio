import { Module } from '@nestjs/common';
import { FilesModule } from '../files/index.js';
import { ProgressModule } from '../progress/index.js';
import { ContentController } from './controllers/content.controller.js';
import { BlocksService } from './services/blocks.service.js';
import { LessonsService } from './services/lessons.service.js';
import { OutlineService } from './services/outline.service.js';
import { SectionsService } from './services/sections.service.js';

/**
 * Content (Layer 1): sections, lessons and content blocks, the lesson lifecycle, the video link parser and the student and teacher views.
 * It calls Progress (`recheckCourse`, inside the Course-X transaction of an unpublish or archive) and Files (signed download links).
 */
@Module({
  imports: [FilesModule, ProgressModule],
  controllers: [ContentController],
  providers: [SectionsService, LessonsService, BlocksService, OutlineService],
  exports: [OutlineService, LessonsService],
})
export class ContentModule {}
