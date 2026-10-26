import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executorCommand, jobCommand } from '../server/cli-job.ts';
import { adminCommands } from '../server/cli-admin.ts';
import { setup } from './testing/context.ts';
import { definition } from './testing/definition.ts';

function session(c: Awaited<ReturnType<typeof setup>>) {
  const lines: string[] = [];
  return { lines, out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), admin: async () => c.admin,
    records: async () => c.kit, hub: async () => ({ dispatch: c.service, records: c.kit }), options: { readSecret: async () => {throw new Error('stdin must not be read');} }, ctx: { io: { cwd: c.kit.dataDir } } };
}
test('executor registration never reads stdin and accepts named credential references and prints no endpoint or secret', async t => {
  const c = await setup(); t.after(() => c.close()); const s = session(c);
  const file = join(c.kit.dataDir, 'executor.json'); await writeFile(file, JSON.stringify({...definition(c.endpoint.endpoint),credential:'${secret:DEMO_AUTH}'}));
  assert.equal(await executorCommand(s, ['add', file]), 0);
  assert.equal(await executorCommand(s, ['list']), 0);
  assert.match(s.lines.join('\n'),/写声明未写/);
  assert.ok(!s.lines.join('\n').includes(c.endpoint.endpoint)); assert.ok(!s.lines.join('\n').includes('synthetic-second-key'));
  assert.ok(adminCommands().some(c => c.name === 'executor')); assert.ok(adminCommands().some(c => c.name === 'job'));
});

test('precheck exports only to scratch files, dispatch prints a result reference and status is read-only', async t => {
  const c = await setup(); t.after(() => c.close()); const s = session(c);
  const saved = join(c.kit.dataDir, 'saved');
  assert.equal(await jobCommand(s, ['precheck', '--executor', c.executor.id, '--save', saved]), 0);
  const files = await readdir(saved); assert.ok(files.length > 0);
  for (const name of files) { assert.equal((await stat(join(saved, name))).mode & 0o777, 0o600); assert.ok(!(await readFile(join(saved, name), 'utf8')).includes('synthetic-secret')); }
  assert.equal(await jobCommand(s, ['dispatch', '--run', c.run, '--executor', c.executor.id]), 0);
  assert.ok(s.lines.some(l => /src:[a-f0-9]{64}/.test(l)));
  const body = await c.kit.store.getByKey<any>('action', `dispatch.bytes:${c.payload.body.sha256}:1`);
  assert.equal(await jobCommand(s, ['status', body!.body.detail.job]), 0);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
  assert.doesNotMatch(s.lines.join('\n'), /synthetic-secret|synthetic-bed|synthetic-case|synthetic-build|127\.0\.0\.1/);
});

test('mark-failed does not unfreeze without the explicit risk flag and always requires a reason', async t => {
  const c = await setup({ mode: 'reject' }); t.after(() => c.close()); const s = session(c);
  const job = await c.service.dispatch(c.admin, c.run, c.executor.id);
  await assert.rejects(jobCommand(s, ['dispose', job.job, '--mark-failed', '--accept-possible-duplicate-effects']));
  assert.equal(await jobCommand(s, ['dispose', job.job, '--mark-failed', '--reason', '合成原因']), 1);
  assert.equal((await c.service.status(c.admin, job.job)).frozen, true);
  await jobCommand(s, ['dispose', job.job, '--mark-failed', '--reason', '合成原因', '--accept-possible-duplicate-effects']);
  assert.equal((await c.service.status(c.admin, job.job)).frozen, false);
});

test('invalid or misplaced flags never echo argument values and commands close owned resources on failure', async t => {
  const c = await setup(); t.after(() => c.close()); const s = session(c);
  await assert.rejects(executorCommand(s, ['list', '--synthetic-second-key']), error => error instanceof Error && !error.message.includes('synthetic-second-key'));
  await assert.rejects(jobCommand(s, ['dispatch', '--run', c.run, '--executor', c.executor.id, '--mark-failed']));
  let closed = 0; c.service.options.close = async () => { closed++; };
  const source = c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any;
  source.plan_run = 'different';
  assert.equal(await jobCommand(s, ['dispatch', '--run', c.run, '--executor', c.executor.id]),1);
  assert.equal(closed, 1);
});

