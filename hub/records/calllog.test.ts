import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import type { CallLogInput, CallLogLine, Principal } from './api.ts';
import { argumentDigest } from './calllog.ts';
import { canonicalize } from './canonical.ts';
import { digestOf, recordDigest, sha256Hex } from './digest.ts';
import { IntegrityError, RecordsError } from './errors.ts';
import { newId } from './ids.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

async function query(kit: TestRecordsKit, text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ ...kit.database, ssl: false });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

const trace = (n: number) => n.toString(16).padStart(32, '0').replace(/^0/, 'a');
const span = (n: number) => n.toString(16).padStart(16, '0').replace(/^0/, 'b');

async function people(kit: TestRecordsKit): Promise<{ admin: Principal; alice: Principal; bob: Principal }> {
  const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
  const alice = await kit.principals.createUser(admin, '甲');
  const bob = await kit.principals.createUser(admin, '乙');
  const p = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });
  return { admin: p(admin), alice: p(alice), bob: p(bob) };
}

const fileLine=(line:CallLogLine)=>{const {admin_note,admin_reasons,...publicLine}=line;return publicLine;};

async function fileLines(kit: TestRecordsKit, day: string): Promise<CallLogLine[]> {
  const text = await readFile(join(kit.dataDir, 'logs', `calls-${day}.jsonl`), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as CallLogLine);
}

