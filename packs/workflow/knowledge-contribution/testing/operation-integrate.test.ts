import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Submission } from '../../../../contracts/src/submission.ts';
import { ContributionInput } from '../../../../contracts/src/contributions.ts';
import { KnowledgeStructureSchema } from '../../../../contracts/src/feeding.ts';
import { SESSION, ROOT, PACK_DIGEST, TOKEN, scratch, fakeHub, enable, hook, skill } from './operation-support.ts';
import { scanWithMatches } from '../tools/operation-capture/lib/credentials.ts';
import { HubClient } from '../tools/operation-capture/lib/hub.ts';

test('observation procedure and pitfall submissions use the actual B3 contracts and run lock without model versions', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  assert.equal((await hook(local, 'step one: check ORBIT\nstep two: record ready\n')).code, 0);
  assert.equal((await hook(local, 'COMET synthetic display empty\n')).code, 0);
  const [observation, procedure, pitfall] = [...hub.uploads.keys()];
  const document = {
    schema: 'operation-integration@1',
    session: SESSION,
    items: [
      { capture: observation, kind: 'observation', path: '/commands/system/show', statement: '核对 ORBIT 合成状态', action: '执行合成状态检查', quote: { line: 1, text: 'ORBIT synthetic status: ready' } },
      { capture: procedure, kind: 'procedure', path: '/commands/system/show', statement: 'ORBIT 合成检查步骤', goal: '记录合成状态', steps: [{ text: '先检查', quote: { line: 1, text: 'step one: check ORBIT' } }, { text: '再记录', quote: { line: 2, text: 'step two: record ready' } }] },
      { capture: pitfall, kind: 'pitfall', path: '/commands/system/show', statement: 'COMET 合成空显示先检查输入', phenomenon: '合成显示为空', suggestion: '先核对合成输入', quote: { line: 1, text: 'COMET synthetic display empty' } },
    ],
  };
  const proposals = join(local.home, 'proposals.json');
  await writeFile(proposals, JSON.stringify(document));
  const result = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--build', 'ORBIT-synthetic-1', '--model', 'integration-synthetic@1']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /合成受理回执/);
  assert.equal(hub.runs.length, 1);
  assert.equal(hub.runs[0].product, 'ORBIT');
  assert.equal(hub.runs[0].build, 'ORBIT-synthetic-1');
  assert.equal(hub.runs[0].inputs.originals.length, 3);
  assert.equal(hub.submissions.length, 1);
  const submission = Submission.parse(hub.submissions[0]);
  assert.equal(submission.items.length, 3);
  assert.equal(submission.model, `integration-synthetic@1（Circle 技能 operation-capture，knowledge-contribution@${PACK_DIGEST}）`);
  const schemas: string[] = [];
  for (const item of submission.items) {
    assert.equal(item.handling, 'handled');
    const row = (item.slots!.contribution as Array<{ code: string; text: string; data: Record<string, unknown> }>)[0]!;
    assert.equal(row.code, 'assertion');
    const data = row.data as any;
    assert.equal(data.root, ROOT);
    assert.equal(data.feeding.product, 'ORBIT');
    assert.equal(data.feeding.root, ROOT);
    ContributionInput.parse({ ...data, kind: row.code, statement: row.text });
    KnowledgeStructureSchema.parse(data.feeding);
    schemas.push(data.feeding.schema);
    for (const forbidden of ['object', 'binding', 'by', 'run', 'at', 'version', 'build', 'line']) assert.ok(!(forbidden in data.feeding), forbidden);
    assert.equal(data.feeding.source.system, 'upload');
    assert.equal(hub.uploads.get(data.feeding.source.bytes)?.provenance, 'client_captured');
  }
  assert.deepEqual(schemas, ['fed-observation@1', 'fed-procedure@1', 'fed-pitfall@1']);
  assert.equal([...hub.uploads.values()].filter(upload => upload.provenance === 'declared').length, 1, 'only the ordinary work manifest is declared');
});

test('a changed quote a fourth kind or a model supplied version is refused before a run or submission', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const capture = [...hub.uploads.keys()][0]!;
  const base = { capture, kind: 'observation', path: '/commands/system/show', statement: '核对合成状态', action: '执行合成检查', quote: { line: 1, text: 'ORBIT synthetic status: readyX' } };
  const proposals = join(local.home, 'proposals.json');
  for (const [item, code] of [
    [base, 'quote_mismatch'],
    [{ ...base, kind: 'note', quote: { line: 1, text: 'ORBIT synthetic status: ready' } }, 'unsupported_operation_kind'],
    [{ ...base, quote: { line: 1, text: 'ORBIT synthetic status: ready' }, version: 'model-invented-version' }, 'invalid_shape'],
  ] as const) {
    await writeFile(proposals, JSON.stringify({ schema: 'operation-integration@1', session: SESSION, items: [item] }));
    const result = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
    assert.equal(result.code, 1);
    assert.match(result.err, new RegExp(code));
  }
  assert.equal(hub.runs.length, 0);
  assert.equal(hub.submissions.length, 0);
  assert.equal(hub.uploads.size, 1, 'no work manifest was uploaded for an invalid proposal');
});

