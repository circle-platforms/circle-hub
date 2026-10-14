import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './harness.ts';

test('Registry operation pages: audit facets count only authorized tenant and scope rows before limiting',async t=>{
 const h=await setup(t);
 await h.db.query(`INSERT INTO audit(tenant_id,scope_id,principal_id,action,detail,created_at) VALUES
  ('tnt_lab','scp_lab','synthetic-audit-owner','synthetic.read','{}','2020-01-01T00:00:00.000001Z'),
  ('tnt_lab','scp_second','synthetic-audit-owner','synthetic.read','{}','2020-01-01T00:00:00.000002Z'),
  ('tnt_lab',NULL,'synthetic-audit-owner','synthetic.read','{}','2020-01-01T00:00:00.000003Z'),
  ('tnt_other','scp_lab','synthetic-audit-owner','synthetic.hidden','{}','2020-01-01T00:00:00.000004Z')`);
 const base='/v1/admin/audit?view=page&owner=synthetic-audit-owner&sort=age&order=desc&limit=1';
 const first=await h.request(base,undefined,'admin');assert.equal(first.total,3);assert.equal(first.items.length,1);assert.ok(first.cursor);
 const second=await h.request(base+'&cursor='+encodeURIComponent(first.cursor),undefined,'admin');assert.equal(second.total,3);assert.notEqual(second.items[0].id,first.items[0].id);assert.ok(second.cursor);
 const last=await h.request(base+'&cursor='+encodeURIComponent(second.cursor),undefined,'admin');assert.equal(last.items[0].scopeId,null);assert.equal(last.cursor,null);
 const scoped=await h.request(base+'&scopeId=scp_lab',undefined,'admin');assert.equal(scoped.total,1);assert.equal(scoped.items[0].scopeId,'scp_lab');
 assert.ok(Array.isArray(await h.request('/v1/admin/audit',undefined,'admin')));
 await h.reject('/v1/admin/audit?view=page&limit=101',undefined,'INVALID_PAYLOAD','admin');
 await h.reject('/v1/admin/audit?view=page&productLineId=synthetic',undefined,'INVALID_PAYLOAD','admin');
 await h.reject('/v1/admin/audit?view=page&scopeId=scp_hidden',undefined,'FORBIDDEN_SCOPE','admin');
 await h.setRole('prn_bob','member');await h.reject('/v1/admin/audit?view=page',undefined,'FORBIDDEN_ACTION','bob');
 await h.setRole('prn_bob','admin');await h.reject(base+'&cursor='+encodeURIComponent(first.cursor),undefined,'INVALID_PAYLOAD','bob');
});

test('Registry operation pages: worker scope intersections do not duplicate workers and liveness is a declared facet',async t=>{
 const h=await setup(t,{CIRCLE_SERVER_WORKER_OFFLINE_MS:'60000'});
 for(const name of ['lab-east-01','lab-east-02'])await h.request('/v1/workers/register',{},name);
 await h.db.query("UPDATE workers SET last_seen='2020-01-01T00:00:00.000001Z',draining=false WHERE worker_id='lab-east-01'");
 await h.db.query("UPDATE workers SET draining=true WHERE worker_id='lab-east-02'");
 await h.db.query("INSERT INTO workers(worker_id,principal_id,tenant_id) VALUES('foreign-worker','prn_outsider','tnt_other')");
 const base='/v1/workers?view=page&sort=age&order=desc&limit=1',first=await h.request(base,undefined,'admin');
 assert.equal(first.total,2);assert.equal(first.items[0].workerId,'lab-east-01');assert.equal(first.items[0].offline,true);assert.equal(first.items[0].workerOfflineAfterMs,60000);assert.ok(first.cursor);
 const next=await h.request(base+'&cursor='+encodeURIComponent(first.cursor),undefined,'admin');assert.equal(next.total,2);assert.equal(next.items[0].workerId,'lab-east-02');assert.equal(next.cursor,null);
 const offline=await h.request('/v1/workers?view=page&scopeId=scp_lab&status=offline&owner=prn_lab-east-01',undefined,'admin');assert.equal(offline.total,1);
 const draining=await h.request('/v1/admin/workers?view=page&scopeId=scp_second&status=draining',undefined,'admin');assert.equal(draining.total,1);assert.equal(draining.items[0].workerId,'lab-east-02');
 assert.ok(Array.isArray(await h.request('/v1/workers',undefined,'admin')));
 await h.reject('/v1/workers?view=page&limit=0',undefined,'INVALID_PAYLOAD','admin');
 await h.reject('/v1/workers?view=page&flowVersion=synthetic',undefined,'INVALID_PAYLOAD','admin');
 await h.reject('/v1/workers?view=page&scopeId=scp_hidden',undefined,'FORBIDDEN_SCOPE','admin');
 const compatible=await h.request('/v1/admin/workers?view=page&sort=age&order=desc&limit=1&cursor='+encodeURIComponent(first.cursor),undefined,'admin');assert.equal(compatible.items[0].workerId,next.items[0].workerId);
 await h.reject(base+'&status=offline&cursor='+encodeURIComponent(first.cursor),undefined,'INVALID_PAYLOAD','admin');
 await h.setRole('prn_bob','member');await h.reject('/v1/workers?view=page',undefined,'FORBIDDEN_ACTION','bob');
});