test('one line per call: a call_log record, a typed row and a JSONL line, with only the digest and size of the arguments', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { alice } = await people(kit);
  const marker = 'CASE-TEXT-合成用例正文-do-not-store';
  const args = { run: newId('run'), items: [{ item: 'doc:n1', slots: { findings: [{ statement: marker, quote: marker }] } }] };
  const input: CallLogInput = {
    at: '2026-10-21T23:59:59.999Z',
    traceId: trace(1),
    spanId: span(1),
    userId: alice.id,
    sessionId: 'circle-session-42',
    tool: 'submit_result',
    runId: args.run,
    arguments: args,
    callResult: 'error',
    acceptance: 'not_accepted',
    errorCode: 'QUOTE_MISMATCH',
    durationMs: 12.6,
  };
  const line = await kit.callLog.append(input);
  assert.deepEqual({ ...line, digest: undefined }, {
    at: '2026-10-21T23:59:59.999Z',
    trace_id: trace(1),
    span_id: span(1),
    user: alice.id,
    session: 'circle-session-42',
    tool: 'submit_result',
    run: args.run,
    args_digest: digestOf(args),
    args_size: Buffer.byteLength(canonicalize(args)),
    args_preview: null,
    call_result: 'error',
    acceptance: 'not_accepted',
    error_code: 'QUOTE_MISMATCH',
    duration_ms: 13,
    admin_note: null,
    digest: undefined,
  });
  const record = await kit.store.get(line.digest);
  assert.equal(record?.kind, 'call_log');
  assert.equal(record?.schema, 'call_log@1');
  assert.equal(record?.provenance, 'observed');
  await kit.callLog.append({ ...input, at: '2026-10-22T00:00:00.000Z', traceId: trace(2), spanId: span(2), callResult: 'ok', acceptance: 'accepted', errorCode: null });
  const logDir = join(kit.dataDir, 'logs');
  assert.deepEqual((await readdir(logDir)).sort(), ['calls-2026-10-21.jsonl', 'calls-2026-10-22.jsonl']);
  assert.deepEqual(await fileLines(kit, '2026-10-21'), [fileLine(line)]);
  assert.equal((await stat(join(logDir, 'calls-2026-10-21.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(logDir)).mode & 0o777, 0o700);
  // The argument content appears nowhere: not in the tables, not in the files.
  const everything = [
    JSON.stringify((await query(kit, 'SELECT * FROM records')).rows),
    JSON.stringify((await query(kit, 'SELECT * FROM call_logs')).rows),
    await readFile(join(logDir, 'calls-2026-10-21.jsonl'), 'utf8'),
    await readFile(join(logDir, 'calls-2026-10-22.jsonl'), 'utf8'),
  ].join('\n');
  assert.equal(everything.includes(marker), false);
  assert.equal(everything.includes('合成用例正文'), false);
  assert.equal(everything.includes('doc:n1'), false);
  // Retrying the same call (same span id) is idempotent: one record, one row, one file line.
  const again = await kit.callLog.append(input);
  assert.equal(again.digest, line.digest);
  assert.equal(Number((await query(kit, 'SELECT count(*) AS n FROM call_logs')).rows[0].n), 2);
  assert.equal((await fileLines(kit, '2026-10-21')).length, 1);
});

test('two calls with equal fields in the same millisecond stay two lines: each call has its own span id', async (t) => {
  const frozen = new Date('2026-10-21T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(frozen) });
  t.after(() => kit.close());
  const { admin, alice } = await people(kit);
  const call: CallLogInput = { traceId: trace(5), userId: alice.id, sessionId: 'one-session', tool: 'get_nodes', runId: null, arguments: { paths: ['/'] }, callResult: 'ok', durationMs: 3 };
  const [first, second] = await Promise.all([kit.callLog.append(call), kit.callLog.append(call)]);
  assert.notEqual(first.span_id, second.span_id);
  assert.notEqual(first.digest, second.digest);
  assert.match(first.span_id, /^[0-9a-f]{16}$/);
  assert.equal((await kit.callLog.query(admin)).items.length, 2);
  assert.equal((await fileLines(kit, '2026-10-21')).length, 2);
});

test('the real reason is kept outside the record: no digest a user sees covers the admin note', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await people(kit);
  const run = newId('run');
  const base = { sessionId: null, arguments: {}, durationMs: 1 } as const;
  const at = (second: number) => `2026-10-21T08:00:0${second}.000Z`;
  const note = '该用户没有分配 case-review 包';
  await kit.callLog.append({ ...base, at: at(1), traceId: trace(10), userId: alice.id, tool: 'list_task_packs', runId: null, callResult: 'ok' });
  const hidden = await kit.callLog.append({ ...base, at: at(2), traceId: trace(11), userId: alice.id, tool: 'get_nodes', runId: run, callResult: 'error', errorCode: 'SOURCE_UNAVAILABLE', adminNote: note });
  await kit.callLog.append({ ...base, at: at(3), traceId: trace(12), userId: bob.id, tool: 'get_nodes', runId: null, callResult: 'ok' });
  await kit.callLog.append({ ...base, at: at(4), traceId: trace(13), userId: null, tool: 'initialize', runId: null, callResult: 'transport_failure' });
  assert.equal(hidden.admin_note, note);
  const all = await kit.callLog.query(admin);
  assert.deepEqual(all.items.map((line) => line.trace_id), [trace(13), trace(12), trace(11), trace(10)]);
  assert.equal(all.items.find((line) => line.trace_id === trace(11))?.admin_note, note);
  const own = await kit.callLog.query(alice);
  assert.deepEqual(own.items.map((line) => line.trace_id), [trace(11), trace(10)]);
  for (const line of own.items) assert.equal('admin_note' in line, false);
  assert.equal(JSON.stringify(own).includes('没有分配'), false);
  // The digest the user sees is the digest of exactly what the user sees: guessing the note against it learns nothing.
  const seen = own.items.find((line) => line.trace_id === trace(11)) as CallLogLine;
  const { digest, ...visible } = seen;
  const digestWith = (body: unknown) => recordDigest({ kind: 'call_log', schema: 'call_log@1', provenance: 'observed', created_at: visible.at, body });
  assert.equal(digestWith(visible), digest);
  for (const guess of [note, null, '对象不存在']) assert.notEqual(digestWith({ ...visible, admin_note: guess }), digest);
  const record = await kit.store.get<Record<string, unknown>>(digest);
  assert.equal(record !== null && 'admin_note' in record.body, false);
  assert.equal(JSON.stringify((await query(kit, 'SELECT * FROM records')).rows).includes('没有分配'), false);
  assert.equal(JSON.stringify((await query(kit, 'SELECT * FROM call_logs')).rows).includes('没有分配'), false);
  assert.deepEqual((await query(kit, 'SELECT note FROM call_notes')).rows, [{ note }]);
  // Private summaries stay in the database even for legacy callers supplying only adminNote.
  const file=await fileLines(kit,'2026-10-21');
  assert.ok(file.every(line=>!('admin_note' in line)&&!('admin_reasons' in line)));
  assert.ok(!JSON.stringify(file).includes(note));
  assert.deepEqual(await kit.callLog.query(alice, { userId: bob.id }), { items: [], next: null });
  assert.deepEqual((await kit.callLog.query(admin, { userId: bob.id })).items.map((line) => line.trace_id), [trace(12)]);
  assert.deepEqual((await kit.callLog.query(admin, { tool: 'get_nodes', newestFirst: false })).items.map((line) => line.trace_id), [trace(11), trace(12)]);
  assert.deepEqual((await kit.callLog.query(admin, { runId: run })).items.map((line) => line.trace_id), [trace(11)]);
  assert.deepEqual(
    (await kit.callLog.query(admin, { from: '2026-10-21T08:00:02.000Z', to: '2026-10-21T08:00:04.000Z' })).items.map((line) => line.trace_id),
    [trace(12), trace(11)],
  );
  const first = await kit.callLog.query(admin, { limit: 3 });
  assert.equal(first.items.length, 3);
  const rest = await kit.callLog.query(admin, { limit: 3, cursor: first.next });
  assert.deepEqual(rest.items.map((line) => line.trace_id), [trace(10)]);
  assert.equal(rest.next, null);
});

test('the stored account decides what a query shows, not the Principal the caller kept', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice, bob } = await people(kit);
  const base = { sessionId: null, arguments: {}, durationMs: 1, tool: 'get_nodes', runId: null, callResult: 'ok' } as const;
  await kit.callLog.append({ ...base, traceId: trace(40), userId: alice.id, adminNote: '内部原因' });
  await kit.callLog.append({ ...base, traceId: trace(41), userId: bob.id });
  // A user who claims the admin role sees only their own calls and no note.
  const claimed = await kit.callLog.query({ ...alice, role: 'admin' });
  assert.deepEqual(claimed.items.map((line) => line.trace_id), [trace(40)]);
  assert.equal('admin_note' in claimed.items[0], false);
  // A demoted admin keeps an old Principal: user view. A disabled account sees nothing.
  const second = await kit.principals.createUser(admin, '二号', 'admin');
  const stale: Principal = { id: second.id, name: second.name, role: 'admin' };
  assert.equal((await kit.callLog.query(stale)).items.length, 2);
  await kit.principals.setRole(admin, second.id, 'user');
  assert.deepEqual(await kit.callLog.query(stale), { items: [], next: null });
  await kit.principals.setDisabled(admin, bob.id, true);
  assert.deepEqual(await kit.callLog.query(bob), { items: [], next: null });
  assert.deepEqual(await kit.callLog.query({ id: 'usr_00000000000000000000000000', name: '幽灵', role: 'admin' }), { items: [], next: null });
});

test('a file write that fails is completed by retrying with the same span id, and repairFiles restores lost lines', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice } = await people(kit);
  const logDir = join(kit.dataDir, 'logs');
  const day = '2026-10-21';
  const call: CallLogInput = { at: `${day}T09:00:00.000Z`, traceId: trace(50), spanId: span(50), userId: alice.id, sessionId: null, tool: 'start_run', runId: null, arguments: {}, callResult: 'ok', durationMs: 2, adminNote: '首因' };
  // The day's file cannot be written (a directory stands in its place): the call is recorded, the error says so.
  await mkdir(join(logDir, `calls-${day}.jsonl`), { recursive: true });
  await assert.rejects(kit.callLog.append(call), (error: unknown) => error instanceof RecordsError && /已经记入数据库/.test((error as Error).message));
  assert.equal((await kit.callLog.query(admin)).items.length, 1);
  await rm(join(logDir, `calls-${day}.jsonl`), { recursive: true });
  const retried = await kit.callLog.append(call);
  assert.deepEqual(await fileLines(kit, day), [fileLine(retried)]);
  await kit.callLog.append(call);
  assert.equal((await fileLines(kit, day)).length, 1);
  // A crash between the commit and the write: lines missing from the file, one of them cut half way.
  const second = await kit.callLog.append({ ...call, at: `${day}T09:00:01.000Z`, spanId: span(51), adminNote: null });
  const third = await kit.callLog.append({ ...call, at: `${day}T09:00:02.000Z`, spanId: span(52), adminNote: null });
  await writeFile(join(logDir, `calls-${day}.jsonl`), `${JSON.stringify(fileLine(retried))}\n${JSON.stringify(fileLine(second)).slice(0, 40)}`, { mode: 0o600 });
  assert.equal(await kit.callLog.repairFiles({ from: `${day}T00:00:00.000Z`, to: '2026-10-22T00:00:00.000Z' }), 2);
  const repaired = await fileLines(kit, day).catch(() => null);
  assert.equal(repaired, null, 'the cut line stays as it was and is not valid JSON');
  const text = await readFile(join(logDir, `calls-${day}.jsonl`), 'utf8');
  const parsed = text.split('\n').flatMap((raw) => {
    try {
      return [JSON.parse(raw) as CallLogLine];
    } catch {
      return [];
    }
  });
  assert.deepEqual(parsed.map((line) => line.digest), [retried.digest, second.digest, third.digest]);
  assert.equal(parsed[0].admin_note, undefined);
  assert.equal(await kit.callLog.repairFiles({ from: `${day}T00:00:00.000Z`, to: '2026-10-22T00:00:00.000Z' }), 0);
});

