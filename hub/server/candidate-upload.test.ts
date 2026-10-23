// Private candidate excerpt uploads over the actual MCP transport, reference readers and console HTTP pages.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createTestServer } from './testing.ts';
import { createRunsService } from '../runs/engine/api.ts';
import { sandboxSkip } from '../runs/engine/testing/harness.ts';
import { FakePacks, FakeKnowledge } from '../runs/engine/testing/knowledge.ts';
import { FakeExternal } from '../runs/engine/testing/external.ts';
import { FakeWorkflowStore } from '../runs/engine/testing/workflows.ts';
import { reviewPack, writePack } from '../runs/engine/testing/packs.ts';
import { standardDocument, toyMap } from '../runs/engine/testing/mindmap.ts';
import { createDefaultRegistry } from '../refs/api.ts';
import { createKnowledge } from '../knowledge/api.ts';

let postgres:TemporaryPostgres;
const skip=await sandboxSkip();
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function consoleSession(base:string,token:string):Promise<string>{
  const form=await fetch(`${base}/console/login`),text=await form.text();
  const csrf=/name="csrf" value="([^"]+)"/.exec(text)![1];
  const cookie=form.headers.getSetCookie().find(c=>c.startsWith('circle_hub_login='))!.split(';')[0];
  const reply=await fetch(`${base}/console/login`,{method:'POST',redirect:'manual',headers:{origin:base,cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,token})});
  assert.equal(reply.status,303);
  return reply.headers.getSetCookie().find(c=>c.startsWith('circle_hub_session='))!.split(';')[0];
}

test('candidate upload keeps origin and owner-only access across tools, console and duplicate-byte records',{skip},async t=>{
  const s=await createTestServer({postgres});t.after(()=>s.close());
  const dir=await mkdtemp(join(tmpdir(),'hub-candidate-upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const owner=await s.createUser('synthetic owner'),stranger=await s.createUser('synthetic stranger');
  const client=await s.client(owner.token,{sessionId:'candidate-session'}),admin=await s.client(s.admin.token),other=await s.client(stranger.token);
  t.after(async()=>{await client.close();await admin.close();await other.close();});
  const packs=new FakePacks();await packs.install(dir);
  const workflows=new FakeWorkflowStore(),spec=reviewPack();
  const wf=spec.files['workflow.json'] as {json:Record<string,unknown>};wf.json.product={catalogs:[]};
  const loaded=await workflows.add(await writePack(dir,spec));workflows.assign(owner.user.id,spec.id);
  const external=new FakeExternal(s.records.artifacts),knowledge=new FakeKnowledge();
  const engine=createRunsService({records:s.records,workflows,packs,knowledge,external});
  s.deps.runs=engine;s.deps.runsDetail=engine;
  const text='Synthetic session statement: show state needs no arguments.',name='private-session-name.txt';
  const result=await client.call('upload_file',{file_path:Buffer.from(text).toString('base64'),name,knowledge_layer:'candidate'});
  assert.equal(result.isError,false);const out=result.structuredContent;
  assert.equal(out.knowledge_layer,'candidate');assert.equal(out.structure,undefined);
  assert.deepEqual(out.visibility,{readers:[owner.user.id],admins:false,shareable:false});
  assert.match(JSON.stringify(out.evidence_gaps),/消息 id.*null/);
  assert.match(result.content[0].text!,/候选根据：只本人可见/);assert.match(result.content[0].text!,/缺少消息 id/);
  const [privateRecord]=await s.records.artifacts.records(String(out.sha256));
  assert.deepEqual(privateRecord.body.origin,{upload:{session:'candidate-session',message:null}});
  assert.equal(privateRecord.body.provenance_type,'declared');
  const source=String(out.reference);
  assert.equal((await client.call('get_nodes',{reference:source})).isError,false);
  for(const reader of [other,admin]){
    for(const reference of [source,`rec:${privateRecord.digest}`]){
      const unavailable=await reader.call('get_nodes',{reference});assert.equal(unavailable.isError,true);
      const shown=JSON.stringify(unavailable);assert.ok(!shown.includes(text)&&!shown.includes(name));
    }
  }
  // A real run is needed to exercise the actual resolver's scope, not the server fixture's scripted resolver.
  const normal=await client.call('upload_file',{file_path:Buffer.from(toyMap(standardDocument())).toString('base64'),name:'ordinary-map.json'});
  const started=await client.call('start_run',{pack:loaded.pack.id,inputs:{map:{reference:normal.structuredContent.reference}}});assert.equal(started.isError,false);
  const run=started.structuredContent.run as {run:string;items:Array<{id:string}>};
  for(const reader of [other,admin]){
    const denied=await reader.call('resolve_reference',{run:run.run,text:source});
    assert.deepEqual(denied.structuredContent.references,[]);
    assert.ok(!JSON.stringify(denied).includes(name)&&!JSON.stringify(denied).includes(text));
  }
  const refused=await client.call('start_run',{pack:loaded.pack.id,inputs:{map:{reference:source}}});
  assert.equal(refused.isError,true,'private excerpts cannot be projected into ordinary run records');
  const ownKnowledge=createKnowledge({records:s.records,parsers:createDefaultRegistry(),packs,external});
  const candidate=await ownKnowledge.layers.candidates.add(owner.principal,{statement:'a private synthetic inference',ground:{reference:source,quote:'show state needs no arguments',session_excerpt:true}});
  assert.ok(candidate);assert.equal((await ownKnowledge.layers.candidates.list(owner.principal)).length,1);
  assert.deepEqual(await ownKnowledge.layers.candidates.list(s.admin.principal),[]);
  const cookie=await consoleSession(s.url,s.admin.token);
  for(const path of ['/console/admin/calls?tool=upload_file',`/console/runs/${run.run}`]){
    const page=await fetch(s.url+path,{headers:{cookie}});assert.equal(page.status,200);
    const body=await page.text();assert.ok(!body.includes(text)&&!body.includes(name),'console never exposes private filename or preview');
  }
  const ordinary=await client.call('upload_file',{file_path:Buffer.from(text).toString('base64'),name:'ordinary-name.txt'});
  assert.equal(ordinary.structuredContent.reference,source);
  assert.equal(ordinary.structuredContent.knowledge_layer,undefined);assert.equal(ordinary.structuredContent.evidence_gaps,undefined);
  const records=await s.records.artifacts.records(String(out.sha256));assert.equal(records.length,2);
  assert.equal((await s.records.store.get<typeof privateRecord.body>(privateRecord.digest))!.body.visibility.admins,false);
  assert.equal(await s.records.artifacts.source(s.admin.principal,String(out.sha256),{record:privateRecord.digest}),null);
  assert.equal((await admin.call('get_nodes',{reference:`rec:${privateRecord.digest}`})).isError,true);
  assert.equal((await admin.call('get_nodes',{reference:`rec:${records.find(r=>r.digest!==privateRecord.digest)!.digest}`})).isError,false);
  for(const bad of [{knowledge_layer:'tree'},{knowledge_layer:'observation'},{knowledge_layer:'candidate',message_id:'model-supplied'}])assert.equal((await client.call('upload_file',{file_path:Buffer.from('synthetic').toString('base64'),...bad})).isError,true);
});
