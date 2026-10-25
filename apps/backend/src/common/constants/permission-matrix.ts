/**
 * Permission matrix as data (docs/architecture.md section 12, Decision 137), used by guards and by the M13 conformance
 * suite. Two levels:
 *   - platform permissions: which platform roles may do it (roles are cumulative; every user has STUDENT);
 *   - course permissions: which course relationships may do it.
 * The matrix answers "who". Resource state (course status, enrollment policy, lock, archive) is decided afterwards by
 * `CourseAccessService` and the owning service (section 12 levels 2 and 3), never here.
 *
 * Admins act only through `/admin/*` and are ordinary users everywhere else, so ADMIN never appears in a course
 * permission. Entries marked `source: 'derived'` apply the stated roles-and-permissions text to an endpoint group.
 */
export const PLATFORM_ROLES = ['STUDENT', 'TEACHER', 'ADMIN'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Architecture section 12, "Course relationships". */
export const COURSE_RELATIONSHIPS = [
  'OWNER',
  'ASSISTANT',
  'STUDENT_ACTIVE',
  'STUDENT_PENDING',
  'STUDENT_LEFT',
  'REMOVED',
  'REJECTED',
  'INVITEE',
  'NONE',
] as const;
export type CourseRelationship = (typeof COURSE_RELATIONSHIPS)[number];

const ANY_USER: readonly PlatformRole[] = PLATFORM_ROLES;

export const PLATFORM_PERMISSIONS = {
  // everyone who is logged in
  'me.manage': ANY_USER,
  'user.search': ANY_USER,
  'user.report': ANY_USER,
  'user.block': ANY_USER,
  'notification.manage-own': ANY_USER,
  'conversation.use': ANY_USER,
  'file.upload': ANY_USER,
  'course.list-public': ANY_USER,
  // Decision 137 correction: an ACTIVE Admin without an ACTIVE Teacher role may apply (STUDENT is held by everyone);
  // a user who already has an ACTIVE Teacher role gets 409 ALREADY_TEACHER, which is a state check, not a permission.
  'teacher-application.apply': ['STUDENT'],
  // Teacher actions need an ACTIVE Teacher role (otherwise TEACHER_NOT_APPROVED / FORBIDDEN)
  'course.create': ['TEACHER'],
  'course.list-teaching': ['TEACHER'],
  // Admin-only, reached through /admin/* (Decision 133, 141)
  'admin.users.read': ['ADMIN'],
  'admin.users.suspend': ['ADMIN'],
  'admin.admin-role.manage': ['ADMIN'],
  'admin.teacher-applications.decide': ['ADMIN'],
  'admin.teacher.revoke': ['ADMIN'],
  'admin.courses.read': ['ADMIN'],
  'admin.courses.lock': ['ADMIN'],
  'admin.courses.unlock': ['ADMIN'],
  'admin.courses.restore': ['ADMIN'],
  'admin.courses.transfer-ownership': ['ADMIN'],
  'admin.students.remove': ['ADMIN'],
  'admin.students.reinstate': ['ADMIN'],
  'admin.catalog.manage': ['ADMIN'],
  'admin.reports.handle': ['ADMIN'],
  'admin.audit-log.read': ['ADMIN'],
  'admin.stats.read': ['ADMIN'],
} as const satisfies Record<string, readonly PlatformRole[]>;
export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

const TEACHERS: readonly CourseRelationship[] = ['OWNER', 'ASSISTANT'];
const OWNER_ONLY: readonly CourseRelationship[] = ['OWNER'];

export const COURSE_PERMISSIONS = {
  // Owner: settings, policy, tags, publish/archive/delete, assistants, ownership transfer, remove/reinstate students.
  'course.update-settings': OWNER_ONLY,
  'course.set-tags': OWNER_ONLY,
  'course.publish': OWNER_ONLY,
  'course.archive': OWNER_ONLY,
  'course.restore': OWNER_ONLY,
  'course.delete': OWNER_ONLY,
  'team.add-assistant': OWNER_ONLY,
  'team.remove-assistant': OWNER_ONLY,
  'team.transfer-ownership': OWNER_ONLY,
  'students.remove': OWNER_ONLY,
  'students.reinstate': OWNER_ONLY,
  // Assistant: content, approve/reject requests, view students and progress, invite (Owner can do all of it).
  'course.manage-view': TEACHERS,
  'content.edit': TEACHERS,
  'content.read-all-statuses': TEACHERS,
  'enrollment.review-requests': TEACHERS,
  'students.view': TEACHERS,
  'students.view-progress': TEACHERS,
  'invitations.manage': TEACHERS,
  'channel.moderate': TEACHERS,
  // An Assistant may leave; the Owner must transfer first.
  'team.leave-as-assistant': ['ASSISTANT'],
  // Student side (the transition table itself is M11c, Decisions 70 and 123).
  'lesson.read-content': ['OWNER', 'ASSISTANT', 'STUDENT_ACTIVE'],
  'lesson.mark-complete': ['STUDENT_ACTIVE'],
  'enrollment.request': ['NONE', 'INVITEE', 'STUDENT_LEFT', 'REJECTED'],
  'enrollment.leave': ['STUDENT_ACTIVE', 'STUDENT_PENDING'],
  'enrollment.read-own': [
    'STUDENT_ACTIVE',
    'STUDENT_PENDING',
    'STUDENT_LEFT',
    'REMOVED',
    'REJECTED',
  ],
  'invitation.respond': ['INVITEE'],
  'channel.participate': ['OWNER', 'ASSISTANT', 'STUDENT_ACTIVE'],
} as const satisfies Record<string, readonly CourseRelationship[]>;
export type CoursePermission = keyof typeof COURSE_PERMISSIONS;

export const platformAllows = (
  permission: PlatformPermission,
  roles: readonly PlatformRole[],
): boolean =>
  roles.some((role) =>
    (PLATFORM_PERMISSIONS[permission] as readonly PlatformRole[]).includes(
      role,
    ),
  );

export const courseAllows = (
  permission: CoursePermission,
  relationship: CourseRelationship,
): boolean =>
  (COURSE_PERMISSIONS[permission] as readonly CourseRelationship[]).includes(
    relationship,
  );
