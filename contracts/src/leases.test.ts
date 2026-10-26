// C1 的合约测试：动作种类“租约”、三个错误码、context 键 leases、工作流声明 leases、投影结果
// lease_requests、RunRecord.leases、租约动作 body。全部先写（改前失败）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PROTOCOL_CODES } from '../generated/protocol.ts';
import { ACTION_KIND, ACTION_KIND_LABEL } from '../generated/vocabulary.ts';
import { CONTEXT_KEY, RunContext, WorkflowFile, ProjectionOutput } from './pack.ts';
import { RunRecord } from './run.ts';
import { z } from 'zod';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as {
  elements: Array<{ id: string; rules: string[]; changes5?: string[] }>;
  vocabulary: Array<{ axis: string; values: Array<{ code: string; label: string }> }>;
  formatProposals: { protocolCodes: Array<{ code: string; when: string; fix: string }> };
};

test('the action-kind axis has lease with its Chinese label, after move_root', () => {
  assert.ok((ACTION_KIND as readonly string[]).includes('lease'));
  assert.equal(ACTION_KIND_LABEL.lease, '租约');
  const axis = model.vocabulary.find((a) => a.axis === 'action_kind')!;
  const codes = axis.values.map((v) => v.code);
  assert.deepEqual(codes, [...codes.filter((c) => c !== 'lease'), 'lease'].filter((c) => codes.includes(c)));
  assert.equal(codes[codes.length - 1], 'lease');
  assert.equal(axis.values.find((v) => v.code === 'lease')?.label, '租约');
});

test('D04 R[0] says a booking lease is held by lineage, with a revision note', () => {
  const d04 = model.elements.find((e) => e.id === 'D04')!;
  const r0 = d04.rules[0];
  assert.match(r0, /预订类租约按血缘（W06）持有：以预订运行为前驱的运行沿用同一份租约，由 Hub 在派发时核对前驱关系/);
  assert.ok((d04.changes5 ?? []).some((c) => c.includes('预订类租约按血缘')));
});

test('the three lease protocol codes are registered with Chinese when and fix text', () => {
  for (const code of ['LEASE_UNAVAILABLE', 'LEASE_EXPIRED', 'FENCING_STALE']) {
    assert.ok(code in PROTOCOL_CODES, code);
    assert.ok(/[\u3400-\u9fff]/.test(PROTOCOL_CODES[code as keyof typeof PROTOCOL_CODES].when), `${code} when`);
    assert.ok(/[\u3400-\u9fff]/.test(PROTOCOL_CODES[code as keyof typeof PROTOCOL_CODES].fix), `${code} fix`);
    const inModel = model.formatProposals.protocolCodes.find((c) => c.code === code);
    assert.ok(inModel !== undefined, `${code} in model.json`);
  }
  assert.match(PROTOCOL_CODES.LEASE_UNAVAILABLE.when, /租约/);
  assert.match(PROTOCOL_CODES.LEASE_EXPIRED.when, /到期/);
  assert.match(PROTOCOL_CODES.FENCING_STALE.when, /围栏|令牌/);
});

test('CONTEXT_KEY gains leases and RunContext carries the frozen lease view (no tokens, only mine)', () => {
  assert.deepEqual(CONTEXT_KEY, ['builds', 'leases']);
  const parsed = RunContext.safeParse({
    product: null,
    names: [],
    line: null,
    build: null,
    root: null,
    parameters: {},
    groups: [],
    leases: { now: '2026-10-22T08:00:00.000Z', entries: [{ since:'2026-10-22T08:00:00.000Z',run:'run_synthetic',jobs:[],key: 'some/prefix/key-1', until: '2026-10-22T10:00:00.000Z', mine: true }, { since:'2026-10-22T08:00:00.000Z',run:'run_synthetic',jobs:[],key: 'some/prefix/key-2', until: '2026-10-23T10:00:00.000Z', mine: false }] },
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  // a token or a holder name never appears in the frozen view
  const bad = RunContext.safeParse({
    product: null, names: [], line: null, build: null, root: null, parameters: {}, groups: [],
    leases: { now: '2026-10-22T08:00:00.000Z', entries: [{ key: 'k', until: '2026-10-22T10:00:00.000Z', mine: true, token: 3 }] },
  });
  assert.ok(!bad.success, 'the lease view carries no token');
});

const workflow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  schema: 'workflow@1',
  inputs: [{ slot: 'subject', role: 'subject', required: true, many: false, accepts: ['knowledge:index'], description: 'd' }],
  parameters: [],
  product: { catalogs: [] },
  subject: 'subject',
  projection: { module: 'functions/project.ts' },
  ...extra,
});

