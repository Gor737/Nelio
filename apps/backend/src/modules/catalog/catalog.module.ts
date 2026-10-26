import { Module } from '@nestjs/common';
import { CatalogController } from './controllers/catalog.controller.js';
import { CatalogService } from './services/catalog.service.js';
import { CourseTagsService } from './services/course-tags.service.js';

/** Catalog (Layer 0): categories, tags, and the course-tag links. It imports no other domain module. */
@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CourseTagsService],
  exports: [CourseTagsService],
})
export class CatalogModule {}
