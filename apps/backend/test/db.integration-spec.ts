import { Pool, type PoolClient } from 'pg';

// Matches docker-compose.yml: the postgres service is published on host port 5433.
// CI (or any shell) can supply DATABASE_URL directly; otherwise it is built from POSTGRES_*.
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
const connectionString =
  process.env.DATABASE_URL ??
  `postgresql://${encodeURIComponent(POSTGRES_USER ?? '')}:${encodeURIComponent(POSTGRES_PASSWORD ?? '')}@localhost:5433/${POSTGRES_DB}`;

describe('PostgreSQL connection (integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('connects and runs SELECT 1', async () => {
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  it('serves two connections at once with distinct backend pids', async () => {
    const clients: PoolClient[] = [];
    try {
      clients.push(await pool.connect());
      clients.push(await pool.connect());
      const pids: number[] = [];
      for (const client of clients) {
        const { rows } = await client.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        );
        pids.push(rows[0].pid);
      }
      expect(pids).toHaveLength(2);
      expect(pids[0]).not.toBe(pids[1]);
    } finally {
      for (const client of clients) {
        client.release();
      }
    }
  });
});
