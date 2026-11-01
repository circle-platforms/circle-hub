// A bug read says which build the bug was found in (decision 111): the detail first, then the one build record its
// openedBuild names, and the name or the reason there is none. Synthetic records only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailPlan, detailProject } from './plm.ts';

const bug = (openedBuild: unknown) => ({ code: 1000, data: [{ id: '910001', title: '合成缺陷', status: 'active', openedBuild }] });
const input = (responses: Record<string, unknown>) => ({ external: { type: 'bug', key: '910001' }, responses, original: 'detail' });
const content = (out: unknown) => (out as { artifacts: Array<{ name: string; json: any }> }).artifacts.find((a) => a.name === 'content')!.json;

test('a bug plans its detail, then the one build record its openedBuild names; a story stays one request', () => {
  assert.deepEqual(detailPlan(input({})), { requests: [{ key: 'detail', route: 'bug-detail', body: { bug_ids: [910001] } }], original: 'detail', done: false });
  assert.deepEqual(detailPlan(input({ detail: { ok: true, json: bug('17401') } })), { requests: [{ key: 'opened', route: 'build-detail', params: { id: '17401' } }], original: 'detail', done: true });
  for (const none of ['trunk', '', '0', null]) assert.deepEqual(detailPlan(input({ detail: { ok: true, json: bug(none) } })).requests, [], String(none));
  assert.deepEqual(detailPlan({ external: { type: 'story', key: '23' }, responses: {} }), { requests: [{ key: 'detail', route: 'story-detail', body: { story_ids: [23] } }], done: true });
});

test('the content gives the opened build by number and name, or why there is no name', () => {
  const named = content(detailProject(input({ detail: { ok: true, json: bug('17401') }, opened: { ok: true, json: { code: 1000, data: { id: 17401, name: 'Synthetic_10_9_0_672' } } } })));
  assert.deepEqual(named.opened_build, { id: '17401', name: 'Synthetic_10_9_0_672' });
  const listed = content(detailProject(input({ detail: { ok: true, json: bug(17401) }, opened: { ok: true, json: [{ id: '17401', name: 'Synthetic_10_9_0_672' }] } })));
  assert.equal(listed.opened_build.name, 'Synthetic_10_9_0_672', 'a bare array answer is read the same way');
  const held = content(detailProject(input({ detail: { ok: true, json: bug('17401') }, opened: { ok: false, error: { code: 'SOURCE_CREDENTIAL', message: '应答对你不可用（原因只记在管理员记录里）' } } })));
  assert.equal(held.opened_build.name, null);
  // A held build record is a credential class: the reader is told only that it is not available (D05 R[3], decision 112).
  assert.match(held.opened_build.note, /构建 17401 的记录没读到：应答对你不可用/);
  assert.doesNotMatch(held.opened_build.note, /凭据/);
  assert.equal(held.fields.status, 'active', 'the bug itself is read whatever happened to the build record');
  const nameless = content(detailProject(input({ detail: { ok: true, json: bug('17401') }, opened: { ok: true, json: { code: 1000, data: { id: 17401 } } } })));
  assert.deepEqual(nameless.opened_build, { id: '17401', name: null, note: '构建 17401 的记录里没有名字' });
  const trunk = content(detailProject(input({ detail: { ok: true, json: bug('trunk') } })));
  assert.deepEqual(trunk.opened_build, { id: 'trunk', name: null, note: '缺陷记录的 openedBuild 不是构建编号，没有对应的构建记录可读' });
});