test('a workflow may declare leases with a prefix ending in / and a TTL cap', () => {
  const good = WorkflowFile.safeParse(workflow({ leases: { prefix: 'bench/', max_ttl_seconds: 7200 }, context: ['leases'] }));
  assert.ok(good.success, JSON.stringify(good.error?.issues));
  assert.equal(good.data?.leases?.prefix, 'bench/');
  // a prefix not ending in / is refused
  const badPrefix = WorkflowFile.safeParse(workflow({ leases: { prefix: 'bench', max_ttl_seconds: 7200 }, context: ['leases'] }));
  assert.ok(!badPrefix.success && badPrefix.error.issues.some((i) => /斜杠|prefix/.test(i.message)), JSON.stringify(badPrefix.error?.issues));
  // a negative or zero cap is refused
  for (const cap of [0, -1]) {
    const badCap = WorkflowFile.safeParse(workflow({ leases: { prefix: 'bench/', max_ttl_seconds: cap }, context: ['leases'] }));
    assert.ok(!badCap.success, `cap ${cap}`);
  }
});

test('declaring leases without asking for the leases context is refused', () => {
  const parsed = WorkflowFile.safeParse(workflow({ leases: { prefix: 'bench/', max_ttl_seconds: 7200 } }));
  assert.ok(!parsed.success);
  assert.ok(parsed.error.issues.some((i) => /context/.test(i.message) && /leases/.test(i.message)), JSON.stringify(parsed.error?.issues));
});

test('the projection result may carry lease_requests: keys and a TTL each', () => {
  const sha = '0123456789abcdef'.repeat(4);
  const item = { id: 'i1', label: '一条', location: { source: sha, parser: 'json@1', selector: '/x' }, fields: {} };
  const good = ProjectionOutput.safeParse({ items: [item], warnings: [], lease_requests: [{ keys: ['bench/zone-1/target-3'], ttl_seconds: 3600 }] });
  assert.ok(good.success, JSON.stringify(good.error?.issues));
  const noLease = ProjectionOutput.safeParse({ items: [item], warnings: [] });
  assert.ok(noLease.success, 'lease_requests is optional');
});

test('RunRecord gains leases: the lease id, its keys and the until moment', () => {
  const base = {
    run: 'run_0123456789abcdefghjkmnpqrs',
    pack: 'demo@1.0.0',
    pack_digest: 'a'.repeat(64),
    sources: [],
    requirements: [],
    target_basis: [],
    items: [],
    instructions: '规程',
    instructions_digest: 'b'.repeat(64),
    started_at: '2026-10-22T08:00:00.000Z',
    runner: 'usr_0123456789abcdefghjkmnpqrs',
    host: 'local_circle',
    trigger: 'session',
    parameters: {},
  };
  const withLeases = RunRecord.safeParse({ ...base, leases: [{ lease: 'lse_0123456789abcdefghjkmnpqrs', keys: ['bench/zone-1/target-3'], until: '2026-10-22T10:00:00.000Z' }] });
  assert.ok(withLeases.success, JSON.stringify(withLeases.error?.issues));
  const without = RunRecord.safeParse(base);
  assert.ok(without.success, 'leases is optional');
});

test('the lease_op axis holds the seven lease operations with D04’s words, and a revision note names the audit', async () => {
  const axis = model.vocabulary.find((a) => a.axis === 'lease_op');
  assert.ok(axis, 'the model has a lease_op axis');
  assert.deepEqual(
    axis.values.map((v) => [v.code, v.label]),
    [
      ['acquire', '取得'],
      ['extend', '续租'],
      ['release', '释放'],
      ['force_release', '强制释放'],
      ['take_over', '接管'],
      ['register', '登记'],
      ['unregister', '注销'],
    ],
  );
  const d04 = model.elements.find((e) => e.id === 'D04')!;
  const notes = [...((d04 as { changes6?: string[] }).changes6 ?? [])];
  assert.ok(notes.some((c) => c.includes('lease_op') && c.includes('核对')), 'a revision note names the audit');
  const { LEASE_OP, LEASE_OP_LABEL, LeaseOpSchema, isLeaseOp } = await import('../generated/vocabulary.ts');
  assert.deepEqual([...LEASE_OP], ['acquire', 'extend', 'release', 'force_release', 'take_over', 'register', 'unregister']);
  assert.equal(LEASE_OP_LABEL.force_release, '强制释放');
  assert.equal(LEASE_OP_LABEL.take_over, '接管');
  assert.ok(isLeaseOp('take_over') && !isLeaseOp('steal'));
  assert.ok(LeaseOpSchema.safeParse('force_release').success);
  assert.ok(!LeaseOpSchema.safeParse('renew').success);
});

