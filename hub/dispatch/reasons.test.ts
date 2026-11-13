import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { reportMissingFacts, statusDiagnostics } from './reasons.ts';
import { runnerNote } from './accepted.ts';
import type { RunJob } from './read-runs.ts';

const jobId = 'a'.repeat(64), content = 'b'.repeat(64);
function job(extra: Record<string, unknown> = {}): RunJob {
  return { job: jobId, verification_run: 'synthetic-run', plan_run: 'synthetic-plan', verification_item: 'synthetic-item', items: ['synthetic-case'], sha256: content, boundary_refused: false, ended: 'done', status: { job: jobId, phase: 'complete', outcome: 'not_dispatched', frozen: false, events: 3, ...extra } };
}

test('member diagnostics preserve three distinct producer-authored missing facts without administrative details', () => {
  const facts = ['本次测试环境尚未登记基线', '认证所需的证据文件当前不可读取', '本次绑定清单的摘要与可取得原件不一致'];
  const answers = facts.map(fact => statusDiagnostics(job({ missing_fact: 'private administrator detail usr_synthetic', next_action: 'circle-hub executor update exe_synthetic', member_missing_facts: [{ fact, next_action: '联系管理员补齐该事实后重新核对本次环境' }] }), false));
  for (const [index, answer] of answers.entries()) {
    assert.equal(answer.missing_facts[0]?.fact, facts[index]);
    assert.doesNotMatch(JSON.stringify(answer), /usr_synthetic|exe_synthetic|circle-hub/);
  }
  assert.equal(new Set(answers.map(answer => answer.missing_facts[0].fact)).size, 3);
});

test('administrator diagnostics retain the actual corrective action while members do not receive it', () => {
  const source = job({ missing_fact: '缺基线（管理员详情）', next_action: 'circle-hub job baseline list', member_missing_facts: [{ fact: '本次环境缺少登记基线', next_action: '联系管理员登记基线后重新核对' }] });
  assert.equal(statusDiagnostics(source, true).missing_facts[0].next_action, 'circle-hub job baseline list');
  assert.doesNotMatch(JSON.stringify(statusDiagnostics(source, false)), /管理员详情|circle-hub/);
});

test('an unresolved send never becomes not_sent and has no blind retry action', () => {
  const source = job({ outcome: 'unknown', frozen: true, request_id: 'private-request', reason: 'private-host' }); source.ended = 'unknown';
  const note = runnerNote(source, 'usr_private');
  assert.equal(note.outcome, 'unknown'); assert.equal(note.not_sent, undefined);
  assert.match(note.next_action!, /不要重交/);
  assert.doesNotMatch(JSON.stringify(note), /usr_private|private-request|private-host|circle-hub/);
});

test('a result reference alone never establishes a device verdict', async () => {
  const source = job({ outcome: 'effective', result: `src:${'c'.repeat(64)}` });
  const result = await reportMissingFacts({ objects: { get: async () => null } } as never, source, false);
  assert.equal(result.no_verdict, undefined);
  assert.equal(runnerNote(source, 'usr_private').no_verdict, undefined);
});

test('integrity-checked projected no_verdict preserves safe facts and never relays raw administrator prose', async () => {
  const report = { job: jobId, sha256: content, rows: [{ item: 'synthetic-case', dynamic_terminal: 'no_verdict', missing_facts: ['owned'], missing_fact: 'usr_private secret-private', next_action: 'circle-hub executor update exe_private' }] };
  const bytes = canonicalBytes(report), source = job({ outcome: 'effective', result: `src:${sha256Hex(bytes)}` });
  const records = { objects: { get: async () => bytes } } as never;
  const member = await reportMissingFacts(records, source, false);
  assert.equal(member.no_verdict, true); assert.match(member.missing_facts[0].fact, /归属/);
  assert.doesNotMatch(JSON.stringify(member), /usr_private|secret-private|exe_private|circle-hub/);
  assert.match((await reportMissingFacts(records, source, true)).missing_facts[0].next_action, /executor update/);
});

test('another job or corrupted projected bytes cannot supply a verdict', async () => {
  for (const wrongHash of [false, true]) {
    const bytes = canonicalBytes({ job: wrongHash ? jobId : 'd'.repeat(64), sha256: content, rows: [] });
    const source = job({ outcome: 'effective', result: `src:${wrongHash ? 'e'.repeat(64) : sha256Hex(bytes)}` });
    const result = await reportMissingFacts({ objects: { get: async () => bytes } } as never, source, false);
    assert.equal(result.no_verdict, undefined); assert.deepEqual(result.missing_facts, []);
  }
});

test('unknown send evidence takes precedence over an older booking diagnosis',()=>{
  const source=job({outcome:'unknown',frozen:true,booking:{target:'synthetic-bed',coverage_complete:false,required_resources:2,missing_resources:2,declared_device_count:2}});
  source.ended='unknown';
  const note=statusDiagnostics(source,false);
  assert.match(note.next_action,/不要重交/);
  assert.doesNotMatch(note.next_action,/先预订|开始新的运行/);
});
