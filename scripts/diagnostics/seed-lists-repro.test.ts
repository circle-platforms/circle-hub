import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { loadHub, parseArgs, runRepro } from './seed-lists-repro.ts';

const folder = mkdtempSync(join(tmpdir(), 'seed-script-tests-'));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('./seed-lists-repro.ts', import.meta.url));
const hub = await loadHub(repository);
type Hub = typeof hub;
type Resource = 'server' | 'world' | 'postgres' | 'directory';
const run = promisify(execFile);
after(() => rm(folder, { recursive: true, force: true }));

async function portClosed(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      reject(new Error(`port ${port} still accepts connections`));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ECONNREFUSED' ? resolve() : reject(error)));
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('port observation timed out'));
    });
  });
}

function fixture(
  t: TestContext,
  {
    failAt,
    cleanupFailures = [],
    reportOk = false,
  }: { failAt?: string; cleanupFailures?: readonly Resource[]; reportOk?: boolean } = {},
) {
  const owned: {
    pg?: { root: string; port: number; pid: number };
    world?: { directory: string; records: string };
    server?: { port: number };
    directory?: string;
  } = {};
  const originalCleanup: Partial<Record<Resource, () => Promise<void>>> = {};
  const events: string[] = [];
  const output: string[] = [];
  const bodyError = new Error(`injected body failure at ${failAt}`);
  const cleanupErrors = new Map(cleanupFailures.map((name) => [name, new Error(`injected ${name} cleanup failure`)]));
  const cleanup = (name: Resource, action: () => Promise<void>) => {
    originalCleanup[name] = action;
    return async () => {
      events.push(`${name}:begin`);
      await action();
      events.push(`${name}:released`);
      // Simulate a reported cleanup failure after releasing the actual owned
      // resource. Tests must not deliberately abandon a database or listener.
      if (cleanupErrors.has(name)) throw cleanupErrors.get(name);
    };
  };
  t.after(async () => {
    for (const name of ['server', 'world', 'postgres', 'directory'] as const) {
      await originalCleanup[name]?.();
    }
  });
  let seedCalls = 0;
  const deps = {
    ...hub,
    startPostgres: async () => {
      const pg = await hub.startPostgres();
      owned.pg = {
        root: pg.root,
        port: pg.config.port,
        pid: Number(readFileSync(join(pg.root, 'data/postmaster.pid'), 'utf8').split('\n')[0]),
      };
      return { ...pg, stop: cleanup('postgres', () => pg.stop()) };
    },
    makeWorld: async (pg: Parameters<Hub['makeWorld']>[0], options: Parameters<Hub['makeWorld']>[1]) => {
      if (failAt === 'after-postgres') throw bodyError;
      const world = await hub.makeWorld(pg, options);
      owned.world = { directory: world.dir, records: world.kit.dataDir };
      const close = cleanup('world', () => world.close());
      if (failAt === 'after-world')
        world.kit.variables.setVariable = async () => {
          throw bodyError;
        };
      // Fault-path tests keep real PG, pool, vault, HTTP server and directories,
      // while avoiding repeated 109-file business runs. The complete CLI
      // acceptance below runs the actual business dependencies and original input.
      t.mock.method(world.knowledge, 'syncProduct', async () => {
        if (failAt === 'sync') throw bodyError;
        return { error: null };
      });
      return { ...world, close };
    },
    startStub: async (...args: Parameters<Hub['startStub']>) => {
      const server = await hub.startStub(...args);
      owned.server = { port: Number(new URL(server.origin).port) };
      return { ...server, close: cleanup('server', () => server.close()) };
    },
    stagePack: async (...args: Parameters<Hub['stagePack']>) => {
      if (failAt === 'after-directory') throw bodyError;
      return hub.stagePack(...args);
    },
    knowledgeSeed: async (): Promise<Awaited<ReturnType<Hub['knowledgeSeed']>>> => {
      const phase = ++seedCalls === 1 ? 'dry-run' : 'seed';
      if (failAt === phase) throw bodyError;
      return {
        ok: reportOk,
        product: 'synthetic',
        pack: 'synthetic@1',
        line: '10.8',
        build: null,
        dry_run: phase === 'dry-run',
        root: null,
        seedling: null,
        composition: null,
        sources: [],
        composition_revisions: [],
        pointer: null,
        missing: [],
        notes: [],
        reason: reportOk ? null : 'famx.adoc.incomplete_group',
      };
    },
    formatSeedReport: (report: Parameters<Hub['formatSeedReport']>[0]) => JSON.stringify(report),
  };
  const io = {
    log: (...args: unknown[]) => output.push(args.join(' ')),
    mkdtemp: async (prefix: string) => {
      if (failAt === 'after-server') throw bodyError;
      const directory = await mkdtemp(prefix);
      owned.directory = directory;
      originalCleanup.directory = () => rm(directory, { recursive: true, force: true });
      return directory;
    },
    rm: cleanup('directory', async () => {
      if (owned.directory) await rm(owned.directory, { recursive: true, force: true });
    }),
  };
  async function verifyReleased() {
    const expected = (['server', 'world', 'postgres', 'directory'] as const).filter((name) => {
      return name === 'postgres' ? owned.pg : owned[name];
    });
    assert.deepEqual(
      events.filter((event) => event.endsWith(':begin')),
      expected.map((name) => `${name}:begin`),
    );
    if (owned.server) await portClosed(owned.server.port);
    if (owned.pg) {
      const pg = owned.pg;
      await portClosed(pg.port);
      assert.throws(() => process.kill(pg.pid, 0), { code: 'ESRCH' });
      assert.equal(existsSync(pg.root), false);
    }
    if (owned.world) {
      assert.equal(existsSync(owned.world.directory), false);
      assert.equal(existsSync(owned.world.records), false);
      assert.ok(events.indexOf('world:released') < events.indexOf('postgres:begin'));
    }
    if (owned.directory) assert.equal(existsSync(owned.directory), false);
  }
  return { deps, io, bodyError, cleanupErrors, verifyReleased, events, output, owned };
}

