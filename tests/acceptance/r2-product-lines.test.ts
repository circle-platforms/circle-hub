import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

test('Act R2.7: runtime manifests install a new product line and select its tool aliases without source edits',async t=>{
  const directory=await mkdtemp(`${tmpdir()}/circle-hub-product-lines-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(`${directory}/third`);
  await writeFile(`${directory}/third/product-line.json`,JSON.stringify({schemaVersion:'product-line/1',id:'third',version:'1.0.0',synthetic:true,connectorPackages:[{packageId:'documents',alias:'third_docs'}],skills:[],knowledgeMappings:{authority:'Pinned synthetic document bytes'}}));
  const first=fileURLToPath(new URL('../../packs/apv/product-line.json',import.meta.url)),second=fileURLToPath(new URL('../../packs/meridian/product-line.json',import.meta.url)),config=`${directory}/installed.json`;
  await writeFile(config,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:[first,second,'third/product-line.json']}));
  const stub=await readonlySources(t),h=await setup(t,{CIRCLE_HUB_PRODUCT_LINES:config});
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_admin'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{synthetic:{origin:stub.origin,root:'/dav/'}}}));h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;await h.stop();await h.startServer();
  const register=async(packageId:string,productLineId?:string,alias?:string)=>{
    const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic manifest binding',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId,productLineId,alias,runtimeProfileRef:'synthetic'},readers:['prn_alice','prn_admin']});
    await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'admin');
    await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});return asset;
  };
  const third=await register('documents','third');await register('documents','meridian');await register('query-mirror');
  await register('documents','third','third_docs_second');
  const names=(await h.request('/v1/tools')).map((tool:any)=>tool.name);
  for(const name of ['third_docs.get','third_docs_second.get','meridian_docs.get','zentao.bug_detail'])assert.ok(names.includes(name),`${name} missing from ${names}`);
  await h.reject('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Uninstalled product',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{packageId:'documents',productLineId:'not-installed'}},'INVALID_PAYLOAD');
  await h.reject('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Duplicate manifest prefix',version:'1.0.0',declaration:{reads:[],writes:[],credentials:[]},configuration:{packageId:'documents',productLineId:'third'}},'TOOL_NAME_CONFLICT');
  const worker=await h.startWorker();const read=await h.request('/v1/tools/third_docs.get/call',{args:{file:'/dav/manual.txt'},idempotencyKey:'third-product-read'});assert.ok(read.evidence.length);assert.equal(sha256(Buffer.from(read.result.contentBase64,'base64')),read.evidence[0].sha256);
  assert.equal((await h.request('/v1/tools')).find((tool:any)=>tool.name==='third_docs.get').assetId,third.assetId);
  await h.stop(worker);await writeFile(config,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:[second]}));await h.stop();await h.startServer();
  const remaining=(await h.request('/v1/tools')).map((tool:any)=>tool.name);assert.ok(remaining.includes('meridian_docs.get'));assert.ok(!remaining.some((name:string)=>name.startsWith('third_docs')||name.startsWith('zentao.')));
  await h.reject('/v1/tools/third_docs.get/call',{args:{file:'/dav/manual.txt'},idempotencyKey:'removed-product-read'},'SOURCE_FORBIDDEN');
  await writeFile(config,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:[first,second,'third/product-line.json']}));await h.stop();await h.startServer();
  assert.equal((await h.request('/v1/tools')).find((tool:any)=>tool.name==='third_docs.get').assetId,third.assetId);
});

test('Act R2.7: product-line installation rejects malformed declarations before startup',async t=>{
  const {loadProductLines}=await import('../../packs/product-lines.ts');
  const directory=await mkdtemp(`${tmpdir()}/circle-hub-invalid-product-lines-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  const manifest={schemaVersion:'product-line/1',id:'fixture',version:'1.0.0',connectorPackages:[{packageId:'documents',alias:'fixture_docs'}],skills:[]};
  const config=`${directory}/installed.json`,file=`${directory}/product-line.json`;
  await writeFile(config,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:['product-line.json']}));
  const rejected=async()=>assert.rejects(()=>loadProductLines(config),(error:any)=>error.code==='INVALID_PAYLOAD');
  for(const invalid of [{...manifest,schemaVersion:'product-line/2'},{...manifest,connectorPackages:['not-installed']},{...manifest,skills:['../outside/SKILL.md']},{...manifest,toolAliases:{documents:'different'}},{...manifest,connectorPackages:['documents','documents']}]){await writeFile(file,JSON.stringify(invalid));await rejected();}
  await writeFile(file,JSON.stringify(manifest));await writeFile(config,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:['product-line.json','product-line.json']}));await rejected();
  await writeFile(config,'{');await rejected();
  await writeFile(config,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:[]}));const empty=await loadProductLines(config);assert.deepEqual(empty.productLines,[]);assert.deepEqual(empty.toolPackages.map(pack=>pack.id),['knowledge']);
});
