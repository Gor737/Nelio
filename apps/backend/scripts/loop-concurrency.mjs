// Runs the concurrency suites (every spec that holds transactions open, races requests or checks lock order) several times in a row to
// expose flakiness (docs/roadmap.md M13: "Full Phase 9 concurrency suite, looped"). Stops at the first failing run.
//
// Usage: npm run test:concurrency [-- <iterations>]        (default 5)
import { spawnSync } from 'node:child_process';

const iterations = Number(process.argv[2] ?? 5);
if (!Number.isInteger(iterations) || iterations < 1) {
  console.error('The number of iterations must be a positive integer.');
  process.exit(2);
}

/** The specs with races: the Phase 9 catalog (docs/architecture.md section 15) is covered by these files. */
const SPECS = [
  'enrollments.integration-spec',
  'progress.integration-spec',
  'courses.integration-spec',
  'content.integration-spec',
  'chat-messages.integration-spec',
  'chat-conversations.integration-spec',
  'moderation.integration-spec',
  'catalog.integration-spec',
  'users.integration-spec',
  'auth.integration-spec',
  'course-access.integration-spec',
  'admin-users.integration-spec',
  'admin-courses.integration-spec',
  'admin-reports.integration-spec',
  'admin-suspension-socket.integration-spec',
  'jobs.integration-spec',
];

let failed = 0;
for (let i = 1; i <= iterations; i++) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      '--env-file-if-exists=../../.env',
      '--experimental-vm-modules',
      './node_modules/jest/bin/jest.js',
      '--config',
      './test/jest-integration.json',
      '--runInBand',
      '--silent',
      ...SPECS.map((s) => `test/integration/${s}`),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const summary = output.match(/^Tests:.*$/m)?.[0] ?? 'no result line';
  console.log(
    `run ${i}/${iterations} (${Math.round((Date.now() - started) / 1000)} s): ${summary}`,
  );
  if (result.status !== 0) {
    failed++;
    console.error(
      output
        .split('\n')
        .filter((l) => /●|FAIL|Expected|Received/.test(l))
        .slice(0, 60)
        .join('\n'),
    );
    break;
  }
}
if (failed > 0) {
  console.error('The concurrency suite failed; see the output above.');
  process.exit(1);
}
console.log(`The concurrency suite passed ${iterations} times in a row.`);