test('Registry operation pages: bot run cursors distinguish repeated occurrences across revisions and preserve owner-only outcomes',async t=>{
 const h=await setup(t),body={scopeId:'scp_lab',kind:'bot',name:'Synthetic run pages',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{productLineId:'synthetic-line'},readers:['*']};
 const bot=await h.request('/v1/assets',body);await h.request('/v1/assets',{...body,assetId:bot.assetId,version:'2.0.0'});
 await h.db.query(`INSERT INTO automation_runs(bot_id,version,occurrence_key,task_id,channel,identity_principal_id,status,occurrence,error,created_at) VALUES
  ($1,'1.0.0','schedule:same',NULL,'circle-events','prn_alice','failed','{}','{"code":"FIRST_REVISION"}','2020-01-01T00:00:00.000001Z'),
  ($1,'2.0.0','schedule:same',NULL,'circle-events','prn_alice','failed','{}','{"code":"SECOND_REVISION"}','2020-01-01T00:00:00.000001Z')`,[bot.assetId]);
 const path=`/v1/automations/bots/${bot.assetId}/runs`,base=path+'?view=page&productLineId=synthetic-line&flowVersion=skill-run%2F1&status=failed&owner=prn_alice&sort=age&order=desc&limit=1';
 const first=await h.request(base);assert.equal(first.total,2);assert.ok(first.cursor);assert.equal(first.items[0].status,'failed');assert.equal(first.items[0].taskId,null);
 const next=await h.request(base+'&cursor='+encodeURIComponent(first.cursor));assert.equal(next.total,2);assert.equal(next.cursor,null);assert.notEqual(next.items[0].error.code,first.items[0].error.code);
 assert.notEqual(first.items[0].recordId,next.items[0].recordId);assert.notEqual(first.items[0].version,next.items[0].version);assert.deepEqual(Object.keys(first.items[0]).sort(),['channel','error','occurrenceKey','published','recordId','status','taskId','trigger','version']);
 assert.equal((await h.request(path)).length,2);
 await h.reject(path+'?view=page&limit=101',undefined,'INVALID_PAYLOAD');await h.reject(path+'?view=page&cursor=bad',undefined,'INVALID_PAYLOAD');
 await h.reject(path+'?view=page&scopeId=scp_hidden',undefined,'FORBIDDEN_SCOPE');
 await h.reject(base,undefined,'SOURCE_FORBIDDEN','bob');await h.reject(base,undefined,'SOURCE_FORBIDDEN','outsider');
 await h.setRole('prn_alice',null);await h.setRole('prn_alice',null,'scp_second');await h.reject(base,undefined,'FORBIDDEN_ACTION');
});
