// Every database column that has a text limit in TEXT_LIMITS, with the name of its CHECK constraint and a function that tries to store
// a value in it through the real table. One list, used by the schema suite (do the SQL numbers equal the constants?) and by the
// consistency test (is everything the DTO helper accepts accepted by the database?).
import type { TEXT_LIMITS } from '../../src/common/constants/limits.js';
import type { Queryable } from './database.js';
import { createUser } from './factories.js';
import {
  createCategory,
  createCourse,
  createTag,
} from './factories-courses.js';
import {
  createBlock,
  createCourseTree,
  createLesson,
  createSection,
} from './factories-content.js';
import {
  createConversation,
  createGroup,
  createMessage,
  reportMessage,
  reportUser,
} from './factories-chat.js';

export interface LimitedColumn {
  /** The CHECK constraint that carries the limit. */
  readonly constraint: string;
  /** The TEXT_LIMITS entry whose numbers it must carry. */
  readonly limit: keyof typeof TEXT_LIMITS;
  /** Tries to store `value` in the column (creating whatever rows it needs first). Throws the PostgreSQL error when it is refused. */
  readonly store: (q: Queryable, value: string) => Promise<unknown>;
}

const uniqueEmail = () =>
  `limit-${Math.random().toString(36).slice(2)}@example.test`;

export const LIMITED_COLUMNS: readonly LimitedColumn[] = [
  {
    constraint: 'users_email_length',
    limit: 'EMAIL',
    store: (q, value) =>
      q.query(
        `INSERT INTO users (email, full_name, password_hash) VALUES ($1, 'Name', 'x')`,
        [value],
      ),
  },
  {
    constraint: 'users_full_name_length',
    limit: 'USER_FULL_NAME',
    store: (q, value) =>
      q.query(
        `INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, 'x')`,
        [uniqueEmail(), value],
      ),
  },
  {
    constraint: 'user_roles_application_message_length',
    limit: 'TEACHER_APPLICATION_MESSAGE',
    store: async (q, value) => {
      const user = await createUser(q);
      return q.query(
        `INSERT INTO user_roles (user_id, role, status, application_message) VALUES ($1, 'TEACHER', 'PENDING', $2)`,
        [user.id, value],
      );
    },
  },
  {
    constraint: 'user_roles_decision_note_length',
    limit: 'DECISION_NOTE',
    store: async (q, value) => {
      const user = await createUser(q);
      return q.query(
        `INSERT INTO user_roles (user_id, role, status, decision_note) VALUES ($1, 'STUDENT', 'ACTIVE', $2)`,
        [user.id, value],
      );
    },
  },
  {
    constraint: 'file_assets_original_name_length',
    limit: 'FILE_ORIGINAL_NAME',
    store: async (q, value) => {
      const user = await createUser(q);
      return q.query(
        `INSERT INTO file_assets (uploaded_by, kind, storage_key, original_name, mime_type, size_bytes) VALUES ($1, 'AVATAR', gen_random_uuid()::text, $2, 'image/png', 1)`,
        [user.id, value],
      );
    },
  },
  {
    constraint: 'courses_title_length',
    limit: 'COURSE_TITLE',
    store: (q, value) => createCourse(q, { title: value }),
  },
  {
    constraint: 'courses_summary_length',
    limit: 'COURSE_SUMMARY',
    store: (q, value) => createCourse(q, { summary: value }),
  },
  {
    constraint: 'courses_description_length',
    limit: 'COURSE_DESCRIPTION',
    store: (q, value) => createCourse(q, { description: value }),
  },
  {
    constraint: 'sections_title_length',
    limit: 'SECTION_TITLE',
    store: async (q, value) =>
      createSection(q, await createCourse(q), { title: value }),
  },
  {
    constraint: 'lessons_title_length',
    limit: 'LESSON_TITLE',
    store: async (q, value) => {
      const courseId = await createCourse(q);
      return createLesson(q, courseId, await createSection(q, courseId), {
        title: value,
      });
    },
  },
  {
    constraint: 'content_blocks_text_body_length',
    limit: 'TEXT_BLOCK_BODY',
    store: async (q, value) => {
      const { lessonId } = await createCourseTree(q, createCourse);
      return createBlock(q, lessonId, { type: 'TEXT', textBody: value });
    },
  },
  {
    constraint: 'tags_name_length',
    limit: 'TAG_NAME',
    store: (q, value) => createTag(q, { name: value }),
  },
  {
    constraint: 'categories_name_length',
    limit: 'CATEGORY_NAME',
    store: (q, value) => createCategory(q, { name: value }),
  },
  {
    constraint: 'conversations_title_length',
    limit: 'GROUP_TITLE',
    store: (q, value) => createConversation(q, { type: 'GROUP', title: value }),
  },
  {
    constraint: 'messages_body_length',
    limit: 'MESSAGE_BODY',
    store: async (q, value) => {
      const creator = await createUser(q);
      const conversationId = await createGroup(q, creator.id);
      return createMessage(q, conversationId, creator.id, { body: value });
    },
  },
  {
    constraint: 'reports_description_length',
    limit: 'REPORT_DESCRIPTION',
    store: async (q, value) => {
      const [reporter, target] = [await createUser(q), await createUser(q)];
      return reportUser(q, reporter.id, target.id, { description: value });
    },
  },
  {
    constraint: 'reports_resolution_note_length',
    limit: 'REPORT_RESOLUTION_NOTE',
    store: async (q, value) => {
      const [reporter, target, reviewer] = [
        await createUser(q),
        await createUser(q),
        await createUser(q),
      ];
      return reportUser(q, reporter.id, target.id, {
        status: 'ACTIONED',
        reviewedBy: reviewer.id,
        reviewedAt: new Date(),
        resolutionNote: value,
      });
    },
  },
  {
    // The snapshot is a copy of a message body, so it follows MESSAGE_BODY (Decision 77).
    constraint: 'reports_message_snapshot_length',
    limit: 'MESSAGE_BODY',
    store: async (q, value) => {
      const [creator, reporter] = [await createUser(q), await createUser(q)];
      const conversationId = await createGroup(q, creator.id, [reporter.id]);
      const messageId = await createMessage(q, conversationId, creator.id);
      return reportMessage(q, reporter.id, messageId, { snapshot: value });
    },
  },
];
