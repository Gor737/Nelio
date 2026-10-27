// M13 conformance: mass assignment. Every request DTO (body and query) of every route is found from the controllers' own metadata and run
// through the application's real validation pipe with fields no DTO declares, among them the ones an attacker would try (`role`, `status`,
// `isAdmin`, `passwordHash`, `emailVerifiedAt`, `lockedByAdminAt`, `ownerId`...). The pipe must refuse every one of them by name, so no
// service can ever see a field it did not ask for. A few real HTTP requests close the loop through the whole stack.
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { ApiException } from '../../src/common/filters/index.js';
import { createValidationPipe } from '../../src/common/pipes/index.js';
import { createPool, resetData } from '../support/database.js';
import {
  createAdmin,
  createTeacher,
  createUser,
} from '../support/factories.js';
import {
  addCourseTeacher,
  createPublishedCourse,
} from '../support/factories-courses.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { routeInventory, type RouteInfo } from '../support/route-inventory.js';

const pool = createPool(5);
let t: FullApp;
let routes: RouteInfo[];

beforeAll(async () => {
  t = await createFullApp();
  routes = routeInventory(t.app);
});
afterAll(async () => {
  await t.app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));

const INJECTED = {
  role: 'ADMIN',
  roles: ['ADMIN'],
  status: 'ACTIVE',
  isAdmin: true,
  passwordHash: 'x',
  emailVerifiedAt: '2020-01-01T00:00:00Z',
  lockedByAdminAt: '2020-01-01T00:00:00Z',
  ownerId: '018f0000-0000-7000-8000-0000000000aa',
  id: '018f0000-0000-7000-8000-0000000000aa',
  createdAt: '2020-01-01T00:00:00Z',
  tokensValidAfter: '2030-01-01T00:00:00Z',
  __proto__x: 'y',
};

interface DtoUse {
  readonly route: string;
  readonly kind: 'body' | 'query';
  readonly dto: new () => object;
}

function dtoUses(): DtoUse[] {
  const uses: DtoUse[] = [];
  for (const route of routes) {
    const args = (Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      route.controllerClass,
      route.handlerName,
    ) ?? {}) as Record<string, { index: number }>;
    const types = (Reflect.getMetadata(
      'design:paramtypes',
      Object.getPrototypeOf(
        Object.create(route.controllerClass.prototype as object),
      ) as object,
      route.handlerName,
    ) ?? []) as (new () => object)[];
    for (const [key, { index }] of Object.entries(args)) {
      const type = Number(key.split(':')[0]);
      const kind =
        type === RouteParamtypes.BODY
          ? 'body'
          : type === RouteParamtypes.QUERY
            ? 'query'
            : null;
      const dto = types[index];
      if (
        kind &&
        dto &&
        ![String, Object, Number, Boolean, Array].includes(dto as never)
      )
        uses.push({ route: route.key, kind, dto });
    }
  }
  return uses;
}

describe('every request DTO rejects unknown fields', () => {
  let uses: DtoUse[];
  beforeAll(() => {
    uses = dtoUses();
  });

  it('finds the DTOs (a floor, so a broken discovery cannot pass)', () => {
    expect(uses.filter((u) => u.kind === 'body').length).toBeGreaterThanOrEqual(
      50,
    );
    expect(
      uses.filter((u) => u.kind === 'query').length,
    ).toBeGreaterThanOrEqual(12);
  });

  it('every body or query parameter of every route has a validated DTO class (nothing arrives as an untyped object)', () => {
    for (const route of routes) {
      const args = (Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        route.controllerClass,
        route.handlerName,
      ) ?? {}) as Record<string, { index: number }>;
      const bodies = Object.keys(args).filter(
        (k) =>
          k.startsWith(`${RouteParamtypes.BODY}:`) ||
          k.startsWith(`${RouteParamtypes.QUERY}:`),
      );
      const found = uses.filter((u) => u.route === route.key).length;
      expect([route.key, found]).toEqual([route.key, bodies.length]);
    }
  });

  it('refuses each injected field BY NAME for every DTO of every route', async () => {
    const pipe = createValidationPipe();
    let checked = 0;
    for (const { route, kind, dto } of uses) {
      let error: unknown;
      try {
        await pipe.transform({ ...INJECTED }, { type: kind, metatype: dto });
      } catch (e) {
        error = e;
      }
      expect([route, kind, error instanceof ApiException]).toEqual([
        route,
        kind,
        true,
      ]);
      const body = JSON.stringify((error as ApiException).errors ?? []);
      for (const field of Object.keys(INJECTED).filter(
        (k) => k !== '__proto__x',
      )) {
        // a DTO may legitimately declare one of these names (for example `role` on the member-role endpoint, `status` on a list filter);
        // for those the field is validated, not unknown. The rest must be reported as not allowed.
        const declared = Object.getOwnPropertyNames(
          new (dto as new () => object)(),
        ).includes(field);
        if (!declared)
          expect([route, field, body.includes(field)]).toEqual([
            route,
            field,
            true,
          ]);
      }
      checked++;
    }
    expect(checked).toBe(uses.length);
  });
});

describe('through the whole stack', () => {
  it('registration cannot choose a role or verify itself', async () => {
    const res = await t.call('post', '/auth/register', {
      body: {
        email: 'new@example.test',
        password: 'a perfectly fine passphrase',
        fullName: 'New',
        roles: ['ADMIN'],
        emailVerifiedAt: '2020-01-01',
      },
    });
    expect(res.status).toBe(400);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
  });

  it('a user cannot change their role, status or email verification through their profile', async () => {
    const user = await createUser(pool);
    for (const body of [
      { role: 'ADMIN' },
      { status: 'ACTIVE' },
      { emailVerifiedAt: null },
      { email: 'x@example.test' },
      { passwordHash: 'x' },
    ]) {
      expect(
        (await t.call('patch', '/me', { userId: user.id, body })).status,
      ).toBe(400);
    }
    const roles = await pool.query(
      'SELECT role FROM user_roles WHERE user_id = $1',
      [user.id],
    );
    expect(roles.rows).toEqual([]); // nothing was granted
  });

  it('an Owner cannot set the lock, the status or the owner of a course through its settings', async () => {
    const owner = await createTeacher(pool);
    const courseId = await createPublishedCourse(pool);
    await addCourseTeacher(pool, courseId, owner.id, 'OWNER');
    for (const body of [
      { lockedByAdminAt: null },
      { status: 'DRAFT' },
      { ownerId: owner.id },
      { firstPublishedAt: null },
    ]) {
      expect(
        (
          await t.call('patch', `/courses/${courseId}`, {
            userId: owner.id,
            body,
          })
        ).status,
      ).toBe(400);
    }
  });

  it('an Admin action takes no field beyond its DTO either', async () => {
    const admin = await createAdmin(pool);
    const target = await createUser(pool);
    expect(
      (
        await t.call('post', `/admin/users/${target.id}/suspend`, {
          userId: admin.id,
          body: { reason: 'x', tokensValidAfter: null },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call('post', '/admin/categories', {
          userId: admin.id,
          body: { name: 'Design', slug: 'chosen' },
        })
      ).status,
    ).toBe(400);
  });
});
