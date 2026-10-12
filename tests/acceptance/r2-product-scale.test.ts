import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setup,until} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

test('Act R2.3 scale: two 2000-command builds keep tool reads below one second while durable indexing completes asynchronously',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.expandedCommands=true;stub.state.headCount=2000;
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"builds.read\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin:stub.origin,index:'/builds/',requestIntervalMs:0}}}),{mode:0o600});h.env.CIRCLE_SERVER_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;h.env.CIRCLE_SERVER_INDEX_POLL_MS='60000';await h.stop();await h.startServer();
  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic large command source',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'build-site',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});const worker=await h.startWorker();
  const token=await h.login(),elapsed:number[]=[];
  for(const [name,args] of [
    ['buildsite.command_check',{build:'Rel_PHOTON_10_5_0_101',commands:['feature.enable']}],
    ['buildsite.command_check',{build:'Rel_PHOTON_10_5_0_109',commands:['feature.enable']}],
    ['buildsite.command_check',{build:'Rel_PHOTON_10_5_0_101',commands:['feature.enable']}],
    ['buildsite.versions',{versionLine:'10.5'}],
  ] as const){
    const start=performance.now(),response=await fetch(`${h.url}/v1/tools/${name}/call`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({args,idempotencyKey:randomBytes(12).toString('hex')})});assert.equal(response.status,200,JSON.stringify(await response.clone().json()));await response.json();elapsed.push(performance.now()-start);
    assert.ok(elapsed.at(-1)!<1000,`Read ${name} took ${elapsed.at(-1)!.toFixed(0)}ms; projection must not run in its receipt transaction`);
  }
  const p95=[...elapsed].sort((a,b)=>a-b)[Math.ceil(elapsed.length*0.95)-1];assert.ok(p95<1000);t.diagnostic(`Four-read p95 ${p95.toFixed(0)}ms`);
  assert.equal(Number((await h.db.query("SELECT count(*) AS n FROM knowledge_records WHERE kind='Claim'")).rows[0].n),0,'Reads must finish before projection starts');
  await h.stop(worker);await h.stop(h.server,'SIGKILL');h.env.CIRCLE_SERVER_INDEX_POLL_MS='30';await h.startServer();await h.startWorker();
  await until(async()=>(await h.db.query("SELECT 1 FROM knowledge_projection_jobs WHERE status='running'")).rowCount!>0);
  const active:number[]=[];
  for(let index=0;index<4;index++){
    const start=performance.now(),response=await fetch(`${h.url}/v1/tools/buildsite.versions/call`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({args:{versionLine:'10.5'},idempotencyKey:`during-indexing-${index}`})});assert.equal(response.status,200);await response.json();active.push(performance.now()-start);
  }
  assert.ok(Math.max(...active)<1000,`Reads during indexing took ${active.map(value=>value.toFixed(0)).join('/')}ms`);t.diagnostic(`Reads with indexing active: ${active.map(value=>value.toFixed(0)).join('/')}ms`);
  await until(async()=>{const jobs=(await h.db.query('SELECT status FROM knowledge_projection_jobs')).rows;return jobs.length>0&&jobs.every(job=>job.status==='succeeded');},30_000);
  const count=Number((await h.db.query("SELECT count(*) AS n FROM knowledge_records WHERE kind='Claim' AND payload->>'predicate'='command-definition'")).rows[0].n);assert.ok(count>=4000,`Only ${count} command statements were indexed`);
  const found=await h.request('/v1/knowledge/search?mode=exact&q=command:Rel_PHOTON_10_5_0_101:service%20create%20port');assert.equal(found.items.length,1);assert.equal(found.items[0].knowledgeCategory,'product');
  const tasks=await h.request('/v1/tasks?limit=100'),indexing=tasks.filter((task:any)=>task.capabilityPackId==='asset-index');assert.ok(indexing.length>0);
  for(const task of indexing){const events=(await h.request(`/v1/tasks/${task.taskId}/events?after=0`)).events;assert.ok(events.some((event:any)=>event.kind==='knowledge.indexing.completed'));}
  const before=Number((await h.db.query('SELECT count(*) AS n FROM knowledge_projection_jobs')).rows[0].n);await h.stop();await h.startServer();assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM knowledge_projection_jobs')).rows[0].n),before);
});

test('Act R2.3 scale: a failed later projection batch cannot enter another job snapshot',async t=>{
  const stub=await readonlySources(t),h=await setup(t);stub.state.expandedCommands=true;stub.state.headCount=400;stub.state.badCommandIndex=300;
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"builds.read\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin:stub.origin,index:'/builds/',root:'/dav/',requestIntervalMs:0}}}),{mode:0o600});h.env.CIRCLE_SERVER_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;await h.stop();await h.startServer();
  for(const packageId of ['build-site','documents']){const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic staged source',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId,runtimeProfileRef:'fixture'},readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});}
  await h.startWorker();await h.request('/v1/tools/buildsite.command_check/call',{args:{build:'Rel_PHOTON_10_5_0_101',commands:['feature.enable']},idempotencyKey:'later-batch-failure'});
  const failed=await until(async()=>{const job=(await h.db.query("SELECT * FROM knowledge_projection_jobs WHERE status='failed'")).rows[0];return job;});assert.ok(failed.progress>=200);
  assert.ok(Number((await h.db.query('SELECT count(*) AS n FROM knowledge_projection_members WHERE job_id=$1',[failed.job_id])).rows[0].n)>0);
  await h.request('/v1/tools/docs.get/call',{args:{file:'/dav/manual.txt'},idempotencyKey:'publish-independent-document'});await until(async()=>(await h.db.query("SELECT 1 FROM knowledge_projection_jobs WHERE status='succeeded'")).rowCount!>0);
  assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=command:Rel_PHOTON_10_5_0_101:service%20create%20port')).items.length,0);assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=/dav/manual.txt')).items.length,1);
  const result=await h.request(`/v1/tasks/${failed.task_id}/result`);assert.equal(result.phase,'failed');assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM knowledge_active_statements WHERE claim_id=ANY(SELECT claim_id FROM knowledge_projection_members WHERE job_id=$1)',[failed.job_id])).rows[0].n),0);
});
