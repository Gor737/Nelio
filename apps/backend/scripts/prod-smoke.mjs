// Release smoke test (docs/roadmap.md M14): starts the COMPILED application (`dist/main`, exactly what `npm run start:prod` runs) with a
// production environment and NO .env file, and checks what a deployment must be able to rely on:
//   1. a production environment that misses required settings does not start, names every missing setting, and prints no value;
//   2. a valid production environment starts, answers the health probe (database reachable), serves the API, hides the Swagger UI,
//      sends the security headers, and refuses protected routes without a token;
//   3. SIGTERM shuts it down cleanly and quickly (graceful shutdown hooks).
//
// Run `npm run build` first. Usage: npm run smoke:prod
// Needs DATABASE_URL (or SMOKE_DATABASE_URL) of a reachable PostgreSQL; it only reads (health check, category list). Nothing is written.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

const databaseUrl = process.env.SMOKE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'Set DATABASE_URL (or SMOKE_DATABASE_URL) to a reachable PostgreSQL database.',
  );
  process.exit(2);
}
if (!existsSync('dist/main.js')) {
  console.error('dist/main.js is missing: run `npm run build` first.');
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

/** A production environment that is valid. Nothing in it is a real credential; the object store and the mailer are never contacted. */
const validEnv = (port) => ({
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  PORT: String(port),
  DATABASE_URL: databaseUrl,
  JWT_SECRET: randomBytes(48).toString('base64'),
  FRONTEND_ORIGIN: 'https://app.example.test',
  TRUST_PROXY: '1',
  SMTP_HOST: 'smtp.example.test',
  MAIL_FROM: 'Nelio <no-reply@example.test>',
  S3_BUCKET: 'nelio-smoke-files',
  S3_ACCESS_KEY_ID: 'smoke-access-key',
  S3_SECRET_ACCESS_KEY: randomBytes(24).toString('base64'),
  S3_PUBLIC_BASE_URL: 'https://files.example.test/nelio-smoke-files',
});

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(
    `${ok ? 'ok     ' : 'FAILED '} ${name}${ok ? '' : detail ? ` (${detail})` : ''}`,
  );
  if (!ok) failures++;
};

function start(env) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, exited, output: () => output };
}

async function waitForHealth(port, exited, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let gone = false;
  exited.then(() => (gone = true));
  while (Date.now() < end && !gone) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// ---- 1. an incomplete production environment must not start
{
  const env = validEnv(await freePort());
  delete env.JWT_SECRET;
  delete env.FRONTEND_ORIGIN;
  delete env.S3_PUBLIC_BASE_URL;
  const run = start(env);
  const result = await Promise.race([
    run.exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000)),
  ]);
  const out = run.output();
  check(
    'an incomplete production environment exits instead of starting',
    result !== 'timeout' && result.code !== 0,
  );
  check(
    'it names every missing setting',
    ['JWT_SECRET', 'FRONTEND_ORIGIN', 'S3_PUBLIC_BASE_URL'].every((name) =>
      out.includes(name),
    ),
    out.slice(0, 300),
  );
  check(
    'it prints no stack trace and no value',
    !/\n\s+at /.test(out) && !out.includes(databaseUrl),
  );
  if (result === 'timeout') run.child.kill('SIGKILL');
}

// ---- 2 and 3. a valid production environment
{
  const port = await freePort();
  const env = validEnv(port);
  const run = start(env);
  const healthy = await waitForHealth(port, run.exited);
  check(
    'a valid production environment starts and the health probe answers (database reachable)',
    healthy,
    run.output().slice(0, 400),
  );
  if (healthy) {
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`);
    check(
      'GET /health is { status: ok, database: up } and shows no configuration',
      JSON.stringify(await health.json()) === '{"status":"ok","database":"up"}',
    );
    const categories = await fetch(`${base}/api/v1/categories`);
    check('GET /api/v1/categories answers 200', categories.status === 200);
    const me = await fetch(`${base}/api/v1/me`);
    check('a protected route without a token is 401', me.status === 401);
    const docs = await fetch(`${base}/api/docs`);
    check('the Swagger UI is off in production', docs.status === 404);
    const docsJson = await fetch(`${base}/api/docs-json`);
    check(
      'the OpenAPI JSON endpoint is off in production',
      docsJson.status === 404,
    );
    check(
      'Helmet headers are sent and X-Powered-By is not',
      categories.headers.get('x-content-type-options') === 'nosniff' &&
        categories.headers.has('strict-transport-security') &&
        !categories.headers.has('x-powered-by'),
    );
    check(
      'every response has a request id',
      /\S/.test(categories.headers.get('x-request-id') ?? ''),
    );
    const cors = await fetch(`${base}/api/v1/categories`, {
      headers: { Origin: 'https://app.example.test' },
    });
    check(
      'CORS names the configured frontend origin with credentials',
      cors.headers.get('access-control-allow-origin') ===
        'https://app.example.test' &&
        cors.headers.get('access-control-allow-credentials') === 'true',
    );
    const proxied = await fetch(`${base}/api/v1/me`, {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    });
    check(
      'behind one trusted proxy a request is still answered (the forwarded address is used for throttling)',
      proxied.status === 401,
    );

    const started = Date.now();
    run.child.kill('SIGTERM');
    const result = await Promise.race([
      run.exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000)),
    ]);
    // Nest closes the application (HTTP server, database pool) and then re-raises the signal, so the exit is by SIGTERM or code 0
    check(
      'SIGTERM stops it within 15 seconds',
      result !== 'timeout' &&
        (result.code === 0 || result.signal === 'SIGTERM'),
      JSON.stringify(result),
    );
    check('the shutdown took under 10 seconds', Date.now() - started < 10000);
    if (result === 'timeout') run.child.kill('SIGKILL');
    const logs = run.output();
    check(
      'the log is JSON lines and contains neither the JWT secret nor the storage secret',
      !logs.includes(env.JWT_SECRET) &&
        !logs.includes(env.S3_SECRET_ACCESS_KEY) &&
        logs
          .split('\n')
          .filter(Boolean)
          .every((line) => line.startsWith('{')),
      logs.slice(0, 200),
    );
  } else {
    run.child.kill('SIGKILL');
  }
}

console.log(
  failures === 0
    ? '\nThe release smoke test passed.'
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