test('new update keys are checked before any definition is authorized', async t => {
  const c = await setup(); t.after(() => c.close()); const s = session(c);
  const file = join(c.kit.dataDir, 'bad-key-definition.json');
  await writeFile(file, JSON.stringify({ ...c.executor.definition, precheck_context: { marker: 'synthetic-second-key' } }));
  await assert.rejects(executorCommand(s, ['update', c.executor.id, file, '--secret']));
  assert.equal((await c.registry.get(c.executor.id))!.digest, c.executor.digest);
  assert.equal(await c.kit.vault.has(`executor.${c.executor.id}.bearer`),false);const [material]=await c.kit.variables.recentSecrets();assert.equal(material.value,'synthetic-secret');
});

test('exported audit metadata contains configured pointers and both byte and shared canonical hashes', async t => {
  const c = await setup(); t.after(() => c.close()); const s = session(c);
  const saved = join(c.kit.dataDir, 'hashed-precheck');
  await jobCommand(s, ['precheck', '--executor', c.executor.id, '--save', saved]);
  const meta = JSON.parse(await readFile(join(saved, 'checksums.json'), 'utf8'));
  assert.ok(meta.observations.length);
  const first = meta.observations.find((o: any) => o.pointer === '/build');
  assert.match(first.original_sha256, /^[a-f0-9]{64}$/); assert.match(first.canonical_content_sha256, /^[a-f0-9]{64}$/);
  const { observationHashes } = await import('./api.ts');
  assert.deepEqual(observationHashes(await readFile(join(saved, first.file)), first.pointer), { pointer: first.pointer, original_sha256: first.original_sha256, canonical_content_sha256: first.canonical_content_sha256 });
});

test('numeric audit ids require an explicit flag and unsafe integers are rejected', async t => {
  const c = await setup({ mode: 'reject', alter: (name, value) => name === 'read_blob' || name === 'send_blob' ? { ...value, key: 17 } : value }); t.after(() => c.close()); const s = session(c);
  const job = await c.service.dispatch(c.admin, c.run, c.executor.id);
  await assert.rejects(jobCommand(s, ['dispose', job.job, '--reconcile', '9007199254740993', '--numeric-id']));
  assert.equal(await jobCommand(s, ['dispose', job.job, '--reconcile', '17', '--numeric-id']), 0);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
});

test('conformance CLI exports evidence without printing deployment data or submitting a dispatch intent', async t => {
  const { setupJournal } = await import('./testing/journal.ts'); const c = await setupJournal({uncertified:true}); t.after(()=>c.close()); const s = session(c);
  const save = join(c.kit.dataDir,'conformance');
  assert.equal(await jobCommand(s,['conformance','--executor',c.executor.id,'--save',save]),1);
  assert.equal((await readdir(save)).length,2);
  assert.doesNotMatch(s.lines.join('\n'),/synthetic-secret|synthetic-bed|synthetic-remote|127\.0\.0\.1/);
  assert.ok(s.lines.some(line=>line.includes('结果引用 src:')));
});

test('precheck exports every seat response with its operation and selector without printing raw values',async t=>{
  const {probes}=await import('./testing/probes.ts');
  const c=await setup({extraTools:['inspect_seat'],alter:(name,value)=>name==='inspect_seat'?{output:'version: synthetic-build\naddress: 192.0.2.1/24'}:value});t.after(()=>c.close());const s=session(c);
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,allowed_tools:[...c.executor.definition.allowed_tools,'inspect_seat'],probes});
  const save=join(c.kit.dataDir,'seat-observations');
  assert.equal(await jobCommand(s,['precheck','--executor',c.executor.id,'--save',save]),1);
  const meta=JSON.parse(await readFile(join(save,'checksums.json'),'utf8'));
  const seats=meta.observations.filter((o:any)=>o.operation?.startsWith('probe.'));
  assert.equal(seats.length,4);assert.ok(seats.every((o:any)=>o.pointer==='/output' && /^[a-f0-9]{64}$/.test(o.original_sha256)));
  assert.doesNotMatch(s.lines.join('\n'),/192\.0\.2\.1|synthetic-build|synthetic-secret/);
});
