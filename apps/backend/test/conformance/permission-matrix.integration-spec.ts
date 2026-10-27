// M13 conformance: the permission matrix (docs/architecture.md section 12, Decision 137) against EVERY endpoint.
//   1. Inventory: every route of the running application is classified (public, optional login, role, course role, or login only), and the
//      classification is complete in both directions, so a new endpoint fails this suite until somebody decides who may call it.
//   2. Declaration: the roles and course relationships a route declares equal what the matrix says (or are a documented superset).
//   3. Behavior: every course route x every relationship x five course states, and every role route x every role combination, run through
//      the REAL guards and the real database; the outcome (pass, or the exact status and code) is compared with an oracle that is written
//      here from the architecture text, not taken from the code under test.
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CourseAccessService } from '../../src/common/access/course-access.service.js';
import { ERROR_CODES } from '../../src/common/constants/error-codes.js';
import {
  COURSE_PERMISSIONS,
  COURSE_RELATIONSHIPS,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  platformAllows,
  type CoursePermission,
  type CourseRelationship,
  type PlatformPermission,
  type PlatformRole,
} from '../../src/common/constants/permission-matrix.js';
import { ApiException } from '../../src/common/filters/index.js';
import { CourseRoleGuard } from '../../src/common/guards/course-role.guard.js';
import { RolesGuard } from '../../src/common/guards/roles.guard.js';
import { createPool, resetData } from '../support/database.js';
import { createUser } from '../support/factories.js';
import {
  addCourseTeacher,
  createCategory,
  createCourse,
} from '../support/factories-courses.js';
import {
  createEnrollment,
  createInvitation,
} from '../support/factories-learning.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { routeInventory, type RouteInfo } from '../support/route-inventory.js';

const pool = createPool();
let t: FullApp;
let routes: RouteInfo[];
let courseGuard: CourseRoleGuard;
let rolesGuard: RolesGuard;

beforeAll(async () => {
  t = await createFullApp();
  routes = routeInventory(t.app);
  courseGuard = new CourseRoleGuard(
    t.app.get(Reflector),
    t.app.get(CourseAccessService, { strict: false }),
  );
  rolesGuard = new RolesGuard(t.app.get(Reflector));
});
afterAll(async () => {
  await t.app.close();
  await pool.end();
});

// ---------------------------------------------------------------------------------------------- the classification

/** Routes that ignore the Authorization header. */
const PUBLIC_ROUTES = [
  'GET /categories',
  'GET /tags',
  'POST /auth/forgot-password',
  'POST /auth/google',
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/refresh',
  'POST /auth/register',
  'POST /auth/resend-verification',
  'POST /auth/reset-password',
  'POST /auth/verify-email',
];
/** Routes where no token is anonymous and a valid token identifies the caller. */
const OPTIONAL_AUTH_ROUTES = [
  'GET /courses',
  'GET /courses/:courseId',
  'GET /courses/:courseId/syllabus',
  'GET /courses/:courseId/teachers',
];
/**
 * Any logged-in user, no role and no course role: what the caller may do is decided by OWNERSHIP inside the service (their own account,
 * notifications, blocks, invitations, files, or a conversation they are an ACTIVE member of: 404 for anyone else).
 */
