import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storiesProject } from './plm.ts';
test('story projection preserves scalar status and stage and records absent fields without inventing values', () => {
  const result = storiesProject({ external: { type: 'stories', key: '21+22+23' }, original: 'detail', responses: { detail: { json: { code: 1000, data: [{ id: 21, stage: 0 }, { id: '22', status: 4, stage: false }, { id: 23, status: null, stage: 'synthetic' }] } } } }) as any;
  assert.deepEqual(result.artifacts[0].json.stories, [
    { id: '21', status: null, stage: 0, title: null, fields_absent: ['status'], fields_nonscalar: [] },
    { id: '22', status: 4, stage: false, title: null, fields_absent: [], fields_nonscalar: [] },
    { id: '23', status: null, stage: 'synthetic', title: null, fields_absent: [], fields_nonscalar: [] },
  ]);
});
