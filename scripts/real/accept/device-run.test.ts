import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { argumentsOf, Configuration, parseJobReply, continuation, runCases, reportLines, verification, checkedRunId } from './device-run.ts';
const hash = 'a'.repeat(64); const run = 'run_00000000000000000000000000'; const exe = 'exe_00000000000000000000000000';
test('arguments require an explicit executor and reject duplicates unknown flags and missing values', () => {
  assert.equal(argumentsOf(['--config', 'fixture.json', '--out', 'stage', '--executor', exe])['--executor'], exe);
  for (const argv of [[], ['--config', 'f', '--out', 's'], ['--config', 'f', '--config', 's', '--executor', exe], ['--config', 'f', '--other', 's', '--executor', exe]]) assert.throws(() => argumentsOf(argv));
  assert.throws(() => checkedRunId('untrusted')); assert.equal(checkedRunId(run), run);
});
test('configuration permits only administrator CLI and explicit staged files', () => {
  const config = { cli: { command: 'circle-hub' }, definition: 'executor.json', selection: 'auto-cases.json', contract: 'runtime-contract.json', inventory: 'test-bed-manifest.json', profile: 'runtime-profile.json' };
  assert.ok(Configuration.safeParse(config).success); assert.ok(!Configuration.safeParse({ ...config, token: 'synthetic' }).success);
});
test('job reply parser requires a complete final state and preserves result reference', () => {
  const s = parseJobReply(`阶段已预留；作业摘要 ${hash}\n阶段 complete；码 effective（已生效）；作业摘要 ${hash}；冻结 0；动作 12\n结果引用 src:${hash}`);
  assert.equal(s.job, hash); assert.equal(s.frozen, false); assert.equal(s.result, `src:${hash}`);
  assert.throws(() => parseJobReply(`阶段已预留；作业摘要 ${hash}`));
  assert.throws(() => parseJobReply(`阶段 complete；码 invented；作业摘要 ${hash}；冻结 0；动作 1`));
});
test('continuation needs both exact human confirmation and a changed definition digest', () => {
  assert.throws(() => continuation(hash, hash, '已用首例证据更新认证'));
  assert.throws(() => continuation(hash, 'b'.repeat(64), 'yes'));
  assert.equal(continuation(hash, 'b'.repeat(64), '已用首例证据更新认证'), '人工确认，不是机械核对认证字段');
});
function fixture(answers = ['确认派发', '确认派发'], frozen = false, reuse = false) {
  const calls: string[] = []; const completed: string[] = [];
  const ports = {
    async prepare(id: string) { calls.push(`prepare:${id}`); return { run: id, sha256: hash, booking: reuse ? 'booking' : `booking-${id}` }; },
    async confirm() { calls.push('confirm'); return answers.shift() ?? ''; },
    async dispatch() { calls.push('dispatch'); return { job: hash, phase: 'complete', outcome: frozen ? 'unknown' as const : 'effective' as const, frozen, result: frozen ? undefined : `src:${hash}`, events: 12 }; },
    async result() { calls.push('result'); },
    async release(booking: string) { calls.push(`release:${booking}`); },
    async save(id: string) { calls.push('save'); completed.push(id); },
  };
  return { calls, completed, ports };
}
test('cases are sequential with independent bookings and confirmation before each dispatch', async () => {
  const f = fixture(); await runCases(['one', 'two'], [], f.ports);
  assert.deepEqual(f.calls, ['prepare:one', 'confirm', 'dispatch', 'result', 'release:booking-one', 'save', 'prepare:two', 'confirm', 'dispatch', 'result', 'release:booking-two', 'save']);
});
test('reuse of the first booking is refused before the next confirmation or dispatch', async () => {
  const f = fixture(undefined, false, true); await assert.rejects(runCases(['one', 'two'], [], f.ports), /自己占台架/); assert.equal(f.calls.filter(c => c === 'dispatch').length, 1);
});
test('declining confirmation emits no dispatch and never advances to another case', async () => {
  const f = fixture(['no']); await assert.rejects(runCases(['one', 'two'], [], f.ports), /确认/); assert.ok(!f.calls.includes('dispatch')); assert.equal(f.completed.length, 0);
});
test('unknown first delivery stops the second without releasing or resubmitting', async () => {
  const f = fixture(undefined, true); await assert.rejects(runCases(['one', 'two'], [], f.ports), /对账/); assert.equal(f.calls.filter(c => c === 'dispatch').length, 1); assert.ok(!f.calls.includes('prepare:two')); assert.ok(!f.calls.some(c => c.startsWith('release:'))); assert.equal(f.completed.length, 0);
});
test('failure to establish release prevents the next case', async () => {
  const f = fixture(); f.ports.release = async () => { throw new Error('缺本例释放记录，请 Circle 完成释放'); };
  await assert.rejects(runCases(['one', 'two'], [], f.ports), /释放/); assert.ok(!f.calls.includes('prepare:two'));
});
test('per case reports always carry the local operation qualifier and preserve observation blocks', () => {
  const observations = [{ description: '合成外部动作', observation: '本次日志里没有这一项的标记', reference: `src:${hash}` }];
  const qualifier = { nature: 'unknown', provenance: 'projected', marks: ['target_reported', 'report_for_dispatch', 'local_ops_not_excluded'] };
  const limits = ['目标对本次派发的报告', '未排除本地操作'];
  const lines = reportLines({ rows: [{ dynamic_terminal: 'no_verdict', reported_terminal: 'pass', qualifier, limits, missing_fact: '合成完整性缺口', reason: 'integrity_unproven', next_action: '合成管理员补取原件', accepted_as_fact: false }], side_effects: observations });
  assert.deepEqual(JSON.parse(lines[0]).qualifier, qualifier); assert.deepEqual(JSON.parse(lines[0]).limits, limits); assert.deepEqual(JSON.parse(lines[1]).side_effects, observations);
});
function verified() {
  return { run: { run, predecessor: run, pack: 'case-compile@2.1.0', items: [{ fields: { autoid: 'synthetic-case' } }], sources: [
    ...[['contract', 'runner-contract'], ['profile', 'runtime-profile'], ['inventory', 'bed-topology']].map(([slot, name]) => ({ slot, external: `doc:doc:${name}@${hash}`, reference: `src:${hash}` })),
    { slot: 'workbook', role: 'artifact_under_verification', reference: `src:${hash}` },
  ] }, latest: { result: { acceptance: 'accepted', errors: [], partitions: { delivered: [{ requirements: [{ status: 'satisfied' }] }], incomplete: [] } } } };
}
test('administrative preflight checks exact autoid fixed document bindings and completed verification', () => {
  assert.equal(verification(verified(), 'synthetic-case', hash).sha256, hash);
  assert.throws(() => verification(verified(), 'another-case', hash));
  const wrongDoc = verified(); (wrongDoc.run.sources[0] as { external: string }).external = `doc:doc:other@${hash}`; assert.throws(() => verification(wrongDoc, 'synthetic-case', hash));
  const incomplete = verified(); incomplete.latest.result.partitions.delivered[0].requirements[0].status = 'pending'; assert.throws(() => verification(incomplete, 'synthetic-case', hash));
});
test('real entry point contains no MCP calls generation booking or duration policy', () => {
  const source = readFileSync(new URL('./device-run.ts', import.meta.url), 'utf8');
  assert.ok(!/callTools|generateWorkbook|upload_file|submit_result|renewalHours|ttl_seconds|3600000/.test(source));
});

