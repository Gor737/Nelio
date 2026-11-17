export type EnrollmentPolicy = "OPEN" | "APPROVAL_REQUIRED" | "INVITATION_ONLY";

// Shared shape of a category or tag reference.
export type Ref = {
  id: string;
  name: string;
  slug: string;
};

export type Person = {
  id: string;
  fullName: string;
  avatarUrl: string | null;
};

// One course in GET /courses (CourseCardDto).
export type CourseCard = {
  id: string;
  title: string;
  summary: string | null;
  coverUrl: string | null;
  category: Ref | null;
  tags: Ref[];
  enrollmentPolicy: EnrollmentPolicy;
  owner: Person;
  firstPublishedAt: string | null;
};

// Response of GET /courses (CatalogPageDto).
export type CatalogPage = {
  items: CourseCard[];
  page: number;
  pageSize: number;
  total: number;
};

export type CatalogQuery = {
  q?: string;
  categoryId?: string;
  sort?: SortCourse;
  page?: number;
  pageSize?: number;
};

export type SortCourse = "newest" | "title" | "relevance";

export type CourseStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

// What the current user is to the course (NONE for a guest or a stranger).
export type CourseRelationship =
  | "OWNER"
  | "ASSISTANT"
  | "STUDENT_ACTIVE"
  | "STUDENT_PENDING"
  | "STUDENT_LEFT"
  | "REMOVED"
  | "REJECTED"
  | "INVITEE"
  | "NONE";

// Response of GET /courses/:courseId (CourseDetailDto): every CourseCard field plus these.
export type CourseDetails = CourseCard & {
  description: string | null;
  status: CourseStatus;
  archivedAt: string | null;
  createdAt: string;
  viewer: { relationship: CourseRelationship };
};

// GET /courses/:courseId/syllabus returns SyllabusSection[].
// Titles only: lesson content is for enrolled students.
export type SyllabusLesson = {
  id: string;
  title: string;
};

export type SyllabusSection = {
  id: string;
  title: string;
  lessons: SyllabusLesson[];
};
