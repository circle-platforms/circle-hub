import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import { createTestServer } from './testing.ts';

test('the MCP contract permits same-session model omission and requires a declaration in another session', async t => {
  const postgres=await startPostgres();t.after(()=>postgres.stop());
  const hub=await createTestServer({postgres});t.after(()=>hub.close());
  const person=await hub.createUser('synthetic-reader');await hub.assign(person.principal,'review');
  const first=await hub.client(person.token,{sessionId:'synthetic-first'});t.after(()=>first.close());
  const second=await hub.client(person.token,{sessionId:'synthetic-second'});t.after(()=>second.close());
  const tools=await first.listTools(),submit=tools.tools.find(tool=>tool.name==='submit_result')!;
  assert.ok(!((submit.inputSchema as {required?:string[]}).required??[]).includes('model'));
  const uploaded=await first.call('upload_file',{file_path:Buffer.from('synthetic source').toString('base64'),media_type:'text/plain'});
  const start=await first.call('start_run',{pack:'review',model_identity:{model_id:'synthetic-model',model_family_id:'synthetic-family'},inputs:{subject:{reference:uploaded.structuredContent.reference}}});
  assert.equal(start.isError,false,JSON.stringify(start.structuredContent));
  assert.match(start.content[0].text??'',/同一开始会话提交可省略 model 和 model_identity/);
  const run=(start.structuredContent.run as {run:string}).run,input={run,items:[]};
  const same=await first.call('submit_result',input);assert.equal(same.structuredContent.acceptance,'accepted',JSON.stringify(same.structuredContent));
  const other=await second.call('submit_result',input);assert.equal(other.structuredContent.acceptance,'not_accepted');
  assert.ok((other.structuredContent.errors as {path?:string}[]).some(error=>error.path==='/model_identity'));
  const again=await first.call('submit_result',input);assert.equal(again.structuredContent.acceptance,'accepted');
  const explicit=await second.call('submit_result',{...input,model_identity:{model_id:'synthetic-other',model_family_id:'synthetic-other-family'}});
  assert.equal(explicit.structuredContent.acceptance,'accepted',JSON.stringify(explicit.structuredContent));
});
