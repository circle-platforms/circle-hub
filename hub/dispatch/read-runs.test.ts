import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecordsKit, Principal } from '../records/api.ts';
import { dispatchedRuns, readRunJobs, runReservations } from './read-runs.ts';
const run='run_00000000000000000000000001',plan='run_00000000000000000000000002';
const admin:Principal={id:'usr_00000000000000000000000001',name:'合成管理员',role:'admin'};
test('run dispatch reads traverse all reservation pages, retain exact bindings and never write',async()=>{
  const records={store:{find:async(query:{cursor:string|null})=>({items:query.cursor?[]:[{body:{detail:{binding:{job:'a'.repeat(64),input:{run,plan_run:plan,item:'verification',items:['case-a'],sha256:'b'.repeat(64)}}}}}],next:query.cursor?null:'second'}),findMany:async()=>Array.from({length:3},()=>({digest:'d'.repeat(64),body:{detail:{}}})),put:()=>{throw new Error('read API attempted a write');}}} as unknown as Pick<RecordsKit,'store'>;
  const seen:string[]=[];
  const dispatch={status:async(_by:Principal,job:string)=>{seen.push(job);return{job,phase:'result',outcome:'effective' as const,frozen:false,events:3,result:`src:${'c'.repeat(64)}`,admin_release:[{condition:'private_condition',label:'管理员说明',satisfied:false,fields:[]}],admin_release_missing:true};}};
  const jobs=await readRunJobs(records,dispatch,admin,plan);
  assert.equal(jobs.length,1);assert.equal(jobs[0].verification_run,run);assert.deepEqual(jobs[0].items,['case-a']);
  assert.equal(jobs[0].status.admin_release,undefined);assert.equal(jobs[0].status.admin_release_missing,undefined);
  assert.equal(jobs[0].sha256,'b'.repeat(64));assert.equal(seen.length,1);
  assert.deepEqual(await readRunJobs(records,dispatch,admin,'run_00000000000000000000000003'),[]);
});

test('read-only management projection takes the named exit from the original journal request',async()=>{
  const due='2026-10-26T00:00:00.000Z',at='2026-10-24T00:00:00.000Z',question='e'.repeat(64);
  const records={store:{find:async()=>({items:[{body:{detail:{binding:{job:'a'.repeat(64),input:{run,plan_run:plan,item:'verification',items:['case-a'],sha256:'b'.repeat(64)}}}}}],next:null}),findMany:async()=>[
    {digest:question,body:{detail:{audience_user:admin.id,deadline:due}}},
    {digest:'d'.repeat(64),body:{ended_at:at,detail:{phase:'dispose',disposition:'mark_failed',acting_by:admin.id,answers:['rec:'+question]}}}
  ],put:()=>{throw new Error('unexpected write');}}} as unknown as Pick<RecordsKit,'store'>;
  const jobs=await readRunJobs(records,{status:async()=>({job:'a'.repeat(64),phase:'disposed',outcome:'unknown',frozen:true,events:2,disposition:'mark_failed'})},admin,run);
  assert.deepEqual(jobs[0].management_exit,{action:'request',request_kind:'disposition',audience:{user:admin.id},due});
  assert.equal(jobs[0].status.decided_by,admin.id);assert.equal(jobs[0].status.decided_at,at);assert.equal(jobs[0].status.frozen,true);
});

test('a run job names the executor its reservation bound, and none when the reservation names no valid one', async () => {
  const executor = 'exe_0000000000000000000000000a';
  const reservation = (job: string, bound: unknown) => ({ body: { detail: { binding: { job, executor: bound, input: { run, plan_run: plan, item: 'verification', items: ['case-a'], sha256: 'b'.repeat(64) } } } } });
  const records = { store: {
    find: async () => ({ items: [reservation('a'.repeat(64), executor), reservation('c'.repeat(64), 'not-an-executor')], next: null }),
    findMany: async (query: { values: string[] }) => [{ digest: 'd'.repeat(64), body: { detail: { job: query.values[0] } } }],
    put: () => { throw new Error('unexpected write'); },
  } } as unknown as Pick<RecordsKit, 'store'>;
  const jobs = await readRunJobs(records, { status: async (_by: Principal, job: string) => ({ job, phase: 'result', outcome: 'effective' as const, frozen: false, events: 1 }) }, admin, run);
  assert.equal(jobs.find((job) => job.job === 'a'.repeat(64))?.executor, executor);
  assert.equal(jobs.find((job) => job.job === 'c'.repeat(64))?.executor, undefined);
});

