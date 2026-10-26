// M12: suspending a user through the real endpoint reaches their open sockets: `session:revoked`, then the connection closes.
import { io, type Socket } from 'socket.io-client';
import { createAdminApp, type AdminTestApp } from '../support/admin-app.js';
import { createPool, resetData } from '../support/database.js';
import { createAdmin, createUser } from '../support/factories.js';
import { TEST_JWT_SECRET } from '../support/integration-app.js';
import { mintAccessToken } from '../support/token-minter.js';

const pool = createPool();
let t: AdminTestApp;
const opened: Socket[] = [];

beforeAll(async () => {
  t = await createAdminApp({ listen: true });
});
afterAll(async () => {
  for (const socket of opened) socket.close();
  await t.app.close();
  await pool.end();
});
beforeEach(() => resetData(pool));

const connect = (userId: string) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = io(`http://localhost:${t.port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      auth: { token: mintAccessToken(userId, { secret: TEST_JWT_SECRET }) },
      extraHeaders: { Origin: 'http://localhost:3001' },
    });
    opened.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
const waitFor = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

it('every open socket of the suspended user gets "session:revoked" and is closed; other users keep theirs; the user cannot reconnect', async () => {
  const admin = await createAdmin(pool);
  const victim = await createUser(pool);
  const bystander = await createUser(pool);
  const [v1, v2, other] = [
    await connect(victim.id),
    await connect(victim.id),
    await connect(bystander.id),
  ];
  const seen: string[] = [];
  const closed = [v1, v2].map(
    (socket, i) =>
      new Promise<void>((resolve) => {
        socket.on('session:revoked', () => seen.push(`v${i + 1}:revoked`));
        socket.on('disconnect', () => {
          seen.push(`v${i + 1}:closed`);
          resolve();
        });
      }),
  );

  await t
    .call('post', `/admin/users/${victim.id}/suspend`, admin.id, {})
    .expect(204);
  await Promise.all(closed);

  for (const n of ['v1', 'v2']) {
    expect(seen.filter((e) => e.startsWith(n))).toEqual([
      `${n}:revoked`,
      `${n}:closed`,
    ]);
  }
  await waitFor(() => !v1.connected && !v2.connected);
  expect(other.connected).toBe(true);
  await expect(connect(victim.id)).rejects.toBeDefined(); // suspended
});
