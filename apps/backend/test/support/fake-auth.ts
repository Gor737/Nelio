// Fakes for the HTTP tests that must not need a database (the e2e suite): the guards depend on `AuthUserLoader` and
// `CourseAccessService`, and these stand in for them. The REAL implementations are tested against PostgreSQL in the integration suite.
import { randomUUID } from 'node:crypto';
import { CourseAccessService } from '../../src/common/access/course-access.service.js';
import type { PlatformRole } from '../../src/common/constants/permission-matrix.js';
import { AuthUserLoader } from '../../src/common/guards/auth-user-loader.js';
import type { AuthUserRecord } from '../../src/common/guards/authenticated-user.js';
import type { Provider } from '@nestjs/common';

export class FakeAuthUserLoader extends AuthUserLoader {
  readonly users = new Map<string, AuthUserRecord>();
  loads = 0;

  add(
    overrides: Partial<Omit<AuthUserRecord, 'id'>> & {
      roles?: PlatformRole[];
    } = {},
  ): AuthUserRecord {
    const user: AuthUserRecord = {
      id: randomUUID(),
      status: overrides.status ?? 'ACTIVE',
      tokensValidAfter: overrides.tokensValidAfter ?? null,
      activeRoles: overrides.activeRoles ?? overrides.roles ?? ['STUDENT'],
    };
    this.users.set(user.id, user);
    return user;
  }

  load(userId: string): Promise<AuthUserRecord | null> {
    this.loads++;
    return Promise.resolve(this.users.get(userId) ?? null);
  }
}

/** Providers that replace the database-backed ones: `[{ provide: AuthUserLoader, useValue: loader }, ...]`. */
export function fakeAuthProviders(loader: FakeAuthUserLoader): Provider[] {
  return [
    { provide: AuthUserLoader, useValue: loader },
    { provide: CourseAccessService, useValue: {} },
  ];
}