test('lease_requests accepts only acquire, extend and release from the lease_op axis', () => {
  const sha = '0123456789abcdef'.repeat(4);
  const item = { id: 'i1', label: '一条', location: { source: sha, parser: 'json@1', selector: '/x' }, fields: {} };
  for (const request of [
    { keys: ['bench/a'], ttl_seconds: 60 },
    { op: 'acquire', keys: ['bench/a'], ttl_seconds: 60 },
    { op: 'extend', keys: ['bench/a'], ttl_seconds: 60 },
    { op: 'release', keys: ['bench/a'] },
  ]) {
    assert.ok(ProjectionOutput.safeParse({ items: [item], warnings: [], lease_requests: [request] }).success, JSON.stringify(request));
  }
  for (const request of [
    { op: 'force_release', keys: ['bench/a'] },
    { op: 'take_over', keys: ['bench/a'], ttl_seconds: 60 },
    { op: 'steal', keys: ['bench/a'] },
    { op: 'extend', keys: ['bench/a'] },
    { op: 'release', keys: ['bench/a'], ttl_seconds: 60 },
  ]) {
    assert.ok(!ProjectionOutput.safeParse({ items: [item], warnings: [], lease_requests: [request] }).success, JSON.stringify(request));
  }
});

test('the lease action detail shape is a zod schema the records package can check', async () => {
  const { LeaseDetail } = await import('../src/records.ts');
  const good = {
    op: 'acquire',
    lease: 'lse_0123456789abcdefghjkmnpqrs',
    keys: ['bench/zone-1/target-3'],
    holder: { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' },
    until: '2026-10-22T10:00:00.000Z',
    token: 7,
  };
  assert.ok(LeaseDetail.safeParse(good).success, JSON.stringify(LeaseDetail.safeParse(good).error?.issues));
  for (const op of ['extend', 'release', 'force_release', 'take_over'] as const) {
    assert.ok(LeaseDetail.safeParse({ ...good, op }).success, op);
  }
  assert.ok(!LeaseDetail.safeParse({ ...good, op: 'steal' }).success);
  // the token is a plain monotonic number; a holder without a run is refused (a lease is held by a run)
  assert.ok(!LeaseDetail.safeParse({ ...good, holder: { user: 'user-1' } }).success);
  assert.ok(!LeaseDetail.safeParse({ ...good, holder: { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'not-a-run' } }).success);
  assert.ok(!LeaseDetail.safeParse({ ...good, token: 'seven' }).success);
});

test('uncapped workflows accept a lease acquisition without a deadline', () => {
  assert.ok(WorkflowFile.safeParse(workflow({ leases: { prefix: 'zone/' }, context: ['leases'] })).success);
  assert.ok(ProjectionOutput.safeParse({ items: [], warnings: [], lease_requests: [{ keys: ['zone/a/k'] }] }).success);
});

test('projection operations include owner registration and reasoned force release without tokens', () => {
  for (const request of [
    {op:'register',prefix:'zone/a/'},
    {op:'unregister',prefix:'zone/a/',reason:'合成注销'},
    {op:'force_release',keys:['zone/a/k'],reason:'合成处置'},
  ]) assert.ok(ProjectionOutput.safeParse({items:[],warnings:[],lease_requests:[request]}).success);
  assert.ok(!ProjectionOutput.safeParse({items:[],warnings:[],lease_requests:[{op:'force_release',keys:['zone/a/k'],reason:' '}]}).success);
});

test('a force release preserves the user reason verbatim while rejecting whitespace alone',()=>{
  const value=ProjectionOutput.parse({items:[],warnings:[],lease_requests:[{op:'force_release',keys:['zone/a/k'],reason:'  合成原话  '}]});
  assert.ok('items' in value);
  const request=value.lease_requests![0]!;
  assert.equal('reason' in request?request.reason:undefined,'  合成原话  ');
});

test('historical lease snapshots stay readable without manufacturing current context fields',()=>{
  const legacy={key:'zone/a/k',until:'2026-10-24T10:00:00.000Z',mine:false};
  const record={run:'run_0123456789abcdefghjkmnpqrs',pack:'demo@1.0.0',pack_digest:'a'.repeat(64),sources:[],requirements:[],target_basis:[],items:[],instructions:'合成规程',instructions_digest:'b'.repeat(64),started_at:'2026-10-24T08:00:00.000Z',runner:'usr_0123456789abcdefghjkmnpqrs',host:'local_circle',trigger:'session',parameters:{},lease_context:[legacy]};
  const parsed=RunRecord.safeParse(record);assert.ok(parsed.success,JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.lease_context,[legacy]);
  assert.ok(!RunContext.safeParse({product:null,names:[],line:null,build:null,root:null,parameters:{},groups:[],leases:{now:record.started_at,entries:[legacy],registrations:[]}}).success,'new run context still requires the complete row');
  assert.ok(!RunRecord.safeParse({...record,lease_context:[{...legacy,token:1}]}).success);
});
