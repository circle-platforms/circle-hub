import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildsProject } from './plm.ts';
import project from '../../../workflow/story-traceability/functions/project.ts';
import { boundView, indexViewOf } from '../../../workflow/traceability/functions/test-support.ts';
function content(stories: unknown[]) {
  const name = (indexViewOf('case', 'stories', []).build as { build: string }).build;
  const raw = { id: 7, name, links: stories };
  const result = buildsProject({ external: { type: 'builds', key: '5' }, settings: { build_story_field: 'links' }, original: 'builds', responses: { builds: { ok: true, json: [raw] } } }) as any;
  return { model: result.artifacts[0].json, raw };
}
test('build story ids normalize the trimmed text before leading-zero removal, sorting and deduplication', () => {
  const values = [' 21 ', '\t00022\n', '00021\u00a0', 22];
  const original = structuredClone(values);
  const result = content(values);
  assert.deepEqual(result.model.builds[0].stories, ['21', '22']);
  assert.deepEqual(result.raw.links, original);
  assert.deepEqual(values, original);
});
test('normalized projected scope starts the story workflow without a generic content-conflict refusal', () => {
  const { model } = content([' 21', '00022 ']);
  const result = project({ inputs: [boundView('build', model, 'plm:builds:5'), boundView('cases', { ...indexViewOf('case', 'stories', []), key_space_complete: true })], parameters: { build_id: '007' } }) as any;
  assert.ok(!result.error, JSON.stringify(result));
  assert.deepEqual(result.items.map((row: any) => row.id), ['21', '22']);
});
test('trimming does not make zero or non-integer ids valid', () => {
  for (const values of [[' 000 '], [' 21.0 '], ['  ']]) assert.equal(content(values).model.builds[0].stories, null);
});
