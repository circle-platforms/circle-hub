// Administrator run list: pages with a cursor, filters, unknowns only, a non-admin refused, and no submission text.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { H, RECOVERY, TRACE, partitions, runRecord } from '../../contracts/src/fixtures.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { ValidationResult } from '../../contracts/src/validation.ts';
import { FileKeyProvider, newId, openRecords } from '../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import type { CliIo } from './api.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { main } from './cli.ts';
import { loadServerConfig } from './main.ts';
import { putResult, putRun, putSubmission } from '../runs/engine/store.ts';

const RUNTIME = 'hub_runtime';
const BODY = '合成提交正文不应出现';
const QUOTE = '合成引文不应出现';
const SECRET = '合成凭据字样不应出现';
let postgres: TemporaryPostgres;
let scratch: string;
let env: NodeJS.ProcessEnv;
let adminToken = '';
let userToken = '';
const ids: Record<string, string> = {};

before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
  scratch = await mkdtemp(join(tmpdir(), 'circle-hub-run-list-'));
  const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: 'postgres' });
  await client.connect();
  await client.query(`CREATE ROLE ${RUNTIME} LOGIN NOSUPERUSER`);
  await client.end();
  const database = await postgres.createDatabase();
  env = {
    CIRCLE_HUB_DATA_DIR: join(scratch, 'data'),
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
    CIRCLE_HUB_DATABASE_PORT: String(postgres.config.port),
    CIRCLE_HUB_DATABASE_NAME: database.database,
    CIRCLE_HUB_DATABASE_USER: RUNTIME,
  };
  assert.equal((await run(['serve', '--migrate-only'])).code, 0);
  const root = await run(['user', 'create', '根管理员', '--role', 'admin']);
  adminToken = root.out.find((line) => /^[A-Za-z0-9_-]{43}$/.test(line))!;
  assert.equal((await run(['user', 'create', '甲'], { ...env, CIRCLE_HUB_TOKEN: adminToken })).code, 0);
  assert.equal((await run(['user', 'create', '乙'], { ...env, CIRCLE_HUB_TOKEN: adminToken })).code, 0);
  userToken = (await run(['token', 'issue', '甲', '--raw'], { ...env, CIRCLE_HUB_TOKEN: adminToken })).out[0]!;
  const kit = await openRecords(loadServerConfig(env), { migrate: false });
  try {
    const jia = (await kit.principals.findByName('甲'))!;
    const yi = (await kit.principals.findByName('乙'))!;
    const stored = async (name: string, runner: string, pack: string, started: string, result: ValidationResult | null) => {
      const run = RunRecord.parse({
        ...runRecord,
        run: newId('run'),
        runner,
        pack,
        started_at: started,
        submission_due: '2026-10-28T00:00:00.000Z',
        client_key: name,
        instructions: '按规程评审每个用例。',
      });
      ids[name] = run.run;
      await putRun(kit.store, run, started);
      await putSubmission(kit.store, { run: run.run, digest: H, body: { notes: BODY, quote: QUOTE, marker: SECRET, label: '端口越界' }, parses: true, createdAt: started });
      if (result !== null) await putResult(kit.store, { ...result, run: run.run }, started);
    };
    await stored('clean', jia.id, 'quality-board@1.0.0', '2026-10-24T00:00:00.000Z', accepted(false));
    await stored('unknown', jia.id, 'case-review@1.2.0', '2026-10-23T00:00:00.000Z', accepted(true));
    await stored('refused', yi.id, 'case-review@1.1.0', '2026-10-22T00:00:00.000Z', refused());
    await stored('open', jia.id, 'quality-board@1.0.0', '2026-10-21T00:00:00.000Z', null);
  } finally {
    await kit.close();
  }
});

after(async () => {
  await postgres?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function accepted(unknown: boolean): ValidationResult {
  const literal = unknown
    ? { layer: 'static' as const, terminal: 'unchecked' as const, reason: 'no_check' as const, missing: '合成缺口', exit: { ...RECOVERY.exit, audience: { user: RECOVERY.exit.audience.user } } }
    : { layer: 'static' as const, terminal: 'pass' as const };
  return ValidationResult.parse({
    schema: 'validation@1',
    run: 'run_01jacd5z8q3w7v9h2k4m6n8p0r',
    submission: H,
    acceptance: 'accepted',
    errors: [],
    rounds: { used: 0, max: 0 },
    partitions: partitions({
      delivered: [{
        item: 'item-1',
        label: QUOTE,
        location: `src:${H}/text@1/l/1`,
        requirements: [
          { requirement: 'literal', layers: [literal], status: unknown ? 'pending' : 'satisfied', claims: [] },
          { requirement: 'catalog', layers: [{ layer: 'static', terminal: 'violation', code: 'core.catalog.param_out_of_range', tier: 'advisory' }], status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch', claims: [] },
        ],
      }],
    }),
    cross_item: [],
    coverage: { complete: true, examined: 1, total: 1 },
    locks: { pack: 'case-review@1.2.0', pack_digest: H },
    trace: TRACE,
  });
}

function refused(): ValidationResult {
  return ValidationResult.parse({
    ...accepted(false),
    acceptance: 'not_accepted',
    errors: [{ code: 'QUOTE_MISMATCH', message: BODY, fix: QUOTE }],
    partitions: partitions({}),
    cross_item: [],
  });
}

function capture(current: NodeJS.ProcessEnv): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env: current, cwd: scratch }, out, err };
}