test('a client preview is kept only when it is at most 1 KB and holds no credential (B08 F[7], R[1])', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const valid: CallLogInput = { traceId: trace(60), userId: null, sessionId: null, tool: 'submit_result', runId: null, arguments: {}, callResult: 'ok', durationMs: 0 };
  const preview = '{"run":"run_…","items":[{"item":"doc:n1","handling":"judged","slots":"…"}]}';
  assert.equal((await kit.callLog.append({ ...valid, argsPreview: preview })).args_preview, preview);
  assert.equal((await kit.callLog.append({ ...valid, traceId: trace(61), argsPreview: '{"note":"password=Synth3tic9x"}' })).args_preview, null);
  await assert.rejects(kit.callLog.append({ ...valid, argsPreview: 'x'.repeat(1025) }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, argsPreview: '用'.repeat(342) }), TypeError);
  assert.equal(JSON.stringify((await query(kit, 'SELECT * FROM call_logs')).rows).includes('Synth3tic9x'), false);
});

test('a call log row altered behind the triggers is refused when read', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { admin, alice } = await people(kit);
  await kit.callLog.append({ traceId: trace(20), userId: alice.id, sessionId: null, tool: 'submit_result', runId: null, arguments: {}, callResult: 'error', durationMs: 1 });
  const client = new pg.Client({ ...kit.database, ssl: false });
  await client.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query("UPDATE call_logs SET call_result = 'ok'");
  } finally {
    await client.end();
  }
  await assert.rejects(kit.callLog.query(admin), IntegrityError);
});

