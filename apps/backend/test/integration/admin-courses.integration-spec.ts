// M12b: Admin and courses/catalog against the real database over HTTP: the course list and read-only review, the takedown (`lock`,
// `unlock`, `restore`) with its races against the Owner, ownership transfer, removing and reinstating students, categories and tag merge.
import type { NestExpressApplication } from '@nestjs/platform-express';
import type request from 'supertest';
import { createAdminApp, type AdminTestApp } from '../support/admin-app.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
} from '../support/factories.js';
import { addMember, createChannel } from '../support/factories-chat.js';
import {
  createLesson,
  createSection,
  createTextBlock,
} from '../support/factories-content.js';
import {
  addCourseTeacher,
  createCourse,
  createPublishedCourse,
  createTag,
} from '../support/factories-courses.js';
import { createEnrollment } from '../support/factories-learning.js';
import { holdTx, releaseAll, settlesWithin } from '../support/parallel-tx.js';

const pool = createPool(30);
let t: AdminTestApp;
let app: NestExpressApplication;

beforeAll(async () => {
  t = await createAdminApp();
  app = t.app;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
afterEach(() => releaseAll());
beforeEach(async () => {
  await resetData(pool);
  t.events.length = 0;
});

const auditRows = async (action: string) =>
  (
    await pool.query<{
      actor_id: string;
      target_id: string;
      metadata: Record<string, unknown>;
    }>(
      'SELECT actor_id, target_id, metadata FROM audit_logs WHERE action = $1 ORDER BY id',
      [action],
    )
  ).rows;
const auditCount = async () =>
  (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs'))
    .rows[0].n;
const courseRow = async (courseId: string) =>
  (
    await pool.query<{
      status: string;
      locked_by_admin_at: Date | null;
      archived_at: Date | null;
    }>(
      'SELECT status, locked_by_admin_at, archived_at FROM courses WHERE id = $1',
      [courseId],
    )
  ).rows[0];

async function world(status: 'PUBLISHED' | 'ARCHIVED' = 'PUBLISHED') {
  const admin = await createAdmin(pool);
  const owner = await createTeacher(pool);
  const assistant = await createTeacher(pool);
  const student = await createUser(pool);
  const courseId = await createPublishedCourse(pool, {
    status,
    archivedAt: status === 'ARCHIVED' ? new Date() : null,
  });
  await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
  await addCourseTeacher(pool, courseId, assistant.id, 'ASSISTANT', owner.id);
  await createEnrollment(pool, courseId, student.id);
  const channel = await createChannel(pool, courseId);
  for (const id of [owner.id, assistant.id, student.id])
    await addMember(pool, channel, id);
  return { admin, owner, assistant, student, courseId };
}

describe('the course list and the read-only review', () => {
  it('lists courses of every status with the Owner, the lock and the student count, filtered and paged', async () => {
    const { admin, owner, courseId } = await world();
    const draft = await createCourse(pool, { title: 'Zebra draft' });
    await addCourseTeacher(pool, draft, owner.id, 'OWNER');
    const locked = await createPublishedCourse(pool, {
      status: 'ARCHIVED',
      archivedAt: new Date(),
      lockedByAdminAt: new Date(),
    });
    await addCourseTeacher(pool, locked, owner.id, 'OWNER');
    const all = await t.call('get', '/admin/courses', admin.id).expect(200);
    expect(all.body.total).toBe(3);
    const item = all.body.items.find((c: { id: string }) => c.id === courseId);
    expect(item).toMatchObject({
      status: 'PUBLISHED',
      lockedByAdminAt: null,
      activeStudents: 1,
      owner: { id: owner.id },
    });
    const only = async (qs: string) =>
      (
        await t.call('get', `/admin/courses?${qs}`, admin.id).expect(200)
      ).body.items.map((c: { id: string }) => c.id);
    expect(await only('status=DRAFT')).toEqual([draft]);
    expect(await only('locked=true')).toEqual([locked]);
    expect((await only('locked=false')).sort()).toEqual(
      [courseId, draft].sort(),
    );
    expect(await only('q=zebra')).toEqual([draft]);
    expect(await only('q=%25%25')).toEqual([]); // % is a literal
    expect(await only(`teacherId=${owner.id}`)).toHaveLength(3);
    expect(await only('pageSize=2&page=2')).toHaveLength(1);
    await t.call('get', '/admin/courses?status=NOPE', admin.id).expect(400);
  });

  it('shows a course with its team; the outline and any lesson are read-only, work on a locked course and write no audit row', async () => {
    const { admin, owner, courseId } = await world();
    const section = await createSection(pool, courseId);
    const draftLesson = await createLesson(pool, courseId, section, {
      status: 'DRAFT',
    });
    await createTextBlock(pool, draftLesson, 'secret draft text');
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now(), locked_by_admin_at = now() WHERE id = $1",
      [courseId],
    );
    const before = await auditCount();
    const detail = await t
      .call('get', `/admin/courses/${courseId}`, admin.id)
      .expect(200);
    expect(
      detail.body.teachers.map(
        (x: { userId?: string; id?: string }) => x.id ?? x.userId,
      ),
    ).toContain(owner.id);
    expect(detail.body.lockedByAdminAt).not.toBeNull();
    const outline = await t
      .call('get', `/admin/courses/${courseId}/outline`, admin.id)
      .expect(200);
    expect(JSON.stringify(outline.body)).toContain(draftLesson);
    const lesson = await t
      .call(
        'get',
        `/admin/courses/${courseId}/lessons/${draftLesson}`,
        admin.id,
      )
      .expect(200);
    expect(lesson.body.status).toBe('DRAFT');
    expect(JSON.stringify(lesson.body)).toContain('secret draft text');
    expect(await auditCount()).toBe(before);
    // a lesson of another course is not found; so is an unknown course
    const other = await createPublishedCourse(pool);
    await t
      .call('get', `/admin/courses/${other}/lessons/${draftLesson}`, admin.id)
      .expect(404);
    await t
      .call(
        'get',
        '/admin/courses/018f0000-0000-7000-8000-0000000000aa/outline',
        admin.id,
      )
      .expect(404);
    await t
      .call(
        'get',
        '/admin/courses/018f0000-0000-7000-8000-0000000000aa',
        admin.id,
      )
      .expect(404);
  });
});

describe('takedown: lock, unlock, restore', () => {
  it('lock archives and locks a published course, audits the reason, tells the team, and refuses a second lock', async () => {
    const { admin, owner, courseId } = await world();
    const res = await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Copyright complaint',
      })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ARCHIVED' });
    expect(res.body.lockedByAdminAt).not.toBeNull();
    const row = await courseRow(courseId);
    expect(row.status).toBe('ARCHIVED');
    expect(row.locked_by_admin_at).not.toBeNull();
    expect(row.archived_at).not.toBeNull();
    expect(await auditRows('COURSE_ADMIN_LOCKED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: courseId,
        metadata: {
          reason: 'Copyright complaint',
          previousStatus: 'PUBLISHED',
        },
      }),
    ]);
    expect(t.eventsOf('course.admin-locked')).toEqual([
      expect.objectContaining({
        payload: {
          courseId,
          lockedBy: admin.id,
          reason: 'Copyright complaint',
        },
      }),
    ]);
    const again = await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Copyright complaint',
      })
      .expect(409);
    expect(again.body.code).toBe('COURSE_ALREADY_LOCKED');
    expect(t.eventsOf('course.admin-locked')).toHaveLength(1);
    expect(owner.id).toBeTruthy();
  });

  it('lock needs a reason (400); a draft cannot be locked; an already archived course stays archived and gets the lock', async () => {
    const { admin, courseId } = await world('ARCHIVED');
    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {})
      .expect(400);
    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'abc',
      })
      .expect(400); // 5-500 characters
    const archivedBefore = (await courseRow(courseId)).archived_at;
    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(200);
    const row = await courseRow(courseId);
    expect(row.status).toBe('ARCHIVED');
    expect(row.locked_by_admin_at).not.toBeNull();
    expect(row.archived_at).toEqual(archivedBefore); // the original archive time is kept
    const draft = await createCourse(pool);
    await addCourseTeacher(
      pool,
      draft,
      (await createTeacher(pool)).id,
      'OWNER',
    );
    const res = await t
      .call('post', `/admin/courses/${draft}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    await t
      .call(
        'post',
        '/admin/courses/018f0000-0000-7000-8000-0000000000aa/lock',
        admin.id,
        { reason: 'Terms violation' },
      )
      .expect(404);
  });

  it('unlock clears the lock and leaves the course ARCHIVED, and then the Owner can restore it; restore (Admin) publishes it', async () => {
    const { admin, owner, courseId } = await world();
    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(200);
    await t
      .call('post', `/admin/courses/${courseId}/unlock`, admin.id)
      .expect(200);
    let row = await courseRow(courseId);
    expect(row.status).toBe('ARCHIVED');
    expect(row.locked_by_admin_at).toBeNull();
    expect(await auditRows('COURSE_ADMIN_UNLOCKED')).toHaveLength(1);
    await t.call('post', `/courses/${courseId}/restore`, owner.id).expect(200);
    expect((await courseRow(courseId)).status).toBe('PUBLISHED');

    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(200);
    const restored = await t
      .call('post', `/admin/courses/${courseId}/restore`, admin.id)
      .expect(200);
    expect(restored.body.status).toBe('PUBLISHED');
    row = await courseRow(courseId);
    expect(row.status).toBe('PUBLISHED');
    expect(row.locked_by_admin_at).toBeNull();
    expect(row.archived_at).toBeNull();
    expect(await auditRows('COURSE_ADMIN_RESTORED')).toHaveLength(1);
  });

  it('unlock and restore on a course that is not locked are both 409 COURSE_NOT_LOCKED', async () => {
    const { admin, courseId } = await world();
    for (const action of ['unlock', 'restore']) {
      const res = await t
        .call('post', `/admin/courses/${courseId}/${action}`, admin.id)
        .expect(409);
      expect(res.body.code).toBe('COURSE_NOT_LOCKED');
    }
    expect((await courseRow(courseId)).status).toBe('PUBLISHED');
  });

  it('locked-course visibility, end to end: students 403, strangers 404, the team keeps its view, the Owner cannot restore, the catalog hides it, restore brings it back', async () => {
    const { admin, owner, student, courseId } = await world();
    const stranger = await createUser(pool);
    const left = await createUser(pool);
    await createEnrollment(pool, courseId, left.id, {
      status: 'LEFT',
      leftAt: new Date(),
    });
    const removed = await createUser(pool);
    await createEnrollment(pool, courseId, removed.id, { status: 'REMOVED' });
    const listed = async () =>
      (await t.call('get', '/courses?pageSize=50').expect(200)).body.items.map(
        (c: { id: string }) => c.id,
      );
    expect(await listed()).toContain(courseId);

    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(200);

    expect(await listed()).not.toContain(courseId);
    const shut = await t
      .call('get', `/courses/${courseId}`, student.id)
      .expect(403);
    expect(shut.body.code).toBe('COURSE_ADMIN_LOCKED');
    expect(
      (await t.call('get', `/courses/${courseId}`, left.id).expect(403)).body
        .code,
    ).toBe('COURSE_ADMIN_LOCKED');
    await t.call('get', `/courses/${courseId}`, stranger.id).expect(404);
    await t.call('get', `/courses/${courseId}`, removed.id).expect(404);
    await t.call('get', `/courses/${courseId}`).expect(404);
    const seen = await t
      .call('get', `/courses/${courseId}`, owner.id)
      .expect(200);
    expect(seen.body.lockedByAdmin).toBe(true);
    const refused = await t
      .call('post', `/courses/${courseId}/restore`, owner.id)
      .expect(409);
    expect(refused.body.code).toBe('COURSE_ADMIN_LOCKED');
    // enrollment state and progress stay as they were
    expect(
      (
        await pool.query('SELECT status FROM enrollments WHERE user_id = $1', [
          student.id,
        ])
      ).rows[0].status,
    ).toBe('ACTIVE');

    await t
      .call('post', `/admin/courses/${courseId}/restore`, admin.id)
      .expect(200);
    expect(await listed()).toContain(courseId);
    await t.call('get', `/courses/${courseId}`, student.id).expect(200);
  });

  it('Owner restore vs Admin lock, the lock wins in both orders (deterministic)', async () => {
    const { admin, owner, courseId } = await world('ARCHIVED');
    // order 1: the Owner's restore holds the course; the Admin's lock waits for it and then locks the PUBLISHED course
    const held = await holdTx(
      pool,
      'owner-restore',
      'SELECT 1 FROM courses WHERE id = $1 FOR NO KEY UPDATE',
      [courseId],
    );
    const lock = t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .then((r) => r);
    expect(await settlesWithin(lock, 300)).toBe(false);
    await held.client.query(
      "UPDATE courses SET status = 'PUBLISHED', archived_at = NULL WHERE id = $1",
      [courseId],
    );
    await held.release('commit');
    expect((await lock).status).toBe(200);
    let row = await courseRow(courseId);
    expect([row.status, row.locked_by_admin_at !== null]).toEqual([
      'ARCHIVED',
      true,
    ]);

    // order 2: the Admin's lock came first; the Owner's restore is refused
    await pool.query(
      "UPDATE courses SET status = 'ARCHIVED', archived_at = now(), locked_by_admin_at = NULL WHERE id = $1",
      [courseId],
    );
    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(200);
    await t.call('post', `/courses/${courseId}/restore`, owner.id).expect(409);
    row = await courseRow(courseId);
    expect(row.locked_by_admin_at).not.toBeNull();
  });

  it('Owner restore vs Admin lock in parallel (12 rounds): the course always ends locked', async () => {
    for (let round = 0; round < 12; round++) {
      await resetData(pool);
      const { admin, owner, courseId } = await world('ARCHIVED');
      const requests: request.Test[] = [
        t.call('post', `/courses/${courseId}/restore`, owner.id),
        t.call('post', `/admin/courses/${courseId}/lock`, admin.id, {
          reason: 'Terms violation',
        }),
      ];
      if (round % 2 === 1) requests.reverse();
      const [a, b] = await Promise.all(requests);
      expect([a.status, b.status].filter((s) => s >= 500)).toEqual([]);
      const row = await courseRow(courseId);
      expect([row.status, row.locked_by_admin_at !== null]).toEqual([
        'ARCHIVED',
        true,
      ]);
    }
  });
});

describe('ownership and students', () => {
  it('transfers ownership on behalf of the Owner in any status, audited as on-behalf, and tells the new Owner', async () => {
    const { admin, owner, assistant, courseId } = await world('ARCHIVED');
    await pool.query(
      'UPDATE courses SET locked_by_admin_at = now() WHERE id = $1',
      [courseId],
    );
    const res = await t
      .call('post', `/admin/courses/${courseId}/ownership-transfer`, admin.id, {
        newOwnerId: assistant.id,
      })
      .expect(200);
    expect(res.body.owner.id).toBe(assistant.id);
    const roles = await pool.query(
      'SELECT user_id, role FROM course_teachers WHERE course_id = $1',
      [courseId],
    );
    expect(roles.rows).toEqual(
      expect.arrayContaining([
        { user_id: assistant.id, role: 'OWNER' },
        { user_id: owner.id, role: 'ASSISTANT' },
      ]),
    );
    expect(await auditRows('COURSE_OWNERSHIP_TRANSFERRED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        metadata: {
          previousOwnerId: owner.id,
          newOwnerId: assistant.id,
          onBehalf: true,
        },
      }),
    ]);
    expect(t.eventsOf('course.ownership-transferred')).toHaveLength(1);
  });

  it('refuses a new Owner who is not an ACTIVE Teacher, is a student of the course, or is already the Owner (409)', async () => {
    const { admin, owner, student, courseId } = await world();
    const plain = await createUser(pool);
    const revoked = await createTeacher(pool);
    await pool.query(
      "UPDATE user_roles SET status = 'REVOKED' WHERE user_id = $1 AND role = 'TEACHER'",
      [revoked.id],
    );
    const teacherStudent = await createTeacher(pool);
    await createEnrollment(pool, courseId, teacherStudent.id);
    for (const newOwnerId of [
      plain.id,
      revoked.id,
      teacherStudent.id,
      owner.id,
      student.id,
    ]) {
      const res = await t
        .call(
          'post',
          `/admin/courses/${courseId}/ownership-transfer`,
          admin.id,
          {
            newOwnerId,
          },
        )
        .expect(409);
      expect(res.body.code).toBe('RESOURCE_CONFLICT');
    }
    await t
      .call('post', `/admin/courses/${courseId}/ownership-transfer`, admin.id, {
        newOwnerId: '018f0000-0000-7000-8000-0000000000aa',
      })
      .expect(404);
    await t
      .call(
        'post',
        `/admin/courses/${courseId}/ownership-transfer`,
        admin.id,
        {},
      )
      .expect(400);
    expect(
      (
        await pool.query(
          "SELECT user_id FROM course_teachers WHERE course_id = $1 AND role = 'OWNER'",
          [courseId],
        )
      ).rows,
    ).toEqual([{ user_id: owner.id }]);
  });

  it('removes a student in any status (also on a locked course), audited with the Admin as actor; reinstating needs a course that is not locked', async () => {
    const { admin, student, courseId } = await world();
    await t
      .call('post', `/admin/courses/${courseId}/lock`, admin.id, {
        reason: 'Terms violation',
      })
      .expect(200);
    await t
      .call(
        'post',
        `/admin/courses/${courseId}/students/${student.id}/remove`,
        admin.id,
      )
      .expect(204);
    expect(
      (
        await pool.query('SELECT status FROM enrollments WHERE user_id = $1', [
          student.id,
        ])
      ).rows[0].status,
    ).toBe('REMOVED');
    expect(await auditRows('STUDENT_REMOVED')).toEqual([
      expect.objectContaining({ actor_id: admin.id }),
    ]);
    expect(t.eventsOf('enrollment.removed')).toHaveLength(1);
    const refused = await t
      .call(
        'post',
        `/admin/courses/${courseId}/students/${student.id}/reinstate`,
        admin.id,
      )
      .expect(409);
    expect(refused.body.code).toBe('COURSE_ADMIN_LOCKED');
    await t
      .call('post', `/admin/courses/${courseId}/restore`, admin.id)
      .expect(200);
    await t
      .call(
        'post',
        `/admin/courses/${courseId}/students/${student.id}/reinstate`,
        admin.id,
      )
      .expect(204);
    expect(
      (
        await pool.query('SELECT status FROM enrollments WHERE user_id = $1', [
          student.id,
        ])
      ).rows[0].status,
    ).toBe('ACTIVE');
    expect(await auditRows('STUDENT_REINSTATED')).toHaveLength(1);
    const stranger = await createUser(pool);
    await t
      .call(
        'post',
        `/admin/courses/${courseId}/students/${stranger.id}/remove`,
        admin.id,
      )
      .expect(404);
  });
});

describe('categories', () => {
  it('creates, renames and deletes a category with audit rows; the slug is made from the name', async () => {
    const admin = await createAdmin(pool);
    const created = await t
      .call('post', '/admin/categories', admin.id, {
        name: '  Web   Development ',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      name: 'Web Development',
      slug: 'web-development',
    });
    const renamed = await t
      .call('patch', `/admin/categories/${created.body.id}`, admin.id, {
        name: 'Web Engineering',
      })
      .expect(200);
    expect(renamed.body).toMatchObject({ slug: 'web-engineering' });
    expect(
      (await t.call('get', '/admin/categories', admin.id).expect(200)).body,
    ).toHaveLength(1);
    expect((await t.call('get', '/categories').expect(200)).body[0].name).toBe(
      'Web Engineering',
    );
    await t
      .call('delete', `/admin/categories/${created.body.id}`, admin.id)
      .expect(204);
    expect((await pool.query('SELECT 1 FROM categories')).rowCount).toBe(0);
    expect(await auditRows('CATEGORY_CREATED')).toHaveLength(1);
    expect(await auditRows('CATEGORY_UPDATED')).toEqual([
      expect.objectContaining({
        metadata: { from: 'Web Development', to: 'Web Engineering' },
      }),
    ]);
    expect(await auditRows('CATEGORY_DELETED')).toHaveLength(1);
  });

  it('refuses a duplicate (also differing only in case/spacing), a bad name, a rename onto another category, and deleting a category in use', async () => {
    const admin = await createAdmin(pool);
    const first = await t
      .call('post', '/admin/categories', admin.id, { name: 'Design' })
      .expect(201);
    const dup = await t
      .call('post', '/admin/categories', admin.id, { name: ' design ' })
      .expect(409);
    expect(dup.body.code).toBe('RESOURCE_CONFLICT');
    await t
      .call('post', '/admin/categories', admin.id, { name: 'x' })
      .expect(400);
    await t
      .call('post', '/admin/categories', admin.id, { name: '!!!' })
      .expect(400);
    await t
      .call('post', '/admin/categories', admin.id, { name: 'a'.repeat(61) })
      .expect(400);
    await t.call('post', '/admin/categories', admin.id, {}).expect(400);
    const second = await t
      .call('post', '/admin/categories', admin.id, { name: 'Music' })
      .expect(201);
    await t
      .call('patch', `/admin/categories/${second.body.id}`, admin.id, {
        name: 'DESIGN',
      })
      .expect(409);
    // renaming to the same slug as itself (a capitalization change) is fine
    await t
      .call('patch', `/admin/categories/${second.body.id}`, admin.id, {
        name: 'MUSIC',
      })
      .expect(200);
    await createPublishedCourse(pool, { categoryId: first.body.id });
    const inUse = await t
      .call('delete', `/admin/categories/${first.body.id}`, admin.id)
      .expect(409);
    expect(inUse.body.code).toBe('RESOURCE_CONFLICT');
    expect((await pool.query('SELECT 1 FROM categories')).rowCount).toBe(2);
    await t
      .call(
        'patch',
        '/admin/categories/018f0000-0000-7000-8000-0000000000aa',
        admin.id,
        { name: 'Nope' },
      )
      .expect(404);
    await t
      .call(
        'delete',
        '/admin/categories/018f0000-0000-7000-8000-0000000000aa',
        admin.id,
      )
      .expect(404);
  });

  it('works for Armenian names', async () => {
    const admin = await createAdmin(pool);
    const res = await t
      .call('post', '/admin/categories', admin.id, { name: 'Ծրագրավորում' })
      .expect(201);
    expect(res.body.slug).toBe('ծրագրավորում');
  });
});

describe('tags and the merge', () => {
  const tagIdsOf = async (courseId: string) =>
    (
      await pool.query<{ tag_id: string }>(
        'SELECT tag_id FROM course_tags WHERE course_id = $1 ORDER BY tag_id',
        [courseId],
      )
    ).rows.map((r) => r.tag_id);
  const link = (courseId: string, tagId: string) =>
    pool.query('INSERT INTO course_tags (course_id, tag_id) VALUES ($1, $2)', [
      courseId,
      tagId,
    ]);

  it('lists tags with their course counts, most used first, filtered by the start of the name', async () => {
    const admin = await createAdmin(pool);
    const js = await createTag(pool, {
      name: 'javascript',
      slug: 'javascript',
    });
    const java = await createTag(pool, { name: 'java', slug: 'java' });
    await createTag(pool, { name: 'python', slug: 'python' });
    const c1 = await createPublishedCourse(pool);
    const c2 = await createPublishedCourse(pool);
    await link(c1, js);
    await link(c2, js);
    await link(c1, java);
    const all = await t.call('get', '/admin/tags', admin.id).expect(200);
    expect(
      all.body.items.map((x: { name: string; courseCount: number }) => [
        x.name,
        x.courseCount,
      ]),
    ).toEqual([
      ['javascript', 2],
      ['java', 1],
      ['python', 0],
    ]);
    const filtered = await t
      .call('get', '/admin/tags?q=jav', admin.id)
      .expect(200);
    expect(filtered.body.total).toBe(2);
    expect(
      (await t.call('get', '/admin/tags?q=%25%25', admin.id).expect(200)).body
        .total,
    ).toBe(0);
  });

  it('merges: courses with only the source get the target, courses with both keep one link, the source tag is gone, one audit row', async () => {
    const admin = await createAdmin(pool);
    const source = await createTag(pool, { name: 'js', slug: 'js' });
    const target = await createTag(pool, {
      name: 'javascript',
      slug: 'javascript',
    });
    const onlySource = await createPublishedCourse(pool);
    const both = await createPublishedCourse(pool);
    const onlyTarget = await createPublishedCourse(pool);
    await link(onlySource, source);
    await link(both, source);
    await link(both, target);
    await link(onlyTarget, target);
    const res = await t
      .call('post', `/admin/tags/${source}/merge`, admin.id, {
        targetTagId: target,
      })
      .expect(200);
    expect(res.body).toEqual({
      sourceId: source,
      targetId: target,
      moved: 1,
      alreadyTagged: 1,
    });
    expect(await tagIdsOf(onlySource)).toEqual([target]);
    expect(await tagIdsOf(both)).toEqual([target]);
    expect(await tagIdsOf(onlyTarget)).toEqual([target]);
    expect(
      (await pool.query('SELECT 1 FROM tags WHERE id = $1', [source])).rowCount,
    ).toBe(0);
    expect(await auditRows('TAG_MERGED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: target,
        metadata: expect.objectContaining({
          sourceId: source,
          moved: 1,
          alreadyTagged: 1,
        }),
      }),
    ]);
  });

  it('refuses merging a tag into itself (400) and unknown tags (404); nothing changes', async () => {
    const admin = await createAdmin(pool);
    const tag = await createTag(pool);
    const res = await t
      .call('post', `/admin/tags/${tag}/merge`, admin.id, { targetTagId: tag })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    await t
      .call('post', `/admin/tags/${tag}/merge`, admin.id, {
        targetTagId: '018f0000-0000-7000-8000-0000000000aa',
      })
      .expect(404);
    await t
      .call(
        'post',
        `/admin/tags/018f0000-0000-7000-8000-0000000000aa/merge`,
        admin.id,
        {
          targetTagId: tag,
        },
      )
      .expect(404);
    await t.call('post', `/admin/tags/${tag}/merge`, admin.id, {}).expect(400);
    expect((await pool.query('SELECT 1 FROM tags')).rowCount).toBe(1);
    expect(await auditRows('TAG_MERGED')).toHaveLength(0);
  });

  it('two merges of the same tags in opposite directions do not deadlock: one wins, the other finds its source gone', async () => {
    for (let round = 0; round < 8; round++) {
      await resetData(pool);
      const admin = await createAdmin(pool);
      const a = await createTag(pool);
      const b = await createTag(pool);
      const course = await createPublishedCourse(pool);
      await link(course, a);
      const [r1, r2] = await Promise.all([
        t.call('post', `/admin/tags/${a}/merge`, admin.id, { targetTagId: b }),
        t.call('post', `/admin/tags/${b}/merge`, admin.id, { targetTagId: a }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 404]);
      expect((await pool.query('SELECT 1 FROM tags')).rowCount).toBe(1);
      expect((await tagIdsOf(course)).length).toBe(1);
    }
  });

  it('the tag lock is taken first: a merge waits for a held tag row and is not partly done', async () => {
    const admin = await createAdmin(pool);
    const source = await createTag(pool);
    const target = await createTag(pool);
    const course = await createPublishedCourse(pool);
    await link(course, source);
    const held = await holdTx(
      pool,
      'tag',
      'SELECT 1 FROM tags WHERE id = $1 FOR NO KEY UPDATE',
      [target],
    );
    const merge = t
      .call('post', `/admin/tags/${source}/merge`, admin.id, {
        targetTagId: target,
      })
      .then((r) => r);
    expect(await settlesWithin(merge, 300)).toBe(false);
    expect(await tagIdsOf(course)).toEqual([source]); // nothing moved yet
    await held.release('commit');
    expect((await merge).status).toBe(200);
    expect(await tagIdsOf(course)).toEqual([target]);
  });
});
