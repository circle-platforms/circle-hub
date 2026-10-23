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
    { id: '2', status: 'synthetic-status', stage: 'synthetic-stage', title: '合成需求', fields_absent: [] },
    { id: '8', status: null, stage: 'synthetic-stage', title: null, fields_absent: ['status'] },
  ], unread: ['9'] });
  assert.ok('error' in (storiesProject({ external: { type: 'stories', key: '2' }, responses: {} }) as object));
});

test('build story scope reads only the administrator configured top-level array', async () => {
  const { buildsProject } = await import('./functions/plm.ts');
  const response = { external: { type: 'builds', key: '5' }, original: 'builds', responses: { builds: { json: [{ id: 6, synthetic_links: [21, '00022', 21] }, { id: 7 }] } } };
  const configured = buildsProject({ ...response, settings: { build_story_field: 'synthetic_links' } }) as any;
  assert.deepEqual(configured.artifacts[0].json.builds[0].stories, ['21', '22']);
  assert.equal(configured.artifacts[0].json.builds[0].scope_note, '需求范围取自构建记录');
  assert.match(configured.artifacts[0].json.builds[1].scope_note, /synthetic_links/);
  const absent = buildsProject(response) as any;
  assert.equal(absent.artifacts[0].json.builds[0].stories, null);
  assert.match(absent.artifacts[0].json.builds[0].scope_note, /settings.build_story_field/);
});
