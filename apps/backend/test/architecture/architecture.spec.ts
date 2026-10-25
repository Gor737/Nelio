// Rule tests for the architecture checker (roadmap M3): green on the real skeleton, red on a deliberately violating
// fixture per rule, green on a fixture that uses every import the architecture allows.
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';

const run = promisify(execFile);
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(backendDir, 'test/architecture/fixtures');
const RESOLVE_OPTIONS = {
  exportsFields: ['exports'],
  conditionNames: ['import', 'require', 'node', 'default', 'types'],
  mainFields: ['module', 'main', 'types', 'typings'],
};

/** Runs the real rule set (the file the CLI uses) over `<baseDir>/src`. */
async function check(baseDir: string): Promise<ICruiseResult> {
  const { options, ...ruleSet } = await extractDepcruiseConfig(
    join(backendDir, '.dependency-cruiser.cjs'),
  );
  const result = await cruise(
    ['src'],
    {
      ...options,
      ruleSet,
      validate: true,
      baseDir,
      tsConfig: { fileName: join(backendDir, 'tsconfig.json') },
    },
    RESOLVE_OPTIONS,
  );
  return result.output as ICruiseResult;
}

const byName = (a: string, b: string) => a.localeCompare(b);
const violatedRules = (result: ICruiseResult) =>
  [...new Set(result.summary.violations.map((v) => v.rule.name))].sort(byName);

// fixture directory name = the rule it violates
const RULES = [
  'no-circular',
  'no-unresolvable',
  'layer-0-imports-no-domain',
  'layer-1-imports-downward-only',
  'layer-2-imports-downward-only',
  'module-public-api-only',
  'app-root-uses-module-public-api-only',
  'infrastructure-and-common-never-import-domain',
  'mail-only-by-auth',
  'realtime-only-by-chat-and-notifications',
  'audit-only-by-audited-modules',
  'controllers-and-gateways-never-touch-the-database',
  'src-must-not-import-tests',
] as const;

const SLOW = 30_000;

describe('architecture rules (dependency-cruiser)', () => {
  it(
    'is green on the real module skeleton and cruises all of it',
    async () => {
      const result = await check(backendDir);
      expect(result.summary.violations).toEqual([]);
      expect(result.summary.error).toBe(0);
      expect(result.summary.totalCruised).toBeGreaterThan(40);
    },
    SLOW,
  );

  it.each(RULES)(
    'rule "%s" fires on its violating fixture, and on no other rule',
    async (rule) => {
      const result = await check(join(fixturesDir, rule));
      expect(violatedRules(result)).toEqual([rule]);
      expect(result.summary.error).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "a fixture importing another module's INTERNAL file (not index.ts) fails with module-public-api-only and names the file",
    async () => {
      const result = await check(join(fixturesDir, 'module-public-api-only'));
      const violation = result.summary.violations.find(
        (v) => v.rule.name === 'module-public-api-only',
      );
      expect(violation?.from).toBe('src/modules/courses/services/s.ts');
      expect(violation?.to).toBe('src/modules/catalog/services/internal.ts');
    },
    SLOW,
  );

  it(
    'the layer rules catch both a same-layer and an upward import',
    async () => {
      const layer1 = await check(
        join(fixturesDir, 'layer-1-imports-downward-only'),
      );
      expect(layer1.summary.violations.map((v) => v.to).sort(byName)).toEqual([
        'src/modules/auth/index.ts',
        'src/modules/content/index.ts',
      ]);
      const layer2 = await check(
        join(fixturesDir, 'layer-2-imports-downward-only'),
      );
      expect(
        layer2.summary.violations
          .map((v) => `${v.from} -> ${v.to}`)
          .sort(byName),
      ).toEqual([
        'src/modules/auth/index.ts -> src/modules/courses/index.ts',
        'src/modules/courses/index.ts -> src/modules/admin/index.ts',
      ]);
    },
    SLOW,
  );

  it(
    'controllers AND gateways are both covered, for the database service and for Prisma',
    async () => {
      const result = await check(
        join(fixturesDir, 'controllers-and-gateways-never-touch-the-database'),
      );
      expect(result.summary.violations.map((v) => v.from).sort(byName)).toEqual(
        [
          'src/modules/chat/chat.gateway.ts',
          'src/modules/courses/controllers/p.ts',
          'src/modules/users/controllers/c.ts',
        ],
      );
    },
    SLOW,
  );

  it(
    'every import the architecture allows passes (the rules are not stricter than the architecture)',
    async () => {
      const result = await check(join(fixturesDir, 'allowed-imports'));
      expect(result.summary.violations).toEqual([]);
      expect(result.summary.totalDependenciesCruised).toBeGreaterThan(25);
    },
    SLOW,
  );

  it(
    'every rule in .dependency-cruiser.cjs has a violating fixture (adding a rule without a test fails here)',
    async () => {
      const { forbidden } = await extractDepcruiseConfig(
        join(backendDir, '.dependency-cruiser.cjs'),
      );
      const configured = (forbidden ?? [])
        .map((r) => r.name ?? '')
        .sort(byName);
      expect(configured).toEqual([...RULES].sort(byName));
      const fixtures = readdirSync(fixturesDir);
      for (const rule of RULES) expect(fixtures).toContain(rule);
    },
    SLOW,
  );
});

describe('forwardRef text search (CI)', () => {
  const script = join(backendDir, 'scripts/check-forward-ref.mjs');

  it('passes on the real src', async () => {
    const { stdout } = await run(process.execPath, [
      script,
      join(backendDir, 'src'),
    ]);
    expect(stdout).toContain('no forwardRef found');
  });

  it('fails, naming file and line, when forwardRef appears', async () => {
    const fixture = join(fixturesDir, 'forward-ref/src');
    await expect(
      run(process.execPath, [script, fixture]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('auth.module.ts:1:'),
    });
  });
});