test('stage zero hashes parsed defaults and refuses HTTP CA omission digest drift and disabled entries', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { definition } = await import('../../../hub/dispatch/testing/definition.ts');
  const { ExecutorDefinition } = await import('../../../hub/dispatch/api.ts');
  const { checkedDefinition } = await import('./device-run.ts');
  const { canonicalBytes, sha256Hex } = await import('../../../hub/records/api.ts');
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-device-ca-'));
  try {
    writeFileSync(join(dir, 'cert.conf'), '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=synthetic\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-config', join(dir, 'cert.conf'), '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const raw: Record<string, unknown> = { ...definition('https://127.0.0.1/mcp'), ca: readFileSync(join(dir, 'cert.pem'), 'utf8') }; delete raw.poll_ms;
    const digest = sha256Hex(canonicalBytes(ExecutorDefinition.parse({ ...raw, id: exe })));
    const line = `执行器编号 ${exe}；定义摘要 ${digest}；启用 1；具备派发登记 1；解析后摘要 ${digest}；变量 无`;
    assert.equal(checkedDefinition(raw, exe, line).digest, digest);
    assert.throws(() => checkedDefinition(raw, exe, line.replace(digest, hash)));
    assert.throws(() => checkedDefinition({ ...raw, endpoint: 'http://127.0.0.1/mcp' }, exe, line));
    assert.throws(() => checkedDefinition({ ...raw, ca: '' }, exe, line));
    assert.throws(() => checkedDefinition(raw, exe, line.replace('启用 1', '启用 0')));
    const {ExecutorSource,resolveExecutorValues}=await import('../../../hub/dispatch/api.ts');
    const referenced={...raw,target:'${var:DEMO_TARGET}'};const values=new Map([['DEMO_TARGET','synthetic-bed']]);
    const source=ExecutorSource.parse({...referenced,id:exe});const sourceHash=sha256Hex(canonicalBytes(source));const resolvedHash=sha256Hex(canonicalBytes(resolveExecutorValues(source,values)));
    const variableLine=`执行器编号 ${exe}；定义摘要 ${sourceHash}；启用 1；具备派发登记 1；解析后摘要 ${resolvedHash}；变量 DEMO_TARGET 第 1 版`;
    assert.equal(checkedDefinition(referenced,exe,variableLine,values).resolved_digest,resolvedHash);
    assert.throws(()=>checkedDefinition(referenced,exe,variableLine));
    assert.throws(()=>checkedDefinition(referenced,exe,variableLine.replace(resolvedHash,'f'.repeat(64)),values));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('result reporting preserves source qualifications gaps and recovery without replacing them', () => {
  const row = { reported_terminal: 'pass', dynamic_terminal: 'no_verdict', missing_fact: '缺少同租约连续性', missing_facts: ['continuity'], reason: 'integrity_unproven', next_action: '请管理员核对原租约观察；不得重交', qualifier: { nature: 'unknown', provenance: 'projected', marks: ['target_reported', 'report_for_dispatch', 'local_ops_not_excluded'] }, accepted_as_fact: false, limits: ['目标对本次派发的报告', '未排除本地操作'] };
  assert.deepEqual(JSON.parse(reportLines({ rows: [row] })[0]), { case_index: 1, ...row });
  for (const optional of ['reason', 'next_action', 'qualifier', 'accepted_as_fact']) { const without: Record<string, unknown> = { ...row }; delete without[optional]; assert.deepEqual(JSON.parse(reportLines({ rows: [without] })[0]), { case_index: 1, ...without }); }
  assert.throws(() => reportLines({ rows: [{ ...row, limits: ['目标对本次派发的报告'] }] }), /limits/);
  for (const field of ['missing_fact', 'limits']) {
    const bad: Record<string, unknown> = { ...row }; delete bad[field]; if (field === 'missing_fact') delete bad.missing_facts;
    assert.throws(() => reportLines({ rows: [bad] }), new RegExp(field === 'missing_fact' ? 'missing_fact' : field));
  }
});

test('batch qualifications are derived from each result source rather than a fixed script label', async () => {
  const { batchQualifications } = await import('./device-run.ts');
  const row = { reported_terminal: 'pass', dynamic_terminal: 'pass', qualifier: { nature: 'judgment', provenance: 'projected', marks: ['target_reported', 'report_for_dispatch'] }, accepted_as_fact: false, limits: ['合成结果限定'] };
  assert.deepEqual(batchQualifications([{ rows: [row], qualifier_marks: ['target_reported'], limits: ['合成批次限定'] }]), [{ case_index: 1, rows: [{ case_index: 1, qualifier: row.qualifier, accepted_as_fact: false, limits: row.limits }], qualifier_marks: ['target_reported'], limits: ['合成批次限定'] }]);
});

test('producer no verdict rows remain printable and aggregate without optional metadata', async () => {
  const { batchQualifications } = await import('./device-run.ts');
  for (const reported_terminal of ['pass', null]) {
    const missing_fact = reported_terminal === null ? '结果通道不完整或条目没有可解释的报告；请管理员只读补取原作业结果' : '结果按派发身份归属尚未认证；该值只转述目标报告';
    const row = { item: 'synthetic-case', reported_terminal, dynamic_terminal: 'no_verdict', missing_fact, limits: ['目标对本次派发的报告', '未排除本地操作'] };
    assert.deepEqual(JSON.parse(reportLines({ rows: [row] })[0]), { case_index: 1, reported_terminal, dynamic_terminal: row.dynamic_terminal, missing_fact, limits: row.limits });
    assert.deepEqual(batchQualifications([{ rows: [row], limits: row.limits }]), [{ case_index: 1, rows: [{ case_index: 1, missing_fact, limits: row.limits }], limits: row.limits }]);
    const fields: Record<string, unknown> = JSON.parse(reportLines({ rows: [row] })[0]);
    for (const optional of ['reason', 'next_action', 'qualifier', 'accepted_as_fact']) assert.ok(!Object.hasOwn(fields, optional));
  }
});
