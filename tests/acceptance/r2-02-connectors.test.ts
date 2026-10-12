import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from '../../packages/contracts/src/index.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {Documents} from '../../packages/connectors/src/documents.ts';
import {BuildSite} from '../../packages/connectors/src/build-site.ts';
import {QueryMirror} from '../../packages/connectors/src/query-mirror.ts';
import {EnvironmentView} from '../../packages/connectors/src/environment-view.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

test('Act R2.2: document listing incrementals and raw-byte SHA survive a changed revision',async t=>{
  const stub=await readonlySources(t),docs=new Documents(new HttpSource(stub.origin));
  const first=await docs.sync('/dav/');assert.equal(first.items.length,1);
  assert.equal(first.items[0].evidence.sha256,sha256('Synthetic manual 1'));
  assert.equal(first.evidence[0].sha256,sha256(first.evidence[0].bytes));
  const same=await docs.sync('/dav/',first.cursor);assert.equal(same.items.length,0);
  stub.state.revision=2;const changed=await docs.sync('/dav/',same.cursor);
  assert.equal(changed.items.length,1);assert.equal(changed.items[0].evidence.sha256,sha256('Synthetic manual 2'));
});

test('Act R2.2: source failures are classified and only confirmed absence is cached',async t=>{
  const stub=await readonlySources(t),source=new HttpSource(stub.origin,{absenceTtlMs:10_000});
  for(const [mode,code] of [['expired','SOURCE_LOGIN_EXPIRED'],['forbidden','SOURCE_FORBIDDEN'],['unreachable','SOURCE_UNREACHABLE'],['absent','SOURCE_ABSENT']]){
    stub.state.mode=mode;
    await assert.rejects(source.read(`/failure/${mode}`),(error:any)=>error.code===code);
    const count=stub.requests.length;stub.state.mode='ready';
    if(mode==='absent'){await assert.rejects(source.read(`/failure/${mode}`),(error:any)=>error.code===code);assert.equal(stub.requests.length,count);}
    else{assert.equal((await source.read(`/failure/${mode}`)).bytes.toString(),'recovered');assert.equal(stub.requests.length,count+1);}
  }
  await assert.rejects(new HttpSource(stub.origin,{timeoutMs:100}).read('http://example.invalid/escape'),(error:any)=>error.code==='INVALID_PAYLOAD');
});

test('Act R2.2: publication HTML and XML preserve release/platform dimensions and command evidence',async t=>{
  const stub=await readonlySources(t),site=new BuildSite(new HttpSource(stub.origin));
  const index=await site.index('/builds/');assert.equal(index.lines[0].title,'PHOTON 10.5 builds');
  assert.equal(index.platforms[0].platform,'kvm');
  const synced=await site.sync(index.lines[0].path);assert.equal(synced.items.length,3);
  assert.equal(synced.items[0].commands[0].name,'feature.enable');assert.equal(synced.items[0].commands[0].arguments[0].name,'mode');
  assert.equal(site.matches(synced.items,'401').earliestFormal.name,'Rel_PHOTON_10_5_0_101');
  assert.equal(site.matches(synced.items,'401').all.length,2);assert.equal(site.matches(synced.items,'').status,'unknown');
  assert.equal(site.matches(synced.items,'499').status,'beta-only');
  const recommended=site.forCommand(synced.items,'feature.enable');assert.equal(recommended.latestFormal.name,'Rel_PHOTON_10_5_0_109');
  assert.equal(recommended.proves,'command-presence');
  assert.equal((await site.sync(index.lines[0].path,synced.cursor)).items.length,0);
  assert.ok(!stub.requests.some(r=>r.path.startsWith('/legacy/')));
  assert.ok(synced.evidence.every(e=>e.sha256===sha256(e.bytes)));
  await assert.rejects(site.commandsFrom(Buffer.from('<!DOCTYPE x [<!ENTITY evil SYSTEM "file:///etc/passwd">]><commands>&evil;</commands>')),(e:any)=>e.code==='INVALID_PAYLOAD');
});

test('Act R2.2: mirror uses raw authorization and normalizes mixed numeric dates and sentinel accounts',async t=>{
  const stub=await readonlySources(t),mirror=new QueryMirror(new HttpSource(stub.origin,{authorization:()=>stub.secret}));
  const first=await mirror.sync({product:7});assert.equal(first.items.length,1);
  const bug=first.items[0];assert.equal(bug.id,'51');assert.equal(bug.severity.label,'严重');assert.equal(bug.priority.label,'正常');
  assert.equal(bug.openedDate,'2026-01-01T00:00:00.000Z');assert.equal(bug.resolvedDate,null);assert.equal(bug.assignedPerson,null);
  assert.equal(bug.assignedState,'closed');assert.equal(bug.resolution.mapped,'fixed');
  assert.equal((await mirror.sync({product:7},first.cursor)).items.length,0);
  stub.state.revision=2;assert.equal((await mirror.sync({product:7},first.cursor)).items.length,1);
  const unknown=await mirror.detail([52]);assert.ok(unknown.items[0].unmapped.some((x:any)=>x.field==='resolution'));
  assert.equal((await mirror.build('99')).result.bugIds.length,2);
  const before=stub.requests.length;await assert.rejects(mirror.detail(Array.from({length:101},(_,i)=>i)),(e:any)=>e.code==='INVALID_PAYLOAD');assert.equal(stub.requests.length,before);
  assert.ok(stub.requests.filter(r=>r.path.startsWith('/plmquery/')).every(r=>r.authorization===stub.secret));
  await assert.rejects(new QueryMirror(new HttpSource(stub.origin,{authorization:()=>stub.secret+'-expired'})).products(),(e:any)=>e.code==='SOURCE_LOGIN_EXPIRED');
  assert.ok(first.evidence.every(e=>e.sha256===sha256(e.bytes)));
  assert.ok(stub.requests.some(r=>r.path.includes('lastEditedDate_start=')));
});

test('Act R2.2: environment viewing crosses the synthetic jump transport with an enforced read allowlist',async t=>{
  const stub=await readonlySources(t),env=new EnvironmentView(new HttpSource(stub.origin));
  const first=await env.sync();assert.equal(first.items[0].id,'lab-a');assert.equal((await env.sync(first.cursor)).items.length,0);
  stub.state.revision=2;assert.equal((await env.sync(first.cursor)).items.length,1);
  assert.equal((await env.call('device.status',{deviceId:'node-a'})).result.state,'ready');
  assert.equal((await env.call('environment.topology',{environmentId:'lab-a'})).result.nodes.length,2);
  assert.equal((await env.call('framework.get',{path:'checks/sample.ts'})).evidence.sha256.length,64);
  const count=stub.requests.length;
  for(const command of ['device.configure','reboot','rm -rf /','framework.execute'])await assert.rejects(env.call(command,{}),(e:any)=>e.code==='FORBIDDEN_ACTION');
  assert.equal(stub.requests.length,count);assert.ok(stub.requests.every(r=>r.method==='POST'&&r.path==='/jump/view'));
});
