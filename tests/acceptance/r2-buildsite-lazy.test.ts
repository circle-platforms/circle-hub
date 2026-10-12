import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {executeTool} from '../../packages/connectors/src/tool-packages.ts';
import {BuildSite} from '../../packages/connectors/src/build-site.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {SourceCache} from '../../packages/connectors/src/source-cache.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

test('Build publication listing downloads no XML or fixed lists and commands use one persistent SHA cache',async t=>{
  const stub=await readonlySources(t);stub.state.expandedCommands=true;const directory=await mkdtemp(`${tmpdir()}/circle-source-cache-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  const profile={origin:stub.origin,index:'/builds/',requestConcurrency:2,requestIntervalMs:0},options={cache:new SourceCache(directory),cacheNamespace:'synthetic-actor-version'};
  const versions=await executeTool('build-site','build.versions',{versionLine:'10.5'},profile,undefined,options);assert.equal(versions.result.builds.length,4);
  assert.equal(stub.requests.filter(r=>r.path.includes('command_tree-')).length,0);assert.equal(stub.requests.filter(r=>r.path.includes('Bugs_Fixed_with_')).length,0);
  const build='Rel_PHOTON_10_5_0_101';
  const heads=await executeTool('build-site','build.heads',{build,prefix:'service'},profile,undefined,options);assert.ok(heads.result.heads.length>30);
  const parameters=await executeTool('build-site','build.parameters',{build,head:'service create port'},profile,undefined,{...options,cache:new SourceCache(directory)});assert.equal(parameters.result.parameters[0].type,'U16');
  const checked=await executeTool('build-site','build.check',{build,commands:['service create port 443']},profile,undefined,options);assert.equal(checked.result.commands[0].status,'hit');assert.equal(checked.result.sourceSha256,heads.result.sourceSha256);
  assert.equal(stub.requests.filter(r=>r.path.includes('command_tree-')).length,1);assert.equal(stub.requests.filter(r=>r.path.includes('Bugs_Fixed_with_')).length,0);
  const other=await executeTool('build-site','build.check',{build:'Rel_PHOTON_10_5_0_109',commands:['feature.enable']},profile,undefined,options);assert.equal(other.result.commands[0].status,'missing');assert.equal(stub.requests.filter(r=>r.path.includes('command_tree-')).length,2);
  const fixed=await executeTool('build-site','build.fixed',{legacyIssueId:'401',builds:[build,'Rel_PHOTON_10_5_0_109']},profile,undefined,options);assert.equal(fixed.result.earliestFormal.name,build);assert.equal(fixed.result.all.length,2);assert.equal(stub.requests.filter(r=>r.path.includes('Bugs_Fixed_with_')).length,2);
  stub.state.changedBuild=build;await executeTool('build-site','build.tree',{build},profile,undefined,options);assert.equal(stub.requests.filter(r=>r.path.includes('command_tree-')).length,3);
});

test('Build sync is metadata only and release matching fetches only selected fixed lists with bounded rates',async t=>{
  const stub=await readonlySources(t),source=new HttpSource(stub.origin,{requestConcurrency:2,requestIntervalMs:20}),site=new BuildSite(source);
  const line=(await site.index('/builds/')).lines[0],synced=await site.sync(line.path,{}, {versionLine:line.versionLine});assert.equal(synced.items.length,4);
  assert.equal(stub.requests.filter(r=>r.path.includes('command_tree-')).length,0);assert.equal(stub.requests.filter(r=>r.path.includes('Bugs_Fixed_with_')).length,0);
  const selected=synced.items.filter(build=>build.formal);const result=await site.releasesFor('401',selected);assert.equal(result.earliestFormal.name,'Rel_PHOTON_10_5_0_101');assert.equal(result.all.length,2);
  assert.equal(stub.requests.filter(r=>r.path.includes('Bugs_Fixed_with_')).length,2);assert.equal(stub.requests.filter(r=>r.path.includes('command_tree-')).length,0);
  const count=stub.requests.length;assert.equal((await site.releasesFor('',selected)).status,'unknown');assert.equal(stub.requests.length,count);
  const beta=await site.releasesFor('499',synced.items.filter(build=>build.name.startsWith('Beta_')));assert.equal(beta.status,'beta-only');
});

test('Source fetch slots limit concurrency to two and separate request starts',async t=>{
  let active=0,maximum=0;const starts:number[]=[];const server=createServer(async(req,res)=>{active++;maximum=Math.max(maximum,active);starts.push(performance.now());await delay(60);active--;res.end('synthetic');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const source=new HttpSource(`http://127.0.0.1:${(server.address() as {port:number}).port}`,{requestConcurrency:2,requestIntervalMs:20});
  await Promise.all(Array.from({length:5},(_,index)=>source.read(`/synthetic/${index}`)));assert.equal(maximum,2);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=15,`Requests started too close: ${starts[i]-starts[i-1]}`);
});
