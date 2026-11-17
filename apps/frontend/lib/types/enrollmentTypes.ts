import { CourseStatus } from "@/lib/types/courseTypes";

// Status of an enrollment row (backend: ENROLLMENT_STATUSES in enrollment-transitions.ts).
// POST /courses/:courseId/enrollments only ever gives ACTIVE (OPEN course) or PENDING (APPROVAL_REQUIRED course).
export type EnrollmentStatus =
  | "PENDING"
  | "ACTIVE"
  | "LEFT"
  | "REJECTED"
  | "REMOVED";

// Part of EnrollmentDto: the student's live progress in the course.
export type EnrollmentProgress = {
  completedLessons: number;
  totalLessons: number;
  percent: number; // 0-100, rounded down
};

// Response of POST /courses/:courseId/enrollments (201) and GET /courses/:courseId/enrollments/me (EnrollmentDto).
// Dates arrive as ISO strings in JSON.
export type Enrollment = {
  courseId: string;
  status: EnrollmentStatus;
  completedAt: string | null;
  lastVisitedLessonId: string | null;
  lastVisitedAt: string | null;
  progress: EnrollmentProgress;
};

// Argument of the enroll mutation (POST /courses/:courseId/enrollments), same shape as getCourse's arg.
export type EnrollArgs = {
  id: string;
};

// One item of GET /me/enrollments (MyEnrollmentDto): an Enrollment plus 3 fields of its course.
// Flat on purpose: no teacher, category or summary here.
export type MyEnrollment = Enrollment & {
  courseTitle: string;
  courseStatus: CourseStatus;
  coverUrl: string | null;
};

// Query params of GET /me/enrollments. All optional:
// no status = ACTIVE and PENDING (default); page default 1; pageSize default 20, max 50.
export type MyEnrollmentsQuery = {
  status?: EnrollmentStatus;
  page?: number;
  pageSize?: number;
};

// Response of GET /me/enrollments (MyEnrollmentsPageDto), newest activity first.
export type MyEnrollmentsPage = {
  items: MyEnrollment[];
  page: number;
  pageSize: number;
  total: number;
};

// Argument of PUT /courses/:courseId/enrollments/me/last-visited.
// courseId goes into the URL; only { lessonId } is the request body.
// Response: 204, no body (void). ACTIVE students only (403 otherwise).
export type LastVisitedArgs = {
  courseId: string;
  lessonId: string;
};
