import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {executeTool} from '../../packages/connectors/src/tool-packages.ts';
import {SourceCache} from '../../packages/connectors/src/source-cache.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {documentTree} from '../fixtures/document-tree.ts';
import {setup,until} from './harness.ts';

test('Document search: configured version directories recurse within bounds and unchanged etags reuse originals across restarts',async t=>{
  const fixture=await documentTree(t),directory=await mkdtemp(`${tmpdir()}/circle-hub-document-search-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  const profile:any={origin:fixture.origin,root:'/webdav/',documents:fixture.policy},call=(args:any)=>executeTool('documents','document.search',args,profile,undefined,{cache:new SourceCache(directory),cacheNamespace:'owner-one'});
  const first=await call({query:'http',version:'10.8'});assert.equal(first.result.hits.length,2);assert.ok(first.result.hits.every((hit:any)=>hit.line===3));assert.ok(!fixture.requests.some(req=>req.path==='/webdav/'||req.path==='/webdav/cli/'));
  const count=fixture.requests.filter(req=>req.method==='GET').length,again=await call({query:'http',path:'/webdav/cli/rel_photon_10_8/'});assert.deepEqual(again.result.hits,first.result.hits);assert.equal(fixture.requests.filter(req=>req.method==='GET').length,count);assert.ok(again.raw.every(raw=>sha256(raw.bytes)===raw.sha256));
  fixture.state.revision=2;const changed=await call({query:'http',version:'10.8'});assert.notEqual(changed.result.hits[0].sourceSha256,first.result.hits[0].sourceSha256);assert.equal(fixture.requests.filter(req=>req.method==='GET').length,count+2);
  fixture.requests.length=0;fixture.state.count=101;const paged=await call({query:'http',path:'/webdav/cli/rel_photon_10_8/manuals/'});assert.equal(paged.result.hits.length,20);assert.ok(paged.result.nextCursor);assert.ok(fixture.requests.filter(req=>req.method==='GET').length<=20,'Download only one bounded search page');
  fixture.state.count=2;fixture.state.deep=true;await assert.rejects(executeTool('documents','document.search',{query:'http',path:'/webdav/cli/rel_photon_10_8/'},{...profile,documents:{...fixture.policy,maxDepth:1}}),(error:any)=>error.code==='RESULT_TOO_LARGE'&&error.details.bound==='depth');
});

test('Document search: manifest directory policy reaches worker search and asynchronous product full text without reading the whole site',async t=>{
  const fixture=await documentTree(t),directory=await mkdtemp(`${tmpdir()}/circle-hub-document-policy-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(`${directory}/product-line.json`,JSON.stringify({schemaVersion:'product-line/1',id:'fixture',version:'1.0.0',connectorPackages:[{packageId:'documents',alias:'fixture_docs'}],connectorOptions:{documents:{documents:fixture.policy}},skills:[]}));await writeFile(`${directory}/installed.json`,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:['product-line.json']}));
  const h=await setup(t,{CIRCLE_HUB_PRODUCT_LINES:`${directory}/installed.json`});await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_alice'");await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_admin'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin:fixture.origin,root:'/webdav/'}}}));h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;await h.stop();await h.startServer();
  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic versioned manuals',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',productLineId:'fixture',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_admin']});await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'admin');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});await h.startWorker();
  const found=await h.request('/v1/tools/fixture_docs.search/call',{args:{query:'http',version:'10.8'},idempotencyKey:'versioned-document-search'});assert.equal(found.result.hits.length,2);assert.ok(found.evidence.length>2);
  await until(async()=>{const jobs=(await h.db.query('SELECT status,error FROM knowledge_projection_jobs')).rows;assert.ok(!jobs.some(job=>job.status==='failed'),JSON.stringify(jobs));return jobs.length&&jobs.every(job=>job.status==='succeeded');});assert.equal((await h.request('/v1/knowledge/search?mode=fulltext&q=HTTP')).items.length,2);await h.reject('/v1/tools/fixture_docs.search/call',{args:{query:'http',version:'10.8'},idempotencyKey:'forbidden-doc-search'},'SOURCE_FORBIDDEN','bob');
});
