// ---------- GET /courses/:courseId/outline (OutlineDto) ----------
// Roles: OWNER, ASSISTANT, STUDENT_ACTIVE.
// A student gets published lessons only, without `status` / `blockCount`,
// and sections that have no published lesson are left out.

export type LessonStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export type OutlineLesson = {
  id: string;
  title: string;
  position: number;
  status?: LessonStatus; // teachers only
  blockCount?: number; // teachers only
};

export type OutlineSection = {
  id: string;
  title: string;
  position: number;
  lessons: OutlineLesson[];
};

export type CourseOutline = {
  sections: OutlineSection[];
};

// Argument of getOutline, same shape as getCourse's arg.
export type OutlineArgs = {
  id: string;
};

// ---------- GET /courses/:courseId/lessons/:lessonId (LessonStudentDto) ----------
// Roles: OWNER, ASSISTANT, STUDENT_ACTIVE. A student gets 404 for a lesson that is
// not published (also on an archived course). Teachers get extra lifecycle fields
// (status, firstPublishedAt) that this type leaves out.

export type BlockType = "TEXT" | "VIDEO" | "FILE";

export type VideoBlock = {
  provider: "YOUTUBE" | "VIMEO";
  externalId: string;
  embedUrl: string; // the player URL, built by the server
};

export type FileBlock = {
  name: string;
  mimeType: string;
  sizeBytes: number;
};

// Exactly one of textBody / video / file is set, matching `type`.
export type ContentBlock = {
  id: string;
  position: number;
  type: BlockType;
  textBody: string | null; // Markdown written by the teacher: UNTRUSTED, render it safely
  video: VideoBlock | null;
  file: FileBlock | null;
};

export type Lesson = {
  id: string;
  sectionId: string;
  title: string;
  position: number;
  blocks: ContentBlock[];
};

export type LessonArgs = {
  courseId: string;
  lessonId: string;
};

// ---------- PUT /courses/:courseId/lessons/:lessonId/completion (LessonCompletionDto) ----------
// ACTIVE students only. No body. Idempotent: repeating returns the same completedAt; there is no un-complete.
// Argument: the same { courseId, lessonId } as LessonArgs.

export type CompletionProgress = {
  completedLessons: number;
  totalLessons: number;
  percent: number; // 0-100, rounded down
};

export type LessonCompletion = {
  lessonId: string;
  completedAt: string; // ISO date
  courseCompleted: boolean; // true ONLY in the request that finished the whole course
  progress: CompletionProgress;
};
