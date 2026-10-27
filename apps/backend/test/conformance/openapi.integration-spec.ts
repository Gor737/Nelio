// M13 conformance: the OpenAPI document is the frontend's contract, so it must say what the application does.
//   - Completeness: every route of the running application is an operation of the document and the other way round; each has a unique
//     operationId, a tag, a summary, a description, a success response, and the security and error responses its decorators imply.
//   - Leak scan (static): a response schema never names `password_hash`, `token_hash` or `message_snapshot`, and names `email` only in
//     `/me` and `/admin/*`. This covers every operation, including the ones that change data, which a runtime crawl cannot reach.
//   - Schemas: every object property has a type, every enum is a non-empty list, every $ref resolves.
import { buildOpenApiDocument } from '../../src/app.setup.js';
import { ERROR_CODES } from '../../src/common/constants/error-codes.js';
import { createFullApp, type FullApp } from '../support/full-app.js';
import { routeInventory, type RouteInfo } from '../support/route-inventory.js';

type Json = Record<string, unknown>;
let t: FullApp;
let routes: RouteInfo[];
let doc: ReturnType<typeof buildOpenApiDocument>;

beforeAll(async () => {
  t = await createFullApp();
  routes = routeInventory(t.app);
  doc = buildOpenApiDocument(t.app);
});
afterAll(() => t.app.close());

const PREFIX = '/api/v1';
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');
const operations = () =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item as Json)
      .filter(([method]) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      )
      .map(([method, op]) => ({
        path: path.replace(PREFIX, ''),
        method,
        op: op as Json & { responses: Json },
      })),
  );

describe('completeness', () => {
  it('every route is an operation and every operation is a route (same method and path)', () => {
    const fromRoutes = routes
      .map((r) => `${r.method.toUpperCase()} ${toOpenApiPath(r.path)}`)
      .sort();
    const fromDocument = operations()
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(fromDocument).toEqual(fromRoutes);
  });

  it('every operation has a unique operationId, a tag, a summary and a description', () => {
    const ids = new Set<string>();
    for (const { method, path, op } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      expect([where, typeof op.operationId]).toEqual([where, 'string']);
      expect([where, ids.has(op.operationId as string)]).toEqual([
        where,
        false,
      ]);
      ids.add(op.operationId as string);
      expect([
        where,
        Array.isArray(op.tags) && (op.tags as string[]).length > 0,
      ]).toEqual([where, true]);
      expect([where, String(op.summary ?? '').length > 3]).toEqual([
        where,
        true,
      ]);
      expect([
        where,
        String(op.description ?? op.summary ?? '').length > 3,
      ]).toEqual([where, true]);
    }
  });

  it('every operation documents a success response (2xx), with a body schema unless it is a 204', () => {
    for (const { method, path, op } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      const success = Object.keys(op.responses).filter((s) =>
        s.startsWith('2'),
      );
      expect([where, success.length >= 1]).toEqual([where, true]);
      for (const status of success) {
        if (status === '204') continue;
        const response = op.responses[status] as { content?: Json };
        const hasSchema =
          !!response.content && Object.keys(response.content).length > 0;
        expect([where, status, hasSchema]).toEqual([where, status, true]);
      }
    }
  });

  it('security and error responses follow the decorators: public = none, optional = optional, otherwise bearer; 429/500/503 everywhere', () => {
    const byKey = new Map(
      routes.map((r) => [
        `${r.method.toUpperCase()} ${toOpenApiPath(r.path)}`,
        r,
      ]),
    );
    for (const { method, path, op } of operations()) {
      const key = `${method.toUpperCase()} ${path}`;
      const route = byKey.get(key) as RouteInfo;
      const security = op.security as Json[];
      if (route.isPublic) expect([key, security]).toEqual([key, []]);
      else if (route.optionalAuth)
        expect([key, security.length]).toEqual([key, 2]);
      else
        expect([key, JSON.stringify(security)]).toEqual([
          key,
          JSON.stringify([{ 'access-token': [] }]),
        ]);
      for (const status of ['429', '500', '503'])
        expect([key, status, status in op.responses]).toEqual([
          key,
          status,
          true,
        ]);
      if (!route.isPublic)
        expect([key, '401' in op.responses]).toEqual([key, true]);
    }
  });

  it('the internal markers of the decorators are not in the published document', () => {
    expect(JSON.stringify(doc)).not.toContain('x-nelio-');
  });

  it('the description lists every error code of the registry', () => {
    for (const code of Object.keys(ERROR_CODES))
      expect(doc.info.description).toContain(code);
  });

  it('every route that can answer a specific registered code names it in its description or a response (the Admin and course routes)', () => {
    const text = JSON.stringify(
      doc.paths[`${PREFIX}/admin/courses/{courseId}/lock`],
    );
    expect(text).toContain('COURSE_ALREADY_LOCKED');
    expect(
      JSON.stringify(doc.paths[`${PREFIX}/admin/reports/{reportId}/dismiss`]),
    ).toContain('REPORT_ALREADY_RESOLVED');
    expect(
      JSON.stringify(doc.paths[`${PREFIX}/admin/users/{userId}/suspend`]),
    ).toContain('LAST_PLATFORM_ADMIN');
  });
});