test('device declarations reuse capture targets and conflicting proposals stop before a run', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n', { bed: 'bench-a', device: 'edge-a' })).code, 0);
  assert.equal((await hook(local, 'COMET synthetic status: ready\n', { bed: 'bench-b', device_id: 'edge-b' })).code, 0);
  const [first, second] = [...hub.uploads.keys()];
  const proposals = join(local.home, 'proposals.json');
  const base = { capture: first, kind: 'observation', path: '/commands/system/show', statement: '核对合成状态', action: '执行合成检查', quote: { line: 1, text: 'ORBIT synthetic status: ready' } };
  const submit = async (item: Record<string, unknown>) => {
    await writeFile(proposals, JSON.stringify({ schema: 'operation-integration@1', session: SESSION, items: [item] }));
    return skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
  };
  assert.equal((await submit({ ...base, device: 'edge-a' })).code, 0);
  assert.equal((await submit({ ...base, capture: second, quote: { line: 1, text: 'COMET synthetic status: ready' } })).code, 0);
  assert.deepEqual(hub.submissions.map(row => row.items[0].slots.contribution[0].data.feeding.device), ['edge-a', 'edge-b']);
  assert.deepEqual(hub.submissions.map(row => row.items[0].slots.contribution[0].data.feeding.bed), ['bench-a', 'bench-b']);
  for (const row of hub.submissions) assert.ok(!('lease' in row.items[0].slots.contribution[0].data.feeding));
  assert.equal((await submit({ ...base, device: 'edge-other' })).code, 1);
  assert.equal((await submit({ ...base, device: null })).code, 1);
  assert.equal((await submit({ ...base, bed: null })).code, 1);
  assert.equal((await submit({ ...base, bed: 'bench-b' })).code, 1);
  assert.equal((await submit({ ...base, bed: ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-') })).code, 1);
  assert.equal((await submit({ ...base, device: 'edge-a', lease: 'lse_client_supplied' })).code, 1);
  assert.equal(hub.runs.length, 2);
  assert.equal(hub.submissions.length, 2);
});

test('equal-byte proposals bind exact capture artifacts instead of the latest timestamp', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT repeated output\n', { device: 'edge-a' })).code, 0);
  assert.equal((await hook(local, 'ORBIT repeated output\n', { device: 'edge-b' })).code, 0);
  const capture = [...hub.uploads.keys()][0]!;
  const proposals = join(local.home, 'proposals.json');
  const base = { capture, kind: 'observation', path: '/commands/system/show', statement: '同字节操作', action: '读取合成输出', quote: { line: 1, text: 'ORBIT repeated output' } };
  await writeFile(proposals, JSON.stringify({ schema: 'operation-integration@1', session: SESSION, items: [base] }));
  const ambiguous = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /capture_identity_required/);
  assert.equal(hub.runs.length, 0);
  const listed = await skill(local, ['list', '--session', SESSION]);
  assert.equal(listed.code, 0, listed.err);
  const captures = JSON.parse(listed.out) as Array<{ upload: { artifact: string } }>;
  assert.equal(captures.length, 2);
  await writeFile(proposals, JSON.stringify({
    schema: 'operation-integration@1', session: SESSION,
    items: captures.map((row, index) => ({ ...base, artifact: row.upload.artifact, device: index === 0 ? 'edge-a' : 'edge-b', action: `读取第 ${index + 1} 次输出` })),
  }));
  const accepted = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
  assert.equal(accepted.code, 0, accepted.err);
  const originals = hub.runs[0].inputs.originals;
  assert.equal(originals.length, 2);
  assert.deepEqual(originals.map((row: any) => row.artifact), captures.map(row => row.upload.artifact));
  assert.equal(new Set(originals.map((row: any) => row.artifact)).size, 2);
  assert.deepEqual(hub.submissions[0].items.map((row: any) => row.slots.contribution[0].data.feeding.device), ['edge-a', 'edge-b']);
});

test('the bare current Hub token is refused as a device or bed before start_run', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const capture = [...hub.uploads.keys()][0]!;
  const proposals = join(local.home, 'proposals.json');
  assert.equal(scanWithMatches(new TextEncoder().encode(TOKEN)).scan.clean, true);
  for (const field of ['device', 'bed']) {
    await writeFile(proposals, JSON.stringify({
      schema: 'operation-integration@1', session: SESSION,
      items: [{ capture, kind: 'observation', path: '/commands/system/show', statement: '当前令牌字段', action: '执行合成检查', [field]: TOKEN, quote: { line: 1, text: 'ORBIT synthetic status: ready' } }],
    }));
    const result = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
    assert.equal(result.code, 1);
    assert.match(result.err, /当前 Hub 令牌|credential_in_target/);
    assert.equal(result.err.includes(TOKEN), false);
  }
  assert.equal(hub.runs.length, 0);
  assert.equal(hub.submissions.length, 0);
  assert.equal(hub.uploads.size, 1);
});

