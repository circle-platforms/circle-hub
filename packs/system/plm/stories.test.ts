import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storiesPlan, storiesProject } from './functions/plm.ts';

test('batch stories sorts and deduplicates numeric ids with a fifty-id budget', () => {
  assert.deepEqual(storiesPlan({ external: { type: 'stories', key: '8+2+8' } }), {
    requests: [{ key: 'detail', route: 'story-detail', body: { story_ids: [2, 8] } }], done: true,
  });
  for (const key of ['', '0', '01', '1+x', Array.from({ length: 51 }, (_, i) => i + 1).join('+')]) {
    assert.deepEqual(storiesPlan({ external: { type: 'stories', key } }).requests, []);
  }
  assert.equal(storiesPlan({ external: { type: 'stories', key: Array.from({ length: 50 }, (_, i) => i + 1).join('+') } }).requests.length, 1);
});

test('batch stories preserves status and stage separately and reports missing ids', () => {
  const result = storiesProject({ external: { type: 'stories', key: '2+8+9' }, original: 'detail', responses: {
    detail: { json: { data: [{ id: 2, status: 'synthetic-status', stage: 'synthetic-stage', title: '合成需求' }, { id: '8', stage: 'synthetic-stage' }] } },
  } }) as { artifacts: Array<{ json: unknown }> };
  assert.deepEqual(result.artifacts[0].json, { stories: [
    { id: '2', status: 'synthetic-status', stage: 'synthetic-stage', title: '合成需求' },
    { id: '8', status: null, stage: 'synthetic-stage', title: null },
  ], unread: ['9'] });
  assert.ok('error' in (storiesProject({ external: { type: 'stories', key: '2' }, responses: {} }) as object));
});