describe('schemas', () => {
  const schemas = () => (doc.components?.schemas ?? {}) as Record<string, Json>;

  it('every $ref resolves', () => {
    const text = JSON.stringify(doc);
    const refs = [
      ...text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(100);
    for (const name of new Set(refs))
      expect([name, name in schemas()]).toEqual([name, true]);
  });

  it('every property of every schema has a type, a $ref, a oneOf/allOf/anyOf, or is an enum', () => {
    for (const [name, schema] of Object.entries(schemas())) {
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      for (const [property, def] of Object.entries(properties)) {
        const typed =
          'type' in def ||
          '$ref' in def ||
          'oneOf' in def ||
          'allOf' in def ||
          'anyOf' in def ||
          'enum' in def;
        expect([name, property, typed]).toEqual([name, property, true]);
      }
    }
  });

  it('enums are non-empty lists of strings', () => {
    const walk = (value: unknown, where: string) => {
      if (Array.isArray(value))
        value.forEach((v, i) => walk(v, `${where}[${i}]`));
      else if (value && typeof value === 'object') {
        for (const [key, v] of Object.entries(value)) {
          if (key === 'enum') {
            expect([where, Array.isArray(v) && v.length > 0]).toEqual([
              where,
              true,
            ]);
          }
          walk(v, `${where}.${key}`);
        }
      }
    };
    walk(doc.components, 'components');
  });

  it('request bodies are objects with declared properties (no free-form object accepts input)', () => {
    for (const { method, path, op } of operations()) {
      const body = op.requestBody as
        { content?: Record<string, { schema?: Json }> } | undefined;
      if (!body?.content) continue;
      for (const [type, media] of Object.entries(body.content)) {
        if (type === 'multipart/form-data') continue; // the upload: a file and a kind
        expect([`${method} ${path}`, !!media.schema]).toEqual([
          `${method} ${path}`,
          true,
        ]);
        const schema = media.schema as Json;
        expect([
          `${method} ${path}`,
          schema.additionalProperties === true,
        ]).toEqual([`${method} ${path}`, false]);
      }
    }
  });
});

describe('leak scan (static): what a response can ever contain', () => {
  /** All property names reachable from the 2xx response schemas of an operation, following $refs. */
  function responseProperties(op: Json & { responses: Json }): Set<string> {
    const seen = new Set<string>();
    const names = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      const obj = node as Json;
      const ref = obj.$ref;
      if (typeof ref === 'string') {
        const name = ref.split('/').pop() as string;
        if (seen.has(name)) return;
        seen.add(name);
        return visit(schemasByName()[name]);
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'properties')
          for (const property of Object.keys(value as Json))
            names.add(property);
        visit(value);
      }
    };
    for (const [status, response] of Object.entries(op.responses)) {
      if (status.startsWith('2')) visit(response);
    }
    return names;
  }
  const schemasByName = () =>
    (doc.components?.schemas ?? {}) as Record<string, Json>;

  it('no response schema has password_hash, token_hash or message_snapshot (in any spelling)', () => {
    const forbidden = [
      'passwordHash',
      'password_hash',
      'tokenHash',
      'token_hash',
      'messageSnapshot',
      'message_snapshot',
      'refreshToken',
    ];
    for (const { method, path, op } of operations()) {
      const names = responseProperties(op);
      for (const name of forbidden)
        expect([method, path, name, names.has(name)]).toEqual([
          method,
          path,
          name,
          false,
        ]);
    }
  });

  it('`email` appears only in responses of /me and /admin/*', () => {
    const offenders = operations()
      .filter(
        ({ path }) => !path.startsWith('/me') && !path.startsWith('/admin/'),
      )
      .filter(({ op }) => responseProperties(op).has('email'))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(offenders).toEqual([]);
  });

  it('`snapshot` (the evidence of a report) appears only in the Admin report detail and context', () => {
    const holders = operations()
      .filter(({ op }) => responseProperties(op).has('snapshot'))
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(holders).toEqual([
      'GET /admin/reports/{reportId}',
      'GET /admin/reports/{reportId}/context',
      'POST /admin/reports/{reportId}/action',
      'POST /admin/reports/{reportId}/dismiss',
    ]);
  });

  it('`lastSeenAt` is never exposed (presence is a separate, limited endpoint)', () => {
    for (const { method, path, op } of operations()) {
      const names = responseProperties(op);
      expect([
        method,
        path,
        names.has('lastSeenAt') || names.has('last_seen_at'),
      ]).toEqual([method, path, false]);
    }
  });
});