const LOGIN_ONLY_ROUTES = [
  'DELETE /auth/google',
  'DELETE /conversations/:id/members/:userId',
  'DELETE /conversations/:id/messages/:messageId',
  'DELETE /files/:id',
  'DELETE /me/blocks/:userId',
  'GET /conversations/:id',
  'GET /conversations/:id/members',
  'GET /conversations/:id/messages',
  'GET /me',
  'GET /me/blocks',
  'GET /me/conversations',
  'GET /me/enrollments',
  'GET /me/invitations',
  'GET /me/notifications',
  'GET /me/notifications/unread-count',
  'GET /me/presence',
  'GET /me/teacher-application',
  'GET /users',
  'GET /users/:id',
  'PATCH /conversations/:id',
  'PATCH /conversations/:id/members/:userId',
  'PATCH /conversations/:id/membership',
  'PATCH /conversations/:id/messages/:messageId',
  'PATCH /me',
  'POST /auth/change-password',
  'POST /auth/google/link',
  'POST /auth/logout-all',
  'POST /conversations/:conversationId/messages/:messageId/report',
  'POST /conversations/:id/leave',
  'POST /conversations/:id/members',
  'POST /conversations/:id/messages',
  'POST /conversations/direct',
  'POST /conversations/groups',
  // Decision 142: a student of a locked course must still be able to leave, so this route has no course-role guard on purpose
  'POST /courses/:courseId/enrollments/me/leave',
  'POST /files',
  'POST /me/invitations/:invitationId/accept',
  'POST /me/invitations/:invitationId/decline',
  'POST /me/teacher-application',
  'POST /users/:id/report',
  'PUT /conversations/:id/read',
  'PUT /me/blocks/:userId',
  'PUT /me/notifications/:id/read',
  'PUT /me/notifications/read-all',
];

type CourseEntry = {
  permission: CoursePermission | null;
  extra?: CourseRelationship[];
  note?: string;
};
const ALL_RELATIONSHIPS = [...COURSE_RELATIONSHIPS];
/**
 * Every route under `/courses/:courseId` with a course role, and the matrix permission it implements. `permission: null` = the route is
 * about seeing the course page (visibility), where every relationship that can see the course passes the guard. `extra` lists relationships
 * the guard lets through ON TOP of the matrix because the service must answer them with a precise code (for example `ALREADY_ENROLLED`).
 */
const COURSE_ROUTES: Record<string, CourseEntry> = {
  'DELETE /courses/:courseId': { permission: 'course.delete' },
  'DELETE /courses/:courseId/assistants/:userId': {
    permission: 'team.remove-assistant',
  },
  'DELETE /courses/:courseId/lessons/:lessonId': { permission: 'content.edit' },
  'DELETE /courses/:courseId/lessons/:lessonId/blocks/:blockId': {
    permission: 'content.edit',
  },
  'DELETE /courses/:courseId/sections/:sectionId': {
    permission: 'content.edit',
  },
  'GET /courses/:courseId': { permission: null },
  'GET /courses/:courseId/channel': { permission: 'channel.participate' },
  'GET /courses/:courseId/enrollments/me': {
    permission: 'enrollment.read-own',
  },
  'GET /courses/:courseId/invitations': { permission: 'invitations.manage' },
  'GET /courses/:courseId/lessons/:lessonId': {
    permission: 'lesson.read-content',
  },
  'GET /courses/:courseId/lessons/:lessonId/blocks/:blockId/download': {
    permission: 'lesson.read-content',
  },
  'GET /courses/:courseId/outline': { permission: 'lesson.read-content' },
  'GET /courses/:courseId/students': { permission: 'students.view' },
  'GET /courses/:courseId/students/:userId/progress': {
    permission: 'students.view-progress',
  },
  'GET /courses/:courseId/syllabus': { permission: null },
  'GET /courses/:courseId/teachers': { permission: null },
  'PATCH /courses/:courseId': { permission: 'course.update-settings' },
  'PATCH /courses/:courseId/lessons/:lessonId': { permission: 'content.edit' },
  'PATCH /courses/:courseId/lessons/:lessonId/blocks/:blockId': {
    permission: 'content.edit',
  },
  'PATCH /courses/:courseId/sections/:sectionId': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/archive': { permission: 'course.archive' },
  'POST /courses/:courseId/assistants': { permission: 'team.add-assistant' },
  'POST /courses/:courseId/assistants/me/leave': {
    permission: 'team.leave-as-assistant',
  },
  'POST /courses/:courseId/enrollments': {
    permission: 'enrollment.request',
    extra: ['REMOVED', 'STUDENT_ACTIVE', 'STUDENT_PENDING'],
    note: 'the machine answers REMOVED with 403, ACTIVE and PENDING with 409 ALREADY_ENROLLED',
  },
  'POST /courses/:courseId/invitations': { permission: 'invitations.manage' },
  'POST /courses/:courseId/invitations/:invitationId/revoke': {
    permission: 'invitations.manage',
  },
  'POST /courses/:courseId/lessons/:lessonId/archive': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/lessons/:lessonId/blocks': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/lessons/:lessonId/blocks/reorder': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/lessons/:lessonId/move': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/lessons/:lessonId/publish': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/lessons/:lessonId/unpublish': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/ownership-transfer': {
    permission: 'team.transfer-ownership',
  },
  'POST /courses/:courseId/publish': { permission: 'course.publish' },
  'POST /courses/:courseId/restore': { permission: 'course.restore' },
  'POST /courses/:courseId/sections': { permission: 'content.edit' },
  'POST /courses/:courseId/sections/:sectionId/lessons': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/sections/:sectionId/lessons/reorder': {
    permission: 'content.edit',
  },
  'POST /courses/:courseId/sections/reorder': { permission: 'content.edit' },
  'POST /courses/:courseId/students/:userId/approve': {
    permission: 'enrollment.review-requests',
  },
  'POST /courses/:courseId/students/:userId/reinstate': {
    permission: 'students.reinstate',
  },
  'POST /courses/:courseId/students/:userId/reject': {
    permission: 'enrollment.review-requests',
  },
  'POST /courses/:courseId/students/:userId/remove': {
    permission: 'students.remove',
  },
  'PUT /courses/:courseId/enrollments/me/last-visited': {
    permission: 'lesson.mark-complete',
    note: 'ACTIVE students only',
  },
  'PUT /courses/:courseId/lessons/:lessonId/completion': {
    permission: 'lesson.mark-complete',
  },
  'PUT /courses/:courseId/tags': { permission: 'course.set-tags' },
};

