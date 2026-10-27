// Public API of the Catalog module: `CourseTagsService.setCourseTags(tx, courseId, names)` is what Courses calls (architecture section 6).
export { CatalogModule } from './catalog.module.js';
export {
  CourseTagsService,
  type CourseTag,
} from './services/course-tags.service.js';
export {
  CatalogAdminService,
  type AdminTagRecord,
  type CategoryRecord,
  type TagMergeResult,
} from './services/catalog-admin.service.js';
export { CatalogService } from './services/catalog.service.js';
