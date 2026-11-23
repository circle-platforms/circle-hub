import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { StartRunOutput } from '../../contracts/src/tools.ts';
import type { Principal } from '../records/api.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import { writePack } from '../runs/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { assembleHub, type AssembledHub } from './assemble/hub.ts';
import { removeTree } from './assemble/files.ts';
import { DOCS_PACK, docsPack } from './assemble/test-packs.ts';
import { toolText } from './text.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

const enc = new TextEncoder();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const call = { traceId: TRACE, sessionId: null, adminNote: () => {} };
const body = enc.encode(JSON.stringify({ items: [{ title: '甲', expected: ['乙'] }] }));

async function world(names: readonly string[]) {
  const kit = await openTestRecords({ postgres });
  const scratch = await mkdtemp(join(tmpdir(), 'circle-hub-docs-'));
  const hub: AssembledHub = await assembleHub(
    { dataDir: kit.dataDir, logDir: join(kit.dataDir, 'logs'), host: '127.0.0.1', port: 0, database: kit.database, limits: { ...kit.config.limits } },
    kit,
    { requireOsIsolation: await osIsolationAvailable(), log: () => {}, resourceCacheMs: 0, extractDir: join(scratch, 'extracted') },
  );
  const boot = await kit.principals.bootstrapAdmin('管理员');
  const admin: Principal = { id: boot.user.id, name: boot.user.name, role: boot.user.role };
  await kit.authorizations.grantPublishRight(admin, boot.user.id, '文档测试发布工作流');
  assert.ok((await hub.registry.publish(admin, (await writePack(join(scratch, DOCS_PACK), docsPack())).dir)).ok);
  const memberRecord = await kit.principals.createUser(boot.user, '甲', 'user');
  const member: Principal = { id: memberRecord.id, name: memberRecord.name, role: memberRecord.role };
  const otherRecord = await kit.principals.createUser(boot.user, '乙', 'user');
  const other: Principal = { id: otherRecord.id, name: otherRecord.name, role: otherRecord.role };
  for (const who of [admin, member, other]) await kit.authorizations.assign(admin, who.id, DOCS_PACK);
  for (const name of names) await hub.docs.put(admin, name, body, { fileName: `${name}.json` });
  const started = async (who: Principal, external: string) => {
    const answer = await hub.runs.startRun(who, { pack: DOCS_PACK, inputs: { spec: { external } } }, call);
    const errors = answer.errors ?? [];
    const text = errors.length === 0 ? '' : toolText('start_run', StartRunOutput.parse({ call_result: 'error', errors, trace: TRACE }), { caller: { role: who.role === 'admin' ? 'admin' : 'user', name: who.name } });
    return { answer, errors, text };
  };
  return { kit, hub, admin, member, other, started, close: async () => { await removeTree(scratch).catch(() => {}); await kit.close(); } };
}

const NAMES = ['synthetic-topology', 'synthetic-contract', 'synthetic-profile'];

