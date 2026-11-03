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
    { id: '2', status: 'synthetic-status', stage: 'synthetic-stage', title: '合成需求', fields_absent: [], fields_nonscalar: [] },
    { id: '8', status: null, stage: 'synthetic-stage', title: null, fields_absent: ['status'], fields_nonscalar: [] },
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

test('one non-scalar field never hides the batch and is marked apart from null and absence', () => {
  const result = storiesProject({ external: { type: 'stories', key: '21+22+23' }, original: 'detail', responses: {
    detail: { json: { code: 1000, data: [{ id: 21, status: { raw: 'synthetic' }, stage: ['synthetic'] }, { id: 22, status: null, stage: null }, { id: 23 }] } },
  } }) as any;
  assert.equal(result.error, undefined);
  const content = result.artifacts.find((artifact: any) => artifact.name === 'content').json;
  assert.equal(content.stories.length, 3); assert.deepEqual(content.unread, []);
  assert.deepEqual(content.stories[0].fields_nonscalar, ['status', 'stage']);
  assert.deepEqual(content.stories[0].fields_absent, []);
  assert.deepEqual(content.stories[1].fields_nonscalar, []);
  assert.deepEqual(content.stories[2].fields_absent, ['status', 'stage']);
});

test('real PLM projection feeds workflow non-scalar counts without hand-written markers', async () => {
  const { default: project } = await import('../../workflow/story-traceability/functions/project.ts');
  const { default: counts } = await import('../../workflow/story-traceability/functions/counts.ts');
  const { boundView, indexViewOf } = await import('../../workflow/traceability/functions/test-support.ts');
  const output=storiesProject({external:{type:'stories',key:'21+22'},original:'detail',responses:{detail:{json:{code:1000,data:[{id:21,status:{value:'synthetic'},stage:['synthetic']},{id:22,status:null,stage:null}]}}}}) as {artifacts:Array<{json:unknown}>};
  assert.ok(output.artifacts,'a non-scalar field must not discard the batch');
  const projected=project({inputs:[boundView('stories',output.artifacts[0].json as Record<string,unknown>,'plm:stories:21+22'),boundView('cases',{...indexViewOf('case','stories',[]),key_space_complete:true})]}) as any;
  assert.ok(!projected.error,JSON.stringify(projected.error));
  const [total]=counts({subject:{items:projected.items,context:{groups:projected.groups}}});
  assert.equal(total.data?.status_nonscalar,1);assert.equal(total.data?.stage_nonscalar,1);
  assert.deepEqual(total.data?.statuses,[{status:null,count:1}]);
});

test('the signed stories contract documents every observed field category without inventing unknowns', async()=>{
  const {readFile}=await import('node:fs/promises');
  const system=JSON.parse(await readFile(new URL('./system.json',import.meta.url),'utf8'));
  const description=system.reads.find((profile:{external:string})=>profile.external==='plm:stories').description as string;
  const output=storiesProject({external:{type:'stories',key:'21+22+23'},original:'detail',responses:{detail:{json:{data:[{id:21,status:{text:'synthetic'},stage:null},{id:22}]}}}}) as {artifacts:Array<{json:{stories:Array<Record<string,unknown>>;unread:string[]}}>};
  assert.deepEqual(output.artifacts[0].json.unread,['23']);
  for(const field of ['fields_nonscalar','fields_absent','unread'])assert.ok(description.includes(field),field+' must be documented');
  assert.match(description,/标量/);assert.match(description,/原件/);assert.doesNotMatch(description,/列为未知/);
});
