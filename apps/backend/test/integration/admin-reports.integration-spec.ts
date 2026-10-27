// M12c: Admin and reports against the real database over HTTP: the queue, the separately audited context, dismiss and action, the
// sibling-report resolution (Bug 2: no deadlock, REPORT_ALREADY_RESOLVED), the audit-log viewer and the statistics.
import type { NestExpressApplication } from '@nestjs/platform-express';
import type request from 'supertest';
import { createAdminApp, type AdminTestApp } from '../support/admin-app.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createAuditEntry,
  createTeacher,
  createUser,
} from '../support/factories.js';
import {
  createDirectConversation,
  createMessage,
  reportMessage,
  reportUser,
} from '../support/factories-chat.js';
import {
  addCourseTeacher,
  createCourse,
  createPublishedCourse,
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
const reportRow = async (id: string) =>
  (
    await pool.query<{
      status: string;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      resolution_note: string | null;
    }>(
      'SELECT status, reviewed_by, reviewed_at, resolution_note FROM reports WHERE id = $1',
      [id],
    )
  ).rows[0];
const messageRow = async (id: string) =>
  (
    await pool.query<{ deleted_at: Date | null; deleted_by: string | null }>(
      'SELECT deleted_at, deleted_by FROM messages WHERE id = $1',
      [id],
    )
  ).rows[0];

/** A DM between `author` and `other`, a message by the author with `siblings + 1` OPEN reports about it (by distinct reporters). */
async function reported(siblings = 2) {
  const admin = await createAdmin(pool);
  const author = await createUser(pool, { fullName: 'Author Person' });
  const other = await createUser(pool);
  const conversation = await createDirectConversation(
    pool,
    author.id,
    other.id,
  );
  const messageId = await createMessage(pool, conversation, author.id, {
    body: 'buy cheap pills',
  });
  const reports: string[] = [
    await reportMessage(pool, other.id, messageId, {
      snapshot: 'buy cheap pills',
    }),
  ];
  for (let i = 0; i < siblings; i++) {
    const reporter = await createUser(pool);
    reports.push(
      await reportMessage(pool, reporter.id, messageId, {
        snapshot: 'buy cheap pills',
      }),
    );
  }
  reports.sort(); // ascending id: the lock order
  return { admin, author, other, conversation, messageId, reports };
}

describe('the queue', () => {
  it('lists OPEN reports oldest first with the reporter and the target, filtered by type, reason and status, and paged', async () => {
    const { admin, author, reports } = await reported(1);
    const target = await createUser(pool, { fullName: 'Target Person' });
    const reporter = await createUser(pool);
    const userReport = await reportUser(pool, reporter.id, target.id, {
      reason: 'HARASSMENT',
    });
    const all = await t.call('get', '/admin/reports', admin.id).expect(200);
    expect(all.body.total).toBe(3);
    const ids = all.body.items.map((r: { id: string }) => r.id);
    expect(ids).toEqual([...reports, userReport].sort());
    const msg = all.body.items.find((r: { id: string }) => r.id === reports[0]);
    expect(msg).toMatchObject({
      targetType: 'MESSAGE',
      status: 'OPEN',
      message: {
        author: { id: author.id, fullName: 'Author Person' },
        deleted: false,
      },
      targetUser: null,
    });
    expect(JSON.stringify(all.body)).not.toContain('buy cheap pills'); // the list shows no text
    const usr = all.body.items.find((r: { id: string }) => r.id === userReport);
    expect(usr).toMatchObject({
      targetType: 'USER',
      reason: 'HARASSMENT',
      targetUser: { fullName: 'Target Person' },
      message: null,
    });
    expect(
      (await t.call('get', '/admin/reports?targetType=USER', admin.id)).body
        .total,
    ).toBe(1);
    expect(
      (await t.call('get', '/admin/reports?reason=HARASSMENT', admin.id)).body
        .total,
    ).toBe(1);
    expect(
      (await t.call('get', '/admin/reports?status=DISMISSED', admin.id)).body
        .total,
    ).toBe(0);
    expect(
      (await t.call('get', '/admin/reports?pageSize=2&page=2', admin.id)).body
        .items,
    ).toHaveLength(1);
    await t.call('get', '/admin/reports?status=NOPE', admin.id).expect(400);
  });

  it('shows one report with the evidence snapshot (not the live text), the open siblings and no conversation', async () => {
    const { admin, messageId, reports } = await reported(2);
    await pool.query(
      "UPDATE messages SET body = 'edited afterwards' WHERE id = $1",
      [messageId],
    );
    const before = await auditCount();
    const res = await t
      .call('get', `/admin/reports/${reports[0]}`, admin.id)
      .expect(200);
    expect(res.body).toMatchObject({
      id: reports[0],
      snapshot: 'buy cheap pills',
      openSiblings: 2,
      reviewedBy: null,
      resolutionNote: null,
    });
    expect(JSON.stringify(res.body)).not.toContain('edited afterwards');
    expect(await auditCount()).toBe(before); // reading a report writes no audit row
    await t
      .call(
        'get',
        '/admin/reports/018f0000-0000-7000-8000-0000000000aa',
        admin.id,
      )
      .expect(404);
  });
});

describe('context', () => {
  async function conversationOf30() {
    const admin = await createAdmin(pool);
    const a = await createUser(pool, { fullName: 'Ann' });
    const b = await createUser(pool, { fullName: 'Bob' });
    const conversation = await createDirectConversation(pool, a.id, b.id);
    const ids: string[] = [];
    for (let seq = 1; seq <= 30; seq++)
      ids.push(
        await createMessage(pool, conversation, seq % 2 ? a.id : b.id, {
          seq,
          body: `message ${seq}`,
          ...(seq === 14 ? { deletedAt: new Date(), deletedBy: a.id } : {}),
        }),
      );
    const reportId = await reportMessage(pool, b.id, ids[14], {
      snapshot: 'message 15',
    });
    return { admin, a, b, conversation, ids, reportId };
  }

  it('shows the reported message with ten messages each side and no more, hides deleted text, and audits EVERY viewing', async () => {
    const { admin, ids, reportId, conversation } = await conversationOf30();
    const res = await t
      .call('get', `/admin/reports/${reportId}/context`, admin.id)
      .expect(200);
    expect(res.body.conversationId).toBe(conversation);
    expect(res.body.snapshot).toBe('message 15');
    const seqs = res.body.messages.map((m: { seq: number }) => m.seq);
    expect(seqs).toEqual(Array.from({ length: 21 }, (_, i) => i + 5)); // 5..25
    const reported = res.body.messages.filter(
      (m: { reported: boolean }) => m.reported,
    );
    expect(reported).toEqual([
      expect.objectContaining({ id: ids[14], seq: 15, body: 'message 15' }),
    ]);
    const deleted = res.body.messages.find(
      (m: { seq: number }) => m.seq === 14,
    );
    expect(deleted).toMatchObject({ deleted: true, body: null });
    expect(JSON.stringify(res.body)).not.toContain('message 14');
    expect(JSON.stringify(res.body)).not.toContain('message 4"');
    expect(await auditRows('REPORT_CONTEXT_VIEWED')).toHaveLength(1);
    await t
      .call('get', `/admin/reports/${reportId}/context`, admin.id)
      .expect(200);
    const rows = await auditRows('REPORT_CONTEXT_VIEWED');
    expect(rows).toHaveLength(2); // each time
    expect(rows[0]).toMatchObject({
      actor_id: admin.id,
      target_id: reportId,
      metadata: expect.objectContaining({ messageId: ids[14], shown: 21 }),
    });
  });

  it('near the start of the conversation it shows what exists', async () => {
    const admin = await createAdmin(pool);
    const a = await createUser(pool);
    const b = await createUser(pool);
    const conversation = await createDirectConversation(pool, a.id, b.id);
    const ids = [];
    for (let seq = 1; seq <= 4; seq++)
      ids.push(await createMessage(pool, conversation, a.id, { seq }));
    const reportId = await reportMessage(pool, b.id, ids[1]);
    const res = await t
      .call('get', `/admin/reports/${reportId}/context`, admin.id)
      .expect(200);
    expect(res.body.messages).toHaveLength(4);
  });

  it('no other report endpoint writes REPORT_CONTEXT_VIEWED; a user report has no context (400) and an unknown report is 404', async () => {
    const { admin, reports } = await reported(1);
    await t.call('get', '/admin/reports', admin.id).expect(200);
    await t.call('get', `/admin/reports/${reports[0]}`, admin.id).expect(200);
    await t
      .call('post', `/admin/reports/${reports[0]}/dismiss`, admin.id, {})
      .expect(200);
    await t
      .call('post', `/admin/reports/${reports[1]}/action`, admin.id, {
        deleteMessage: true,
      })
      .expect(200);
    expect(await auditRows('REPORT_CONTEXT_VIEWED')).toHaveLength(0);
    const target = await createUser(pool);
    const userReport = await reportUser(
      pool,
      (await createUser(pool)).id,
      target.id,
    );
    const res = await t
      .call('get', `/admin/reports/${userReport}/context`, admin.id)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    await t
      .call(
        'get',
        '/admin/reports/018f0000-0000-7000-8000-0000000000aa/context',
        admin.id,
      )
      .expect(404);
    expect(await auditRows('REPORT_CONTEXT_VIEWED')).toHaveLength(0); // refused views are not "viewed"
  });
});

describe('dismiss and action', () => {
  it('dismiss closes only that report, records who/when/why, audits it, and cannot be repeated (409 REPORT_ALREADY_RESOLVED)', async () => {
    const { admin, messageId, reports } = await reported(2);
    const res = await t
      .call('post', `/admin/reports/${reports[0]}/dismiss`, admin.id, {
        note: 'not abuse',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'DISMISSED',
      resolutionNote: 'not abuse',
      reviewedBy: { id: admin.id },
    });
    expect(await reportRow(reports[0])).toMatchObject({
      status: 'DISMISSED',
      reviewed_by: admin.id,
      resolution_note: 'not abuse',
    });
    expect((await reportRow(reports[0])).reviewed_at).not.toBeNull();
    expect((await reportRow(reports[1])).status).toBe('OPEN');
    expect((await messageRow(messageId)).deleted_at).toBeNull();
    expect(await auditRows('REPORT_DISMISSED')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: reports[0],
        metadata: expect.objectContaining({
          note: 'not abuse',
          closedSiblings: [],
        }),
      }),
    ]);
    for (const path of ['dismiss', 'action']) {
      const again = await t
        .call('post', `/admin/reports/${reports[0]}/${path}`, admin.id, {})
        .expect(409);
      expect(again.body.code).toBe('REPORT_ALREADY_RESOLVED');
    }
    await t
      .call('post', `/admin/reports/${reports[0]}/dismiss`, admin.id, {
        note: '',
      })
      .expect(400);
    await t
      .call(
        'post',
        '/admin/reports/018f0000-0000-7000-8000-0000000000aa/dismiss',
        admin.id,
        {},
      )
      .expect(404);
  });

  it('action without deleting leaves the message and the sibling reports alone', async () => {
    const { admin, messageId, reports } = await reported(2);
    await t
      .call('post', `/admin/reports/${reports[1]}/action`, admin.id, {
        note: 'warned',
      })
      .expect(200);
    expect((await reportRow(reports[1])).status).toBe('ACTIONED');
    expect((await reportRow(reports[0])).status).toBe('OPEN');
    expect((await reportRow(reports[2])).status).toBe('OPEN');
    expect((await messageRow(messageId)).deleted_at).toBeNull();
    expect(await auditRows('MESSAGE_DELETED_BY_MODERATOR')).toHaveLength(0);
    expect(await auditRows('REPORT_ACTIONED')).toHaveLength(1);
  });

  it("action with deleteMessage deletes the message (the only way an Admin deletes another person's), closes every OPEN sibling, keeps handled ones, audits and announces", async () => {
    const { admin, author, conversation, messageId, reports } =
      await reported(3);
    const reporter = await createUser(pool);
    const earlier = await reportMessage(pool, reporter.id, messageId, {
      status: 'DISMISSED',
      reviewedBy: admin.id,
      reviewedAt: new Date(),
      resolutionNote: 'earlier decision',
    });
    const res = await t
      .call('post', `/admin/reports/${reports[1]}/action`, admin.id, {
        note: 'spam',
        deleteMessage: true,
      })
      .expect(200);
    expect(res.body.status).toBe('ACTIONED');
    expect(res.body.message.deleted).toBe(true);
    expect(await messageRow(messageId)).toMatchObject({ deleted_by: admin.id });
    expect((await messageRow(messageId)).deleted_at).not.toBeNull();
    for (const id of reports) {
      expect(await reportRow(id)).toMatchObject({
        status: 'ACTIONED',
        reviewed_by: admin.id,
        resolution_note: 'spam',
      });
    }
    expect(await reportRow(earlier)).toMatchObject({
      status: 'DISMISSED',
      resolution_note: 'earlier decision',
    });
    expect(await auditRows('MESSAGE_DELETED_BY_MODERATOR')).toEqual([
      expect.objectContaining({
        actor_id: admin.id,
        target_id: messageId,
        metadata: expect.objectContaining({
          conversationId: conversation,
          authorId: author.id,
          reportId: reports[1],
        }),
      }),
    ]);
    const actioned = await auditRows('REPORT_ACTIONED');
    expect(actioned).toHaveLength(1);
    expect(actioned[0].metadata).toMatchObject({ messageDeleted: true });
    expect((actioned[0].metadata.closedSiblings as string[]).sort()).toEqual(
      [reports[0], reports[2], reports[3]].sort(),
    );
    expect(t.eventsOf('message.deleted')).toEqual([
      expect.objectContaining({
        payload: { conversationId: conversation, messageId },
      }),
    ]);
    // the deleted text is no longer shown to anyone
    const context = await t
      .call('get', `/admin/reports/${reports[0]}/context`, admin.id)
      .expect(200);
    expect(JSON.stringify(context.body.messages)).not.toContain(
      'buy cheap pills',
    );
    expect(context.body.snapshot).toBe('buy cheap pills'); // the evidence stays
  });

  it('deleting a message that is already deleted is harmless: the report is closed, no second deletion audit row', async () => {
    const { admin, messageId, reports } = await reported(0);
    await pool.query(
      'UPDATE messages SET deleted_at = now(), deleted_by = sender_id WHERE id = $1',
      [messageId],
    );
    await t
      .call('post', `/admin/reports/${reports[0]}/action`, admin.id, {
        deleteMessage: true,
      })
      .expect(200);
    expect(await auditRows('MESSAGE_DELETED_BY_MODERATOR')).toHaveLength(0);
    expect((await reportRow(reports[0])).status).toBe('ACTIONED');
  });

  it('a user report can be actioned or dismissed; deleting a message of a user report is 400 and changes nothing', async () => {
    const admin = await createAdmin(pool);
    const target = await createUser(pool);
    const first = await reportUser(
      pool,
      (await createUser(pool)).id,
      target.id,
    );
    const second = await reportUser(
      pool,
      (await createUser(pool)).id,
      target.id,
    );
    const bad = await t
      .call('post', `/admin/reports/${first}/action`, admin.id, {
        deleteMessage: true,
      })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect((await reportRow(first)).status).toBe('OPEN');
    await t
      .call('post', `/admin/reports/${first}/action`, admin.id, {
        note: 'banned elsewhere',
      })
      .expect(200);
    await t
      .call('post', `/admin/reports/${second}/dismiss`, admin.id, {})
      .expect(200);
    expect((await reportRow(first)).status).toBe('ACTIONED');
    expect((await reportRow(second)).status).toBe('DISMISSED');
    const handled = await t
      .call('get', '/admin/reports?status=ACTIONED', admin.id)
      .expect(200);
    expect(handled.body.items.map((r: { id: string }) => r.id)).toEqual([
      first,
    ]);
  });

  it('is atomic: when the audit row cannot be written nothing is deleted or closed', async () => {
    const { admin, messageId, reports } = await reported(1);
    await pool.query(
      `CREATE OR REPLACE FUNCTION fail_report_audit() RETURNS trigger AS $$ BEGIN
         IF NEW.action = 'REPORT_ACTIONED' THEN RAISE EXCEPTION 'audit write refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      'CREATE TRIGGER fail_report_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_report_audit()',
    );
    try {
      await t
        .call('post', `/admin/reports/${reports[0]}/action`, admin.id, {
          deleteMessage: true,
        })
        .expect(500);
    } finally {
      await pool.query('DROP TRIGGER fail_report_audit ON audit_logs');
      await pool.query('DROP FUNCTION fail_report_audit()');
    }
    expect((await messageRow(messageId)).deleted_at).toBeNull();
    expect((await reportRow(reports[0])).status).toBe('OPEN');
    expect((await reportRow(reports[1])).status).toBe('OPEN');
    expect(await auditRows('MESSAGE_DELETED_BY_MODERATOR')).toHaveLength(0);
    expect(t.eventsOf('message.deleted')).toHaveLength(0);
  });
});

describe('Bug 2: sibling reports resolved at the same time', () => {
  it('takes the Message lock BEFORE any Report lock: waiting at the message, no report row is locked', async () => {
    const { admin, messageId, reports } = await reported(2);
    const held = await holdTx(
      pool,
      'message',
      'SELECT 1 FROM messages WHERE id = $1 FOR NO KEY UPDATE',
      [messageId],
    );
    const first = t
      .call('post', `/admin/reports/${reports[0]}/action`, admin.id, {
        deleteMessage: true,
      })
      .then((r) => r);
    const last = t
      .call('post', `/admin/reports/${reports[2]}/action`, admin.id, {
        deleteMessage: true,
      })
      .then((r) => r);
    expect(await settlesWithin(Promise.all([first, last]), 400)).toBe(false);
    // both are queued at the message; if either had locked a report first, this would fail at once
    const free = await pool.query(
      'SELECT id FROM reports WHERE id = ANY($1::uuid[]) FOR UPDATE NOWAIT',
      [reports],
    );
    expect(free.rowCount).toBe(3);
    await held.release('commit');
    const results = await Promise.all([first, last]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe(
      'REPORT_ALREADY_RESOLVED',
    );
    for (const id of reports)
      expect((await reportRow(id)).status).toBe('ACTIONED');
    expect(await auditRows('MESSAGE_DELETED_BY_MODERATOR')).toHaveLength(1);
  });

  it('two Admins resolving the first and the last report of one message in parallel (15 rounds): no deadlock, one wins, the other gets REPORT_ALREADY_RESOLVED', async () => {
    for (let round = 0; round < 15; round++) {
      await resetData(pool);
      const { admin, reports } = await reported(2);
      const second = await createAdmin(pool);
      const requests: request.Test[] = [
        t.call('post', `/admin/reports/${reports[0]}/action`, admin.id, {
          deleteMessage: true,
        }),
        t.call('post', `/admin/reports/${reports[2]}/action`, second.id, {
          deleteMessage: true,
        }),
      ];
      if (round % 2 === 1) requests.reverse();
      const results = await Promise.all(requests);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'REPORT_ALREADY_RESOLVED',
      );
      for (const id of reports)
        expect((await reportRow(id)).status).toBe('ACTIONED');
    }
  });

  it('a dismiss, an action and an action of three siblings together (12 rounds): no 5xx, nothing left open, the message deleted once', async () => {
    for (let round = 0; round < 12; round++) {
      await resetData(pool);
      const { admin, messageId, reports } = await reported(2);
      const requests: request.Test[] = [
        t.call('post', `/admin/reports/${reports[1]}/dismiss`, admin.id, {}),
        t.call('post', `/admin/reports/${reports[0]}/action`, admin.id, {
          deleteMessage: true,
        }),
        t.call('post', `/admin/reports/${reports[2]}/action`, admin.id, {
          deleteMessage: true,
        }),
      ];
      if (round % 3 === 1) requests.reverse();
      if (round % 3 === 2) requests.push(requests.shift() as request.Test);
      const results = await Promise.all(requests);
      expect(results.filter((r) => r.status >= 500)).toEqual([]);
      expect(
        results
          .filter((r) => r.status === 409)
          .every((r) => r.body.code === 'REPORT_ALREADY_RESOLVED'),
      ).toBe(true);
      expect(results.some((r) => r.status === 200)).toBe(true);
      for (const id of reports)
        expect((await reportRow(id)).status).not.toBe('OPEN');
      expect(await auditRows('MESSAGE_DELETED_BY_MODERATOR')).toHaveLength(
        results.filter((r) => r.status === 200).length > 0 ? 1 : 0,
      );
      expect((await messageRow(messageId)).deleted_at).not.toBeNull();
    }
  });
});

describe('the audit-log viewer', () => {
  it('pages newest first with a cursor and filters by actor, action, target type and target', async () => {
    const admin = await createAdmin(pool);
    const other = await createAdmin(pool);
    const target = await createUser(pool);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        await createAuditEntry(pool, i % 2 ? other.id : admin.id, {
          action: i < 3 ? 'USER_SUSPENDED' : 'COURSE_ARCHIVED',
          targetType: i < 3 ? 'USER' : 'COURSE',
          targetId: i === 0 ? target.id : undefined,
          metadata: { i },
        }),
      );
    const page1 = await t
      .call('get', '/admin/audit-logs?limit=2', admin.id)
      .expect(200);
    expect(page1.body.items.map((x: { id: string }) => x.id)).toEqual([
      ids[4],
      ids[3],
    ]);
    expect(page1.body.items[0]).toMatchObject({
      action: 'COURSE_ARCHIVED',
      metadata: { i: 4 },
      actor: { id: admin.id },
    });
    expect(page1.body.nextCursor).toBe(ids[3]);
    const page2 = await t
      .call(
        'get',
        `/admin/audit-logs?limit=2&cursor=${page1.body.nextCursor}`,
        admin.id,
      )
      .expect(200);
    expect(page2.body.items.map((x: { id: string }) => x.id)).toEqual([
      ids[2],
      ids[1],
    ]);
    const page3 = await t
      .call(
        'get',
        `/admin/audit-logs?limit=2&cursor=${page2.body.nextCursor}`,
        admin.id,
      )
      .expect(200);
    expect(page3.body.items.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
    expect(page3.body.nextCursor).toBeNull();
    const by = async (qs: string) =>
      (
        await t.call('get', `/admin/audit-logs?${qs}`, admin.id).expect(200)
      ).body.items.map((x: { id: string }) => x.id);
    expect((await by(`actorId=${other.id}`)).sort()).toEqual(
      [ids[1], ids[3]].sort(),
    );
    expect((await by('action=COURSE_ARCHIVED')).sort()).toEqual(
      [ids[3], ids[4]].sort(),
    );
    expect((await by('targetType=USER')).length).toBe(3);
    expect(await by(`targetId=${target.id}`)).toEqual([ids[0]]);
    await t.call('get', '/admin/audit-logs?limit=51', admin.id).expect(400);
    await t.call('get', '/admin/audit-logs?cursor=nope', admin.id).expect(400);
  });

  it('shows the rows that Admin actions wrote, and viewing it writes none', async () => {
    const admin = await createAdmin(pool);
    const user = await createUser(pool);
    await t
      .call('post', `/admin/users/${user.id}/suspend`, admin.id, {})
      .expect(204);
    const before = await auditCount();
    const log = await t
      .call('get', '/admin/audit-logs?action=USER_SUSPENDED', admin.id)
      .expect(200);
    expect(log.body.items).toEqual([
      expect.objectContaining({
        targetId: user.id,
        actor: expect.objectContaining({ id: admin.id }),
      }),
    ]);
    expect(await auditCount()).toBe(before);
  });
});

describe('stats', () => {
  it('counts users, roles, courses by status, locked courses, enrollments and open reports', async () => {
    const admin = await createAdmin(pool);
    const teacher = await createTeacher(pool);
    const student = await createUser(pool);
    await createUser(pool, { status: 'SUSPENDED' });
    await pool.query(
      "INSERT INTO user_roles (user_id, role, status) VALUES ($1, 'TEACHER', 'PENDING')",
      [student.id],
    );
    const published = await createPublishedCourse(pool);
    await createPublishedCourse(pool, {
      status: 'ARCHIVED',
      archivedAt: new Date(),
      lockedByAdminAt: new Date(),
    });
    const draft = await createCourse(pool);
    for (const id of [published, draft])
      await addCourseTeacher(pool, id, teacher.id, 'OWNER');
    await createEnrollment(pool, published, student.id);
    await createEnrollment(pool, published, (await createUser(pool)).id, {
      status: 'PENDING',
    });
    await reportUser(pool, student.id, teacher.id);
    const res = await t.call('get', '/admin/stats', admin.id).expect(200);
    expect(res.body).toEqual({
      users: { total: 5, active: 4, suspended: 1 },
      roles: { activeTeachers: 1, pendingApplications: 1, activeAdmins: 1 },
      courses: { draft: 1, published: 1, archived: 1, locked: 1 },
      enrollments: { active: 1, pending: 1 },
      reports: { open: 1 },
    });
  });
});