async function run(argv: string[], current: NodeJS.ProcessEnv = env) {
  const c = capture(current);
  const code = await main(argv, { io: c.io, keyProvider: () => new FileKeyProvider(join(scratch, 'vault.key')), ownerRole: postgres.config.user, operatorTokens: () => memoryOperatorTokens(null, '测试的空钥匙串') });
  return { code, out: c.out, err: c.err, text: [...c.out, ...c.err].join('\n') };
}

function listed(argv: string[], current: NodeJS.ProcessEnv = { ...env, CIRCLE_HUB_TOKEN: adminToken }) {
  return run(argv, current);
}

function idsOf(text: string): string[] {
  return [...text.matchAll(/运行 (run_[0-9a-z]+)/g)].map((match) => match[1]!);
}

function cursorOf(text: string): string | null {
  return text.match(/下一页游标 (\S+)/)?.[1] ?? null;
}

test('pages newest first and the cursor continues without dropping a row', async () => {
  const first = await listed(['run', 'list', '--limit', '2']);
  assert.equal(first.code, 0, first.text);
  assert.deepEqual(idsOf(first.text), [ids.clean, ids.unknown]);
  const cursor = cursorOf(first.text);
  assert.ok(cursor);
  const second = await listed(['run', 'list', '--limit', '2', '--cursor', cursor!]);
  assert.equal(second.code, 0, second.text);
  assert.deepEqual(idsOf(second.text), [ids.refused, ids.open]);
  assert.equal(cursorOf(second.text), null);
  const json = await listed(['run', 'list', '--limit', '2', '--json']);
  assert.equal(json.code, 0, json.text);
  const page = JSON.parse(json.out[0]!) as { runs: Array<{ run: string }>; next: string };
  assert.deepEqual(page.runs.map((row) => row.run), [ids.clean, ids.unknown]);
  assert.equal(page.next, cursor);
});

test('pack, user, state and since each keep only the matching runs', async () => {
  assert.deepEqual(idsOf((await listed(['run', 'list', '--pack', 'case-review'])).text), [ids.unknown, ids.refused]);
  assert.deepEqual(idsOf((await listed(['run', 'list', '--pack', 'quality-board@9.9.9'])).text), [ids.clean, ids.open]);
  assert.deepEqual(idsOf((await listed(['run', 'list', '--user', '乙'])).text), [ids.refused]);
  assert.deepEqual(idsOf((await listed(['run', 'list', '--state', '进行中'])).text), [ids.open]);
  assert.deepEqual(idsOf((await listed(['run', 'list', '--state', '未受理'])).text), [ids.refused]);
  assert.deepEqual(idsOf((await listed(['run', 'list', '--state', '受理'])).text), [ids.clean, ids.unknown]);
  assert.deepEqual(idsOf((await listed(['run', 'list', '--since', '2026-10-23T00:00:00.000Z'])).text), [ids.clean, ids.unknown]);
  const mismatch = await listed(['run', 'list', '--pack', 'case-review', '--cursor', cursorOf((await listed(['run', 'list', '--limit', '1'])).text)!]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.text, /游标与这次筛选不一致/);
});

test('unknown keeps only runs whose newest accepted result has an unknown terminal', async () => {
  const answer = await listed(['run', 'list', '--unknown']);
  assert.equal(answer.code, 0, answer.text);
  assert.deepEqual(idsOf(answer.text), [ids.unknown]);
  assert.match(answer.text, /验证 受理/);
  assert.match(answer.text, /终态 catalog 不通过 1，literal 未核对 1/);
  assert.match(answer.text, /未知 1/);
  assert.match(answer.text, /发起 甲/);
  assert.match(answer.text, /包 case-review@1\.2\.0/);
});

test('a non-admin is refused and the listing never prints submission text, quotes or the stored marker', async () => {
  const refused = await listed(['run', 'list'], { ...env, CIRCLE_HUB_TOKEN: userToken });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /只有管理员可以列出运行/);
  assert.equal(idsOf(refused.text).length, 0);
  const all = await listed(['run', 'list', '--json']);
  assert.equal(all.code, 0, all.text);
  for (const phrase of [BODY, QUOTE, SECRET, '端口越界', '按规程评审每个用例']) assert.equal(all.text.includes(phrase), false, phrase);
  const help = await run(['help']);
  assert.match(help.text, /run list/);
  assert.match(help.text, /不输出提交正文、引文或凭据/);
});
