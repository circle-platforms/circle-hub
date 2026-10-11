import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const scratch = await mkdtemp(`${tmpdir()}/circle-server-pg-smoke-`);
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>(resolve => listener.close(() => resolve()));
const password = randomBytes(24).toString('hex');
const database = new EmbeddedPostgres({ databaseDir: `${scratch}/pg`, user: 'circle_synthetic', password,
  port, persistent: false, createPostgresUser: false, authMethod: 'scram-sha-256',
  postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
let started = false;
try {
  await database.initialise(); await database.start(); started = true;
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'circle_synthetic', password, database: 'postgres' });
  await client.connect();
  try {
    const result = await client.query("SELECT version() AS version, current_setting('listen_addresses') AS listen");
    console.log(JSON.stringify({ embeddedPostgres: '18.4.0-beta.17', ...result.rows[0], synthetic: true }));
  } finally { await client.end(); }
} finally { if (started) await database.stop(); await rm(scratch, { recursive: true, force: true }); }