test('inputs are validated; odd session headers are kept only as a digest; any argument value can be digested', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const valid: CallLogInput = { traceId: trace(30), userId: null, sessionId: null, tool: 'list_task_packs', runId: null, arguments: {}, callResult: 'ok', durationMs: 0 };
  for (const traceId of ['0'.repeat(32), 'A'.repeat(32), 'abc', `${'a'.repeat(31)}g`]) await assert.rejects(kit.callLog.append({ ...valid, traceId }), TypeError, traceId);
  for (const spanId of ['0'.repeat(16), 'A'.repeat(16), 'abc', 'a'.repeat(32)]) await assert.rejects(kit.callLog.append({ ...valid, spanId }), TypeError, spanId);
  await assert.rejects(kit.callLog.append({ ...valid, callResult: 'maybe' as never }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, acceptance: 'pending' as never }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, tool: 'bad tool name' }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, durationMs: -1 }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, userId: 'has space' }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, at: 'now' }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, at: '+010000-01-01T00:00:00.000Z' }), TypeError);
  await assert.rejects(kit.callLog.append({ ...valid, adminNote: '' }), TypeError);
  const odd = await kit.callLog.append({ ...valid, traceId: trace(31), sessionId: 'line\nbreak 会话' });
  assert.match(odd.session ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(argumentDigest(undefined).digest, digestOf(null));
  assert.match(argumentDigest({ big: 1n }).digest, /^[0-9a-f]{64}$/);
  assert.equal(argumentDigest({ lone: String.fromCharCode(0xd800) }).size > 0, true);
});