/** Routes with a platform role (outside /admin). */
const ROLE_ROUTES: Record<string, PlatformPermission> = {
  'GET /me/teaching/courses': 'course.list-teaching',
  'POST /courses': 'course.create',
};

const keys = (list: RouteInfo[]) => list.map((r) => r.key).sort();
const sameSet = (a: readonly string[] | undefined, b: readonly string[]) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

describe('inventory: every endpoint is classified, in both directions', () => {
  it('finds the endpoints (a sanity floor, so an empty inventory cannot pass)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(135);
    expect(new Set(routes.map((r) => r.key)).size).toBe(routes.length);
  });

  it('public routes are exactly the documented list', () => {
    expect(keys(routes.filter((r) => r.isPublic))).toEqual(
      [...PUBLIC_ROUTES].sort(),
    );
  });

  it('optional-login routes are exactly the documented list', () => {
    expect(keys(routes.filter((r) => r.optionalAuth))).toEqual(
      [...OPTIONAL_AUTH_ROUTES].sort(),
    );
    for (const route of routes.filter((r) => r.optionalAuth))
      expect(route.isPublic).toBe(false);
  });

  it('every other endpoint requires a login (secure by default): nothing is accidentally open', () => {
    const open = routes.filter((r) => !r.isPublic && !r.optionalAuth);
    expect(open.length).toBe(
      routes.length - PUBLIC_ROUTES.length - OPTIONAL_AUTH_ROUTES.length,
    );
  });

  it('login-only routes (no role, no course role) are exactly the documented list', () => {
    const loginOnly = routes.filter(
      (r) => !r.isPublic && !r.optionalAuth && !r.roles && !r.courseRoles,
    );
    expect(keys(loginOnly)).toEqual([...LOGIN_ONLY_ROUTES].sort());
  });

  it('course-role routes are exactly the documented table (and every course route not in it is listed above with a reason)', () => {
    expect(keys(routes.filter((r) => r.courseRoles))).toEqual(
      Object.keys(COURSE_ROUTES).sort(),
    );
  });

  it('role routes: /admin/* are Admin-only, nothing else is, and the two Teacher routes are the documented ones', () => {
    const withRoles = routes.filter((r) => r.roles);
    const admin = withRoles.filter((r) => r.path.startsWith('/admin/'));
    expect(admin.length).toBe(
      routes.filter((r) => r.path.startsWith('/admin/')).length,
    ); // none without a role
    for (const route of admin) expect(route.roles).toEqual(['ADMIN']);
    const others = withRoles.filter((r) => !r.path.startsWith('/admin/'));
    expect(keys(others)).toEqual(Object.keys(ROLE_ROUTES).sort());
    for (const route of others) expect(route.roles).toEqual(['TEACHER']);
  });

  it('the matrix has no entry that no route implements (and no Admin permission without an /admin route)', () => {
    const used = new Set<string>(
      Object.values(COURSE_ROUTES).flatMap((e) =>
        e.permission ? [e.permission] : [],
      ),
    );
    const unused = Object.keys(COURSE_PERMISSIONS).filter((p) => !used.has(p));
    // Not routes of their own, by design:
    //  - `channel.moderate`: the message-delete rule of the Chat service (a Teacher of the course may delete in its channel);
    //  - `content.read-all-statuses` and `course.manage-view`: part of the outline, lesson and course-page routes above, which answer a
    //    Teacher with every status / the management fields and a student without them;
    //  - `enrollment.leave` and `invitation.respond`: the two login-only routes (Decision 142; the invitee is the invitation's user).
    expect(unused.sort()).toEqual([
      'channel.moderate',
      'content.read-all-statuses',
      'course.manage-view',
      'enrollment.leave',
      'invitation.respond',
    ]);
    expect(
      Object.keys(PLATFORM_PERMISSIONS).filter((p) => p.startsWith('admin.'))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('declaration: a route declares what the matrix says', () => {
  const byKey = (key: string) => routes.find((r) => r.key === key) as RouteInfo;

  it.each(Object.entries(COURSE_ROUTES))('%s', (key, entry) => {
    const declared = byKey(key).courseRoles as string[];
    if (entry.permission === null) {
      // visibility routes: every relationship, and the guard's 404/403 do the filtering
      expect(sameSet(declared, ALL_RELATIONSHIPS)).toBe(true);
      return;
    }
    const matrix = [...COURSE_PERMISSIONS[entry.permission]] as string[];
    expect(sameSet(declared, [...matrix, ...(entry.extra ?? [])])).toBe(true);
    if (entry.extra) expect(entry.note).toBeTruthy(); // a widening must be explained
  });

  it.each(Object.entries(ROLE_ROUTES))(
    '%s requires exactly the roles of its permission',
    (key, permission) => {
      expect(
        sameSet(byKey(key).roles, [...PLATFORM_PERMISSIONS[permission]]),
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------------------------- behavior: roles

const execution = (route: RouteInfo, request: object) =>
  ({
    getType: () => 'http',
    getHandler: () => route.handler,
    getClass: () => route.controllerClass,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

type Outcome = 'PASS' | { status: number; code: string };
async function outcomeOf(
  run: () => boolean | Promise<boolean>,
): Promise<Outcome> {
  try {
    await run();
    return 'PASS';
  } catch (error) {
    if (error instanceof ApiException) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
}

describe('behavior: platform roles (every role route x every role combination)', () => {
  const combos: PlatformRole[][] = [
    ['STUDENT'],
    ['STUDENT', 'TEACHER'],
    ['STUDENT', 'ADMIN'],
    ['STUDENT', 'TEACHER', 'ADMIN'],
  ];
  const roleRoutes = () => routes.filter((r) => r.roles);

  it('covers the role routes', () => expect(roleRoutes().length).toBe(35));

  it("the outcome of every route x combination is the oracle's: pass, TEACHER_NOT_APPROVED for Teacher routes, FORBIDDEN otherwise", async () => {
    let checked = 0;
    for (const route of roleRoutes()) {
      const allowed = route.roles as PlatformRole[];
      for (const activeRoles of combos) {
        const expected: Outcome = activeRoles.some((r) => allowed.includes(r))
          ? 'PASS'
          : allowed.includes('TEACHER')
            ? { status: 403, code: 'TEACHER_NOT_APPROVED' }
            : { status: 403, code: 'FORBIDDEN' };
        const actual = await outcomeOf(() =>
          rolesGuard.canActivate(
            execution(route, { user: { id: 'x', activeRoles } }),
          ),
        );
        expect([route.key, activeRoles.join('+'), actual]).toEqual([
          route.key,
          activeRoles.join('+'),
          expected,
        ]);
        checked++;
      }
    }
    expect(checked).toBe(35 * 4);
  });

  it('the matrix function agrees with the guard for the platform permissions that have routes', () => {
    for (const [key, permission] of Object.entries(ROLE_ROUTES)) {
      for (const role of PLATFORM_ROLES) {
        const route = routes.find((r) => r.key === key) as RouteInfo;
        expect(platformAllows(permission, [role])).toBe(
          (route.roles as string[]).includes(role),
        );
      }
    }
  });

  it("the status of every code the guards used is the registry's", () => {
    expect(ERROR_CODES.TEACHER_NOT_APPROVED.status).toBe(403);
    expect(ERROR_CODES.FORBIDDEN.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------- behavior: course relationships

type World = {
  name: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  policy: 'OPEN' | 'APPROVAL_REQUIRED' | 'INVITATION_ONLY';
  locked: boolean;
};
const WORLDS: World[] = [
  {
    name: 'published, open',
    status: 'PUBLISHED',
    policy: 'OPEN',
    locked: false,
  },
  {
    name: 'published, invitation only',
    status: 'PUBLISHED',
    policy: 'INVITATION_ONLY',
    locked: false,
  },
  { name: 'archived', status: 'ARCHIVED', policy: 'OPEN', locked: false },
  {
    name: 'locked by an Admin',
    status: 'ARCHIVED',
    policy: 'OPEN',
    locked: true,
  },
  { name: 'draft', status: 'DRAFT', policy: 'OPEN', locked: false },
];

/** The 404-versus-403 table of the architecture (section 12, "Visibility and access rules"), written out per case. */
function visible(
  world: World,
  rel: CourseRelationship,
): 'VISIBLE' | 'NOT_FOUND' | 'LOCKED' {
  if (rel === 'OWNER' || rel === 'ASSISTANT') return 'VISIBLE'; // teachers keep management visibility in every state
  const student =
    rel === 'STUDENT_ACTIVE' ||
    rel === 'STUDENT_LEFT' ||
    rel === 'STUDENT_PENDING';
  if (world.locked) return student ? 'LOCKED' : 'NOT_FOUND';
  if (world.status === 'DRAFT') return 'NOT_FOUND';
  if (world.status === 'ARCHIVED')
    return rel === 'STUDENT_ACTIVE' || rel === 'STUDENT_LEFT'
      ? 'VISIBLE'
      : 'NOT_FOUND';
  // PUBLISHED
  if (student || rel === 'INVITEE') return 'VISIBLE';
  return world.policy === 'INVITATION_ONLY' ? 'NOT_FOUND' : 'VISIBLE'; // NONE, REMOVED, REJECTED are like any visitor
}

async function buildWorld(world: World) {
  await resetData(pool);
  const courseId = await createCourse(pool, {
    title: `World ${world.name}`,
    summary: 'A summary that is long enough',
    categoryId: world.status === 'DRAFT' ? null : await createCategory(pool),
    status: world.status,
    enrollmentPolicy: world.policy,
    firstPublishedAt: world.status === 'DRAFT' ? null : new Date(),
    archivedAt: world.status === 'ARCHIVED' ? new Date() : null,
    lockedByAdminAt: world.locked ? new Date() : null,
  });
  const people = {} as Record<CourseRelationship, string>;
  for (const rel of COURSE_RELATIONSHIPS)
    people[rel] = (await createUser(pool)).id;
  await addCourseTeacher(pool, courseId, people.OWNER, 'OWNER');
  await addCourseTeacher(
    pool,
    courseId,
    people.ASSISTANT,
    'ASSISTANT',
    people.OWNER,
  );
  await createEnrollment(pool, courseId, people.STUDENT_ACTIVE, {
    status: 'ACTIVE',
  });
  await createEnrollment(pool, courseId, people.STUDENT_PENDING, {
    status: 'PENDING',
  });
  await createEnrollment(pool, courseId, people.STUDENT_LEFT, {
    status: 'LEFT',
    leftAt: new Date(),
  });
  await createEnrollment(pool, courseId, people.REMOVED, { status: 'REMOVED' });
  await createEnrollment(pool, courseId, people.REJECTED, {
    status: 'REJECTED',
  });
  await createInvitation(pool, courseId, people.INVITEE, people.OWNER);
  return { courseId, people };
}

describe('behavior: course relationships (every course route x every relationship x five course states)', () => {
  const courseRoutes = () => routes.filter((r) => r.courseRoles);

  it('covers the course routes', () =>
    expect(courseRoutes().length).toBe(Object.keys(COURSE_ROUTES).length));

  it.each(WORLDS)('$name', async (world) => {
    const { courseId, people } = await buildWorld(world);
    let checked = 0;
    for (const route of courseRoutes()) {
      const allowed = route.courseRoles as CourseRelationship[];
      for (const rel of COURSE_RELATIONSHIPS) {
        const seen = visible(world, rel);
        const expected: Outcome =
          seen === 'NOT_FOUND'
            ? { status: 404, code: 'NOT_FOUND' }
            : seen === 'LOCKED'
              ? { status: 403, code: 'COURSE_ADMIN_LOCKED' }
              : allowed.includes(rel)
                ? 'PASS'
                : { status: 403, code: 'FORBIDDEN' };
        const request = { params: { courseId }, user: { id: people[rel] } };
        const actual = await outcomeOf(() =>
          courseGuard.canActivate(execution(route, request)),
        );
        expect([route.key, rel, actual]).toEqual([route.key, rel, expected]);
        checked++;
      }
    }
    expect(checked).toBe(Object.keys(COURSE_ROUTES).length * 9);
  });

  it('an anonymous caller is NONE: the public pages of an open published course only; a bad id is a 400, an unknown course a 404', async () => {
    const open = await buildWorld(WORLDS[0]);
    const route = routes.find(
      (r) => r.key === 'GET /courses/:courseId',
    ) as RouteInfo;
    expect(
      await outcomeOf(() =>
        courseGuard.canActivate(
          execution(route, { params: { courseId: open.courseId } }),
        ),
      ),
    ).toBe('PASS');
    expect(
      await outcomeOf(() =>
        courseGuard.canActivate(
          execution(route, { params: { courseId: 'not-a-uuid' } }),
        ),
      ),
    ).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(
      await outcomeOf(() =>
        courseGuard.canActivate(
          execution(route, {
            params: { courseId: '018f0000-0000-7000-8000-0000000000aa' },
            user: { id: open.people.NONE },
          }),
        ),
      ),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    const invite = await buildWorld(WORLDS[1]);
    expect(
      await outcomeOf(() =>
        courseGuard.canActivate(
          execution(route, { params: { courseId: invite.courseId } }),
        ),
      ),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it('every status the guards produce is in the registry', () => {
    expect(ERROR_CODES.COURSE_ADMIN_LOCKED.status).toEqual([403, 409]);
    expect(ERROR_CODES.NOT_FOUND.status).toBe(404);
  });
});
