import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildsProject } from './plm.ts';

test('build content preserves the original name and all JSON scalar fields alongside normalized scope', () => {
  const record = { id: 7, name: '  Synthetic_10_7_A  ', released: false, sequence: 0, note: null, marker: 'raw', nested: { ignore: true }, links: [21] };
  const original = structuredClone(record);
  const result = buildsProject({ external: { type: 'builds', key: '5' }, original: 'builds', settings: { build_story_field: 'links' }, responses: { builds: { ok: true, json: [record] } } }) as { artifacts: Array<{ json: { builds: Array<Record<string, unknown>> } }> };
  const held = result.artifacts[0].json.builds[0];
  assert.equal(held.name, original.name);
  assert.deepEqual(held.fields, { id: 7, name: original.name, released: false, sequence: 0, note: null, marker: 'raw' });
  assert.deepEqual(held.stories, ['21']);
  assert.deepEqual(record, original);
});