test('full administrator reasons are separate immutable rows outside records and JSONL',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {admin,alice}=await people(kit);
 const reasons=['第一条合成原因'+ '甲'.repeat(2500)+'FIRST-TAIL','第二条合成原因'+ '乙'.repeat(2500)+'SECOND-TAIL'];
 const input={at:'2026-10-21T08:00:01.000Z',sessionId:null,runId:null,traceId:trace(71),spanId:span(71),userId:alice.id,tool:'get_nodes',arguments:{},callResult:'error' as const,errorCode:'SOURCE_RETRYABLE',durationMs:1,adminNote:'合成摘要',adminReasons:reasons};
 const line=await kit.callLog.append(input);await kit.callLog.append(input);
 const adminLine=(await kit.callLog.query(admin,{userId:alice.id})).items.find(row=>row.digest===line.digest)!;
 assert.deepEqual(adminLine.admin_reasons,reasons);
 const stored=(await query(kit,'SELECT ordinal, note FROM call_reasons ORDER BY ordinal')).rows;assert.deepEqual(stored,reasons.map((note,ordinal)=>({ordinal,note})));
 const own=(await kit.callLog.query(alice,{})).items.find(row=>row.digest===line.digest)!;assert.equal('admin_reasons' in own,false);
 const bytes=await readFile(join(kit.dataDir,'logs','calls-2026-10-21.jsonl'),'utf8');assert.ok(!bytes.includes('FIRST-TAIL')&&!bytes.includes('SECOND-TAIL'));assert.ok(!bytes.includes('admin_reasons'));
 await rm(join(kit.dataDir,'logs','calls-2026-10-21.jsonl'));await kit.callLog.repairFiles({from:'2026-10-21T00:00:00.000Z',to:'2026-10-22T00:00:00.000Z'});
 const repaired=await readFile(join(kit.dataDir,'logs','calls-2026-10-21.jsonl'),'utf8');assert.ok(!repaired.includes('FIRST-TAIL')&&!repaired.includes('admin_reasons'));
 assert.ok(!JSON.stringify((await kit.store.get(line.digest))!.body).includes('合成原因'));
 await assert.rejects(query(kit,"UPDATE call_reasons SET note='changed'"));await assert.rejects(query(kit,'DELETE FROM call_reasons'));
});
test('administrator reasons never turn credential matches into stored text or fingerprints',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {admin,alice}=await people(kit);
 const secret='LogSyntheticCredential987654',reason='password = '+secret;
 const line=await kit.callLog.append({traceId:trace(72),spanId:span(72),userId:alice.id,sessionId:null,runId:null,tool:'get_nodes',arguments:{},callResult:'error',durationMs:1,adminNote:reason,adminReasons:['可记录的合成原因',reason]});
 const visible=(await kit.callLog.query(admin,{userId:alice.id})).items.find(item=>item.digest===line.digest)!;
 assert.equal(visible.admin_reasons![0],'可记录的合成原因');assert.match(visible.admin_reasons![1],/触发凭据扫描/);
 for(const table of ['records','call_logs','call_notes','call_reasons']){const text=JSON.stringify((await query(kit,`SELECT * FROM ${table}`)).rows);assert.ok(!text.includes(secret));assert.ok(!text.includes(sha256Hex(secret)));}
 const files=await readdir(join(kit.dataDir,'logs'));for(const name of files)assert.ok(!(await readFile(join(kit.dataDir,'logs',name),'utf8')).includes(secret));
});