for (const role of ['member', 'administrator'] as const) {
  test(`${role}: a name that does not exist is refused with the names that do, the nearest first`, async (t) => {
    const w = await world(NAMES); t.after(() => w.close());
    const who = role === 'member' ? w.member : w.admin;
    const wrong = await w.started(who, 'doc:doc:case-contract');
    assert.deepEqual(wrong.errors.map((e) => [e.code, e.path]), [['SOURCE_ABSENT', '/inputs/spec']]);
    assert.equal(wrong.errors[0]!.message, 'Hub 里没有命名文档 case-contract，当前账户可读的命名文档：synthetic-contract、synthetic-profile、synthetic-topology');
    assert.equal(wrong.text, '不存在：Hub 里没有命名文档 case-contract，当前账户可读的命名文档：synthetic-contract、synthetic-profile、synthetic-topology。核对文档名；该填的名字写在这个工作流的输入说明里（list_task_packs 带 pack_id 读）；命名文档由管理员发布（circle-hub doc put）。');
    const slip = await w.started(who, 'doc:doc:synthetic-contrat');
    assert.equal(slip.text, '不存在：Hub 里没有命名文档 synthetic-contrat，当前账户可读的命名文档里最接近的是 synthetic-contract。核对文档名；该填的名字写在这个工作流的输入说明里（list_task_packs 带 pack_id 读）；命名文档由管理员发布（circle-hub doc put）。');
  });

  test(`${role}: an identity written with something after @ that is no digest is told so, not refused for a missing resource`, async (t) => {
    const w = await world(NAMES); t.after(() => w.close());
    const who = role === 'member' ? w.member : w.admin;
    const wrong = await w.started(who, 'doc:doc:synthetic-contract@draft');
    assert.deepEqual(wrong.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/inputs/spec']]);
    assert.equal(wrong.errors[0]!.message, '「@draft」不是命名文档的摘要：@ 后面要写 64 位十六进制摘要，只读当前版本就不写 @ 和后面的部分');
    assert.equal(wrong.text, '参数无效：「@draft」不是命名文档的摘要：@ 后面要写 64 位十六进制摘要，只读当前版本就不写 @ 和后面的部分。照 doc:doc:<名字> 或 doc:doc:<名字>@<64 位摘要> 写。');
    assert.doesNotMatch(wrong.text, /没有能读|资源|circle-hub|连接|暂时不可用/, 'no resource is missing, and no administrator has anything to repair');
    const capitals = await w.started(who, 'doc:doc:Synthetic-Contract');
    assert.deepEqual(capitals.errors.map((e) => e.code), ['SUBMISSION_SCHEMA_VIOLATION']);
    assert.equal(capitals.text, '参数无效：命名文档的名字「Synthetic-Contract」不合法：要写成小写字母开头的字母、数字或连字符，1 到 64 个字符，当前账户可读的命名文档里最接近的是 synthetic-contract。照 doc:doc:<名字> 或 doc:doc:<名字>@<64 位摘要> 写。');
  });
}

test('the right identity is read as before, and a digest that never was a revision keeps its own reason', async (t) => {
  const w = await world(NAMES); t.after(() => w.close());
  const right = await w.started(w.member, 'doc:doc:synthetic-contract');
  assert.ok(right.answer.run !== undefined, JSON.stringify(right.errors));
  const never = await w.started(w.member, `doc:doc:synthetic-contract@${'f'.repeat(64)}`);
  assert.deepEqual(never.errors.map((e) => e.code), ['SOURCE_ABSENT']);
  assert.equal(never.errors[0]!.message, '命名文档 synthetic-contract 没有过这份摘要的内容');
  assert.match(never.errors[0]!.fix ?? '', /不写 @ 和后面的部分/, 'the next step is about the digest, not about the name');
});

test('a list that is cut says how many documents there are and where the name to write is', async (t) => {
  const many = ['synthetic-contract', 'synthetic-profile', 'synthetic-topology', 'synthetic-alpha', 'synthetic-bravo', 'synthetic-charlie', 'synthetic-delta'];
  const w = await world(many); t.after(() => w.close());
  const wrong = await w.started(w.member, 'doc:doc:case-contract');
  assert.equal(wrong.errors[0]!.message, 'Hub 里没有命名文档 case-contract，当前账户可读的命名文档共 7 个，最接近的是：synthetic-contract、synthetic-bravo、synthetic-alpha、synthetic-charlie、synthetic-delta（该填的名字看这个工作流的输入说明，用 list_task_packs 带 pack_id 读）');
  assert.match(wrong.text, /^不存在：Hub 里没有命名文档 case-contract，当前账户可读的命名文档共 7 个，最接近的是：.*list_task_packs 带 pack_id 读）。核对文档名；该填的名字写在这个工作流的输入说明里（list_task_packs 带 pack_id 读）；命名文档由管理员发布（circle-hub doc put）。$/);
  assert.match(wrong.errors[0]!.fix ?? '', /list_task_packs/);
});

test('with no named document published the refusal names none, and the type is read whatever follows it', async (t) => {
  const w = await world([]); t.after(() => w.close());
  const wrong = await w.started(w.member, 'doc:doc:case-contract');
  assert.equal(wrong.errors[0]!.message, 'Hub 里没有命名文档 case-contract');
  assert.equal(await w.hub.docs.reader.accepts('doc:doc:synthetic-contract@draft'), true, 'the Hub reads this type: what is wrong with the identity is the read’s to say');
  assert.equal(await w.hub.docs.reader.accepts('doc:other:x'), false);
});

test('names go only to a caller who could read the documents through this call', async (t) => {
  const w = await world(NAMES); t.after(() => w.close());
  const mine = await w.started(w.member, 'doc:doc:synthetic-contract');
  const run = mine.answer.run!.run;
  const read = (who: Principal, context: { run: string | null }) => w.hub.docs.reader.read('doc:doc:case-contract', { principal: who, run: context.run, purpose: '测试' });
  const outside = await read(w.member, { run: null });
  const another = await read(w.other, { run });
  const runner = await read(w.member, { run });
  const reasonOf = (answer: Awaited<ReturnType<typeof read>>) => (answer.ok ? '' : answer.inputError?.message ?? answer.reason);
  assert.equal(reasonOf(outside), 'Hub 里没有命名文档 case-contract', 'a member outside any run is told of no document');
  assert.equal(reasonOf(another), 'Hub 里没有命名文档 case-contract', 'a run that is not theirs gives no names either');
  assert.match(reasonOf(runner), /当前账户可读的命名文档：synthetic-contract、synthetic-profile、synthetic-topology$/, 'the runner of the run reads them through it');
  assert.match(reasonOf(await read(w.admin, { run: null })), /synthetic-contract/, 'an administrator reads them anywhere');
});
