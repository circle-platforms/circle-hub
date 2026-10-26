import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { DatabaseConfig } from '../config/index.ts';
import { startPostgres } from './postgres.ts';

async function scalar(config: DatabaseConfig, sql: string): Promise<unknown> {
  const client = new pg.Client({ ...config, ssl: false });
  await client.connect();
  try {
    return Object.values((await client.query(sql)).rows[0])[0];
  } finally {
    await client.end();
  }
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

test('a loopback TCP cluster: databases come and go, stop removes the directory', async () => {
  const postgres = await startPostgres();
  try {
    assert.equal(postgres.config.host, '127.0.0.1');
    assert.match(String(await scalar(postgres.config, 'SELECT version()')), /PostgreSQL/);
    assert.equal(await scalar(postgres.config, 'SHOW TimeZone'), 'UTC');
    assert.equal(await scalar(postgres.config, "SELECT current_setting('server_encoding')"), 'UTF8');
    const database = await postgres.createDatabase('t_harness');
    assert.equal(await scalar(database, 'SELECT current_database()'), 't_harness');
    await postgres.dropDatabase('t_harness');
    await assert.rejects(scalar(database, 'SELECT 1'));
    await assert.rejects(postgres.createDatabase('Bad-Name'), TypeError);
  } finally {
    await postgres.stop();
  }
  assert.equal(existsSync(postgres.root), false);
  await postgres.stop();
});

test('a test process ended by SIGTERM (as node --test does on a timeout) still stops its cluster and removes its directory', async () => {
  const module = join(fileURLToPath(new URL('.', import.meta.url)), 'postgres.ts');
  const script = [
    `const { startPostgres } = await import(${JSON.stringify(module)});`,
    'const postgres = await startPostgres();',
    'console.log(JSON.stringify({ root: postgres.root, port: postgres.config.port }));',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
  });
  const started = await new Promise<{ root: string; port: number }>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('\n')) resolve(JSON.parse(output.slice(0, output.indexOf('\n'))) as { root: string; port: number });
    });
    child.once('exit', () => reject(new Error(`the child ended before its cluster started: ${errors}`)));
  });
  assert.equal(existsSync(started.root), true);
  assert.equal(await tcpOpen(started.port), true);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
  // The signal is re-raised after the cleanup, so the process still ends by SIGTERM.
  assert.deepEqual({ code, signal }, { code: null, signal: 'SIGTERM' }, errors);
  assert.equal(existsSync(started.root), false);
  const deadline = Date.now() + 15_000;
  while ((await tcpOpen(started.port)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await tcpOpen(started.port), false, 'the cluster is still listening');
});

test('a Unix-socket cluster listens on no TCP port', async () => {
  const postgres = await startPostgres({ socket: true });
  try {
    assert.equal(postgres.config.host.startsWith(postgres.root), true);
    assert.equal(await scalar(postgres.config, 'SELECT 1'), 1);
    assert.equal(await tcpOpen(postgres.config.port), false);
  } finally {
    await postgres.stop();
  }
  assert.equal(existsSync(postgres.root), false);
});
