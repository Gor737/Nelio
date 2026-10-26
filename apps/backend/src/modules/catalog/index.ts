// Public API of the Catalog module: `CourseTagsService.setCourseTags(tx, courseId, names)` is what Courses calls (architecture section 6).
export { CatalogModule } from './catalog.module.js';
export {
  CourseTagsService,
  type CourseTag,
} from './services/course-tags.service.js';