test('one reading of the reservations gives each run what a reading of its own gives, and a bad record spoils only its run', async () => {
  const job = 'a'.repeat(64), unbound = 'd'.repeat(64), bad = 'run_00000000000000000000000003', none = 'run_00000000000000000000000004';
  const reservation = (binding: unknown) => ({ body: { detail: { binding } } });
  const pages = [
    [reservation({ job, input: { run, plan_run: plan, item: 'verification', items: ['case-a'], sha256: 'b'.repeat(64) } }), reservation({ job: unbound, run }), { body: { detail: {} } }],
    [reservation({ job: 'not-a-digest', input: { run: bad, plan_run: bad } })],
  ];
  let reads = 0;
  const records = { store: {
    find: async (query: { cursor: string | null }) => { reads++; return query.cursor === null ? { items: pages[0], next: 'more' } : { items: pages[1], next: null }; },
    findMany: async (query: { values: string[] }) => [{ digest: 'e'.repeat(64), body: { detail: { job: query.values[0] } } }],
    put: () => { throw new Error('unexpected write'); },
  } } as unknown as Pick<RecordsKit, 'store'>;
  const dispatch = { status: async (_by: Principal, id: string) => ({ job: id, phase: 'result', outcome: 'effective' as const, frozen: false, events: 1 }) };
  const reservations = await runReservations(records);
  assert.equal(reads, 2, 'every page is read');
  reads = 0;
  for (const named of [run, plan]) assert.deepEqual(await readRunJobs(records, dispatch, admin, named, { reservations }), await readRunJobs(records, dispatch, admin, named));
  assert.equal(reads, 4, 'only the readings of their own went to the store');
  reads = 0;
  assert.deepEqual((await readRunJobs(records, dispatch, admin, run, { unbound: true, reservations })).map((row) => row.job), [job, unbound]);
  assert.deepEqual(await readRunJobs(records, dispatch, admin, none, { reservations }), []);
  await assert.rejects(readRunJobs(records, dispatch, admin, bad, { reservations }), /派发预订记录缺少运行绑定/);
  assert.equal(reads, 0, 'the one reading served them all');
});

test('the runs of some jobs come from those jobs alone, never from a scan of every reservation', async () => {
  const job = 'a'.repeat(64), other = 'c'.repeat(64), unbound = 'd'.repeat(64);
  const event = (phase: string, binding?: unknown) => ({ body: { detail: { phase, ...(binding ? { binding } : {}) } } });
  const journal: Record<string, unknown[]> = {
    [job]: [event('dispatch_ordinal'), event('reservation', { job, input: { run, plan_run: plan } }), event('reservation', { job, input: { run, plan_run: plan } }), event('result')],
    [other]: [event('reservation', { job: other, input: { run: 'run_00000000000000000000000003', plan_run: plan } })],
    [unbound]: [event('reservation', { job: unbound, run })],
  };
  const asked: string[] = [];
  const records = { store: {
    find: async () => { throw new Error('unexpected scan of the reservations'); },
    findMany: async (query: { key: string; values: string[] }) => { assert.equal(query.key, 'dispatch.job'); asked.push(...query.values); return query.values.flatMap((value) => journal[value] ?? []); },
  } } as unknown as Pick<RecordsKit, 'store'>;
  const runs = await dispatchedRuns(records, [job, unbound]);
  assert.deepEqual([...runs.entries()].sort(), [[plan, [job]], [run, [job]]].sort(), 'a job binds its verification and plan run, once each; a job with no input binds neither');
  assert.deepEqual(asked, [job, unbound]);
  assert.equal((await dispatchedRuns(records, [])).size, 0);
});