test('a target containing the current token is refused while a case variant is not the same token', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const capture = [...hub.uploads.keys()][0]!;
  const proposals = join(local.home, 'proposals.json');
  const submit = async (device: string) => {
    await writeFile(proposals, JSON.stringify({ schema: 'operation-integration@1', session: SESSION, items: [{ capture, kind: 'observation', path: '/commands/system/show', statement: '令牌片段', action: '执行合成检查', device, quote: { line: 1, text: 'ORBIT synthetic status: ready' } }] }));
    return skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
  };
  for (const device of [`node_${TOKEN}`, `prefix-${TOKEN}-suffix`]) {
    const result = await submit(device);
    assert.equal(result.code, 1);
    assert.match(result.err, /含当前 Hub 令牌|credential_in_target/);
    assert.equal(result.err.includes(TOKEN), false);
  }
  assert.equal(hub.runs.length, 0);
  assert.equal(hub.submissions.length, 0);
  assert.equal((await submit(TOKEN.toUpperCase())).code, 0);
  assert.equal(hub.submissions.length, 1);
});

test('a checked call carries exactly the token its check saw, even when the token rotates between them', async t => {
  const local = await scratch(t);
  const rotated = 'FictCaptureTokenRotated77';
  const hub = await fakeHub(t, { tokens: [TOKEN, rotated] });
  const client = new HubClient(hub.url, local.tokenFile, SESSION);
  let seen = '';
  // The check runs between the token read and the request: the window a rotation used to slip through (round-four review, item 4).
  await client.callChecked('start_run', { pack: 'knowledge-contribution', product: 'ORBIT', inputs: {} }, token => {
    seen = token;
    writeFileSync(local.tokenFile, `${rotated}\n`, { mode: 0o600 });
  });
  assert.equal(seen, TOKEN);
  const sent = hub.requests.filter(row => row.body.method === 'tools/call' && row.body.params.name === 'start_run');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.authorization, `Bearer ${TOKEN}`, 'the request uses the token the check saw, not the one rotated in after it');
});

test('a token rotated after start_run is checked again before submit_result', async t => {
  const local = await scratch(t);
  const rotated = 'edge';
  const hub = await fakeHub(t, {
    tokens: [TOKEN, rotated],
    onRequest: async input => {
      if (input.method === 'tools/call' && input.params.name === 'start_run') await writeFile(local.tokenFile, `${rotated}\n`, { mode: 0o600 });
    },
  });
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const capture = [...hub.uploads.keys()][0]!;
  const proposals = join(local.home, 'proposals.json');
  await writeFile(proposals, JSON.stringify({ schema: 'operation-integration@1', session: SESSION, items: [{ capture, kind: 'observation', path: '/commands/system/show', statement: '轮换令牌', action: '执行合成检查', device: 'edge-a', quote: { line: 1, text: 'ORBIT synthetic status: ready' } }] }));
  const result = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
  assert.equal(await readFile(local.tokenFile, 'utf8'), `${rotated}\n`);
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /含当前 Hub 令牌|credential_in_target/);
  assert.equal(result.err.includes(rotated), false);
  assert.equal(hub.runs.length, 1);
  assert.equal(hub.submissions.length, 0);
});

test('credential-shaped explicit device or bed text is refused before start_run', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const capture = [...hub.uploads.keys()][0]!;
  const target = ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-');
  const proposals = join(local.home, 'proposals.json');
  for (const field of ['device', 'bed']) {
    await writeFile(proposals, JSON.stringify({
      schema: 'operation-integration@1', session: SESSION,
      items: [{ capture, kind: 'observation', path: '/commands/system/show', statement: '设备字段凭据', action: '执行合成检查', [field]: target, quote: { line: 1, text: 'ORBIT synthetic status: ready' } }],
    }));
    const result = await skill(local, ['submit', '--session', SESSION, '--proposals', proposals, '--product', 'ORBIT', '--model', 'integration-synthetic@1']);
    assert.equal(result.code, 1);
    assert.match(result.err, /credential|凭据/);
  }
  assert.equal(hub.runs.length, 0);
  assert.equal(hub.submissions.length, 0);
});
