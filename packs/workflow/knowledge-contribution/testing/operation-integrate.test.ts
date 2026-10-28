import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Submission } from '../../../../contracts/src/submission.ts';
import { ContributionInput } from '../../../../contracts/src/contributions.ts';
import { KnowledgeStructureSchema } from '../../../../contracts/src/feeding.ts';
import { SESSION, ROOT, PACK_DIGEST, scratch, fakeHub, enable, hook, skill } from './operation-support.ts';

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