for (const reportOk of [true, false]) {
  test(`body completes with ok=${reportOk}; real resources are released in order`, { timeout: 60_000 }, async (t) => {
    const f = fixture(t, { reportOk });
    const reports = await runRepro(f.deps, f.io);
    assert.ok(reports);
    assert.equal(reports.dry.ok, reportOk);
    assert.equal(reports.seeded.ok, reportOk);
    assert.ok(f.output.some((line) => line.startsWith('DRY REPORT:')));
    assert.ok(f.output.some((line) => line.startsWith('SEED REPORT:')));
    await f.verifyReleased();
  });
}

for (const failAt of ['after-postgres', 'after-world', 'after-server', 'after-directory', 'sync', 'dry-run', 'seed']) {
  test(
    `failure at ${failAt} preserves the original error and releases acquired resources`,
    { timeout: 60_000 },
    async (t) => {
      const f = fixture(t, { failAt });
      await assert.rejects(runRepro(f.deps, f.io), (error) => error === f.bodyError);
      await f.verifyReleased();
    },
  );
}

for (const name of ['server', 'world', 'postgres', 'directory'] as const) {
  test(`${name} cleanup rejection does not skip subsequent cleanup`, { timeout: 60_000 }, async (t) => {
    const f = fixture(t, { cleanupFailures: [name] });
    await assert.rejects(runRepro(f.deps, f.io), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.equal(error.errors[0].cause, f.cleanupErrors.get(name));
      return true;
    });
    await f.verifyReleased();
  });
}

test('body and all four cleanup failures remain available together', { timeout: 60_000 }, async (t) => {
  const names = ['server', 'world', 'postgres', 'directory'] as const;
  const f = fixture(t, { failAt: 'seed', cleanupFailures: names });
  await assert.rejects(runRepro(f.deps, f.io), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, f.bodyError);
    assert.equal(error.errors[0], f.bodyError);
    assert.deepEqual(
      error.errors.slice(1).map((item) => item.cause),
      names.map((name) => f.cleanupErrors.get(name)),
    );
    return true;
  });
  await f.verifyReleased();
});

test('missing, malformed and nonexistent --hub-root fail the CLI with no resources', async (t) => {
  const root = await mkdtemp(join(folder, 'argument-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [[], ['--hub-root'], ['--hub-root', root, '--extra'], ['--hub-root', join(root, 'missing')]]) {
    const child = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, CIRCLE_HOME: join(root, 'circle-home'), TMPDIR: root },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.signal, null);
    assert.equal(child.stdout, '');
  }
  assert.throws(() => parseArgs(['--hub-root', '--wrong']), /用法/);
});

