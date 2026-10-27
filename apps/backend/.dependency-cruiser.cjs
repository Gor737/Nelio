/**
 * Architecture rules (docs/architecture.md section 7, Decision 104; roadmap M3).
 * Run: `npm run check:deps`. The same rule set is exercised by test/architecture/architecture.spec.ts against deliberately
 * violating fixtures, so a rule that stops firing is a failing test.
 *
 * Layers (docs/architecture.md section 5): dependencies point downward only.
 *   Layer 0: files catalog progress moderation notifications   (import no other domain module)
 *   Layer 1: users content chat
 *   Layer 2: auth courses enrollments
 *   Layer 3: admin
 */
const LAYER_0 = 'files|catalog|progress|moderation|notifications';
const LAYER_1 = 'users|content|chat';
const LAYER_2 = 'auth|courses|enrollments';
const LAYER_3 = 'admin';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'No cycles anywhere (and no forwardRef: see npm run check:forward-ref).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'Every import must resolve.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'layer-0-imports-no-domain',
      severity: 'error',
      comment: 'Layer 0 modules import no other domain module.',
      from: { path: `^src/modules/(${LAYER_0})/` },
      to: { path: '^src/modules/', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'layer-1-imports-downward-only',
      severity: 'error',
      comment: 'Layer 1 may import Layer 0 only.',
      from: { path: `^src/modules/(${LAYER_1})/` },
      to: {
        path: `^src/modules/(${LAYER_1}|${LAYER_2}|${LAYER_3})/`,
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'layer-2-imports-downward-only',
      severity: 'error',
      comment: 'Layer 2 may import Layers 0 and 1 only.',
      from: { path: `^src/modules/(${LAYER_2})/` },
      to: {
        path: `^src/modules/(${LAYER_2}|${LAYER_3})/`,
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'module-public-api-only',
      severity: 'error',
      comment:
        "A module may import another module only through that module's index.ts.",
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'app-root-uses-module-public-api-only',
      severity: 'error',
      comment:
        'Files outside modules/, infrastructure/ and common/ (app.module.ts, main.ts) import a module through its index.ts.',
      from: { path: '^src/(?!modules/|infrastructure/|common/)' },
      to: {
        path: '^src/modules/[^/]+/',
        pathNot: '^src/modules/[^/]+/index\\.ts$',
      },
    },
    {
      name: 'infrastructure-and-common-never-import-domain',
      severity: 'error',
      comment: 'Infrastructure and common never import a domain module.',
      from: { path: '^src/(infrastructure|common)/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'mail-only-by-auth',
      severity: 'error',
      comment: 'infrastructure/mail may be imported only by the Auth module.',
      from: { path: '^src/modules/', pathNot: '^src/modules/auth/' },
      to: { path: '^src/infrastructure/mail/' },
    },
    {
      name: 'realtime-only-by-chat-and-notifications',
      severity: 'error',
      comment:
        'infrastructure/realtime may be imported only by Chat and Notifications.',
      from: {
        path: '^src/modules/',
        pathNot: '^src/modules/(chat|notifications)/',
      },
      to: { path: '^src/infrastructure/realtime/' },
    },
    {
      name: 'audit-only-by-audited-modules',
      severity: 'error',
      comment:
        'infrastructure/audit may be imported only by modules that write audited actions (users, courses, enrollments, chat, moderation, admin; roadmap M10-M12). Extend this list only with a documented audited action.',
      from: {
        path: '^src/modules/',
        pathNot:
          '^src/modules/(users|courses|enrollments|chat|moderation|admin)/',
      },
      to: { path: '^src/infrastructure/audit/' },
    },
    {
      name: 'controllers-and-gateways-never-touch-the-database',
      severity: 'error',
      comment:
        'Controllers and gateways never import the database service or Prisma.',
      from: { path: ['^src/modules/[^/]+/controllers/', '\\.gateway\\.ts$'] },
      to: {
        path: ['^src/infrastructure/database/', '@prisma/', '^src/generated/'],
      },
    },
    {
      name: 'src-must-not-import-tests',
      severity: 'error',
      comment: 'Application code never imports from test/.',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
  ],
  options: {
    // Edges INTO node_modules and src/generated stay visible (the controllers rule needs them); their insides are not crawled.
    doNotFollow: { path: ['node_modules', '^src/generated'] },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