test('all module paths are checked before importing a partial source tree', async (t) => {
  const root = await mkdtemp(join(folder, 'preflight-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'hub/connectors'), { recursive: true });
  const marker = join(root, 'module-was-imported');
  writeFileSync(
    join(root, 'hub/connectors/api.ts'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`,
  );
  await assert.rejects(loadHub(root), { code: 'ENOENT' });
  assert.equal(existsSync(marker), false);
});

const modules = [
  'hub/connectors/api.ts',
  'hub/refs/api.ts',
  'hub/testing/postgres.ts',
  'hub/knowledge/test-support.ts',
  'hub/knowledge/seed.ts',
  'hub/connectors/testing/credentials.ts',
  'hub/connectors/testing/packs.ts',
  'packs/workflow/case-review/packaging.ts',
  'packs/system/svn/api.ts',
  'hub/runs/api.ts',
  'hub/connectors/testing/api.ts',
];

for (const mode of ['body', 'cleanup', 'both']) {
  test(
    `actual CLI reports ${mode} failure with exit 1 and releases its real resources`,
    { timeout: 330_000 },
    async (t) => {
      const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'seed-cli-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const source = join(root, 'source');
      const scratch = join(root, 'tmp');
      const home = join(root, 'circle-home');
      const audit = join(root, 'resources.jsonl');
      await mkdir(scratch);
      await mkdir(home);
      // These wrappers live only in this test's directory. All allocations use
      // the repository's real helpers; only business results and failure points vary.
      for (const relative of modules) {
        const original = JSON.stringify(pathToFileURL(join(repository, relative)).href);
        let body = `export * from ${original};\n`;
        if (relative === 'hub/testing/postgres.ts') {
          body += `import {startPostgres as original} from ${original};
import {appendFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
export async function startPostgres(...args) {
  const pg = await original(...args);
  appendFileSync(${JSON.stringify(audit)}, JSON.stringify({kind:'postgres',pid:Number(readFileSync(join(pg.root,'data/postmaster.pid'),'utf8').split('\\n')[0]),port:pg.config.port})+'\\n');
  return pg;
}\n`;
        }
        if (relative === 'hub/connectors/testing/api.ts') {
          body += `import {startStub as original} from ${original};
import {appendFileSync} from 'node:fs';
export async function startStub(...args) {
  const server = await original(...args);
  appendFileSync(${JSON.stringify(audit)}, JSON.stringify({kind:'http',port:Number(new URL(server.origin).port)})+'\\n');
  return server;
}\n`;
        }
        if (relative === 'hub/knowledge/test-support.ts') {
          body += `import {makeWorld as original} from ${original};
export async function makeWorld(...args) {
  const w = await original(...args);
  w.knowledge.syncProduct = async () => ({error:null});
  const close = w.close;
  return {...w, close: async () => {
    await close();
    ${mode !== 'body' ? "throw Error('INJECTED_CLEANUP_ERROR');" : ''}
  }};
}\n`;
        }
        if (relative === 'hub/knowledge/seed.ts') {
          body += `export async function knowledgeSeed() {
  ${mode !== 'cleanup' ? "throw Error('INJECTED_BODY_ERROR');" : "return {ok:false,reason:'synthetic expected failure'};"}
}

export const formatSeedReport = (report) => JSON.stringify(report);\n`;
        }
        await mkdir(dirname(join(source, relative)), { recursive: true });
        await writeFile(join(source, relative), body);
      }
      let failure: { code?: number | string; stderr?: string; killed?: boolean; signal?: NodeJS.Signals | null } = {};
      try {
        await run(process.execPath, [script, '--hub-root', source], {
          env: { ...process.env, CIRCLE_HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
          timeout: 300_000,
        });
        assert.fail('the CLI must fail');
      } catch (error) {
        failure = error as typeof failure;
      }
      assert.equal(failure.code, 1, failure.stderr);
      assert.equal(failure.killed, false);
      assert.equal(failure.signal, null);
      if (mode !== 'cleanup') assert.match(failure.stderr ?? '', /INJECTED_BODY_ERROR/);
      if (mode !== 'body') assert.match(failure.stderr ?? '', /INJECTED_CLEANUP_ERROR/);
      assert.deepEqual(await readdir(scratch), []);
      const resources = (await readFile(audit, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        resources.map((item) => item.kind),
        ['postgres', 'http'],
      );
      for (const resource of resources) {
        await portClosed(resource.port);
        if (resource.pid) assert.throws(() => process.kill(resource.pid, 0), { code: 'ESRCH' });
      }
    },
  );
}

test(
  'the complete 109-file CLI returns naturally after its expected rejection reports and removes every temporary resource',
  { timeout: 330_000 },
  async (t) => {
    // PostgreSQL also creates a Unix socket; keep its directory below the macOS
    // socket-path limit even when the system's default temp path is long.
    const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'seed-full-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const scratch = join(root, 'tmp');
    const home = join(root, 'circle-home');
    await mkdir(scratch);
    await mkdir(home);
    const result = await run(process.execPath, [script, '--hub-root', repository], {
      env: { ...process.env, CIRCLE_HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      timeout: 300_000,
    });
    assert.match(result.stdout, /sync error: null/);
    assert.match(result.stdout, /DRY REPORT:/);
    assert.match(result.stdout, /SEED REPORT:/);
    const [dry, seeded] = result.stdout.split('DRY REPORT:')[1].split('SEED REPORT:');
    assert.match(dry, /\[famx\.adoc\.incomplete_group\]/);
    assert.match(seeded, /\[famx\.adoc\.incomplete_group\]/);
    assert.deepEqual(await readdir(scratch), []);
  },
);
