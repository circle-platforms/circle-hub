import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {sha256,newId,canonicalHash,type AuthContext} from '../../packages/contracts/src/index.ts';
import {Store} from '../../packages/storage/src/index.ts';
import {Auth} from '../../packages/tasks/src/auth.ts';
import {Records} from '../../packages/knowledge/src/records.ts';
import {LocalObjects} from '../../packages/knowledge/src/objects.ts';
import {KnowledgeGraph} from '../../packages/knowledge/src/graph.ts';
import {ProductRecords} from '../../packages/knowledge/src/product-records.ts';
import {BuildSite} from '../../packages/connectors/src/build-site.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {executeTool} from '../../packages/connectors/src/tool-packages.ts';
import {commandHeads,commandParam,commandCheck} from '../../packages/methods/src/command-tree.ts';
import {publicationLayout} from '../fixtures/publication-layout.ts';
import {setup,until} from './harness.ts';

test('Publication regression: summary traversal filters products and keeps platform identities without eager XML or fixed downloads',async t=>{
  const fixture=await publicationLayout(t),profile:any={origin:fixture.origin,index:'/builds/',requestIntervalMs:0,buildSite:fixture.policy};
  const listed=await executeTool('build-site','build.versions',{},profile);assert.equal(listed.result.builds.length,8);
  assert.equal(new Set(listed.result.builds.map((build:any)=>build.buildId)).size,8);
  assert.deepEqual([...new Set(listed.result.builds.map((build:any)=>build.platform))],[null,'synthetic-os']);
  assert.ok(listed.raw.some(raw=>raw.path==='/builds/line_photon_10_8.html'));assert.ok(!fixture.requests.some(path=>/orion|command_tree|Bugs_Fixed/.test(path)));
  await assert.rejects(executeTool('build-site','build.parameters',{build:fixture.builds[0].name,head:'aaa ldap attribute group'},profile),(error:any)=>error.code==='INVALID_PAYLOAD'&&error.details.reason==='ambiguous_build');
  const selected=listed.result.builds.find((build:any)=>build.name===fixture.builds[1].name&&build.platform==='synthetic-os');
  const parameter=await executeTool('build-site','build.parameters',{build:selected.buildId,head:'aaa ldap attribute group label'},profile);
  assert.equal(parameter.result.head,'aaa ldap attribute group');assert.equal(parameter.result.platform,'synthetic-os');assert.equal(fixture.requests.filter(path=>path.includes('command_tree')).length,1);
  const standard=await executeTool('build-site','build.parameters',{build:fixture.builds[1].name,platform:null,scope:'configuration',head:'aaa ldap attribute group'},profile);assert.equal(standard.result.platform,null);assert.equal(standard.result.scope,'configuration');assert.equal(standard.result.parserVersion,'menu-path/2');
});

test('Publication regression: text titles and prefixed variant artifacts preserve all unpublished builds',async t=>{
  const fixture=await publicationLayout(t),site=new BuildSite(new HttpSource(fixture.origin));
  const listed=await site.listing('/builds/rel_photon_10_8_SyntheticOS.html',{versionLine:'10.8',platform:'synthetic-os'});assert.equal(listed.result.length,4);
  assert.deepEqual(listed.result.map(build=>build.formal),[true,true,false,false]);assert.ok(listed.result[2].files.commands!.includes('command_tree-SyntheticOS-Beta_'));assert.ok(listed.result[3].files.image!.endsWith('.click'));
  assert.equal(listed.result[0].imageSha256,'c'.repeat(64));assert.equal(listed.result[0].imageSize,'42M');
});

test('Publication regression: full ancestor menu paths drive heads parameters checks and retain scope',async t=>{
  const fixture=await publicationLayout(t),site=new BuildSite(new HttpSource(fixture.origin)),commands=await site.commandsFrom(Buffer.from(fixture.commands,'latin1'));
  assert.deepEqual(commands.map(command=>command.name),['aaa ldap attribute group','aaa acl group','service address','service mode']);assert.ok(commands.every(command=>command.scope==='configuration'));
  assert.deepEqual(commandHeads(commands,'aaa').heads,['aaa acl group','aaa ldap attribute group']);assert.equal(commandParam(commands,'aaa ldap attribute group value').parameters[0].help,'Synthetic café');
  const checked=commandCheck(commands,['AAA LDAP ATTRIBUTE GROUP label','aaa acl group 2048','service address 999.1.1.1','service mode wrong','group label']);
  assert.deepEqual(checked.commands.map((item:any)=>item.status),['hit','hit','hit','hit','missing']);assert.equal(checked.commands[1].violations[0].code,'OUT_OF_RANGE');assert.equal(checked.commands[2].violations[0].code,'TYPE_MISMATCH');assert.equal(checked.commands[3].violations[0].code,'ENUM_MISMATCH');
});

test('Publication regression: repair identifiers retain their systems and never join equal numbers from different systems',async t=>{
  const fixture=await publicationLayout(t),site=new BuildSite(new HttpSource(fixture.origin)),builds=(await site.listing('/builds/rel_photon_10_8.html')).result;
  const fixed:any=await site.fixed(builds[0]);assert.deepEqual(fixed.issues,[{system:'zentao',id:'51'},{system:'bugzilla',id:'401'}]);assert.deepEqual(fixed.result,['401']);
  const direct=await site.releasesFor({system:'zentao',id:'51'} as any,builds);assert.equal(direct.earliestFormal.name,fixture.builds[0].name);assert.equal(direct.all.length,2);assert.deepEqual(direct.issue,{system:'zentao',id:'51'});
  const different=await site.releasesFor({system:'zentao',id:'401'} as any,builds);assert.equal(different.earliestFormal.name,fixture.builds[1].name);
  assert.equal((await site.releasesFor('401',builds)).earliestFormal.name,fixture.builds[0].name);assert.equal((await site.releasesFor({system:'zentao',id:'99'} as any,builds)).status,'beta-only');
  assert.ok(!fixture.requests.some(path=>/tracker|legacy/.test(path)));
});

test('Publication regression: manifest filtering and platform commands flow through worker receipts into asynchronous knowledge',async t=>{
  const fixture=await publicationLayout(t),directory=await mkdtemp(`${tmpdir()}/circle-server-publication-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(`${directory}/product-line.json`,JSON.stringify({schemaVersion:'product-line/1',id:'fixture',version:'1.0.0',connectorPackages:[{packageId:'build-site',alias:'fixture_builds'}],connectorOptions:{'build-site':{buildSite:fixture.policy}},skills:[]}));
  await writeFile(`${directory}/installed.json`,JSON.stringify({schemaVersion:'installed-product-lines/1',productLines:['product-line.json']}));
  const h=await setup(t,{CIRCLE_SERVER_PRODUCT_LINES:`${directory}/installed.json`});
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"builds.read\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_alice'");await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_admin'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin:fixture.origin,index:'/builds/',requestIntervalMs:0}}}));h.env.CIRCLE_SERVER_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;await h.stop();await h.startServer();
  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic publication source',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'build-site',productLineId:'fixture',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_admin']});await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'admin');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});await h.startWorker();
  const call=(suffix:string,args:any)=>h.request(`/v1/tools/fixture_builds.${suffix}/call`,{args,idempotencyKey:`publication-${suffix}`});
  const versions=await call('versions',{});assert.equal(versions.result.builds.length,8);assert.ok(!fixture.requests.some(path=>/command_tree|Bugs_Fixed/.test(path)));
  const build=versions.result.builds.find((build:any)=>build.name===fixture.builds[1].name&&build.platform==='synthetic-os');
  const checked=await call('command_check',{build:build.buildId,commands:['aaa ldap attribute group value','group value']});assert.deepEqual(checked.result.commands.map((command:any)=>command.status),['hit','missing']);assert.equal(checked.result.platform,'synthetic-os');
  const repairs=await call('fixed_releases',{issueSystem:'zentao',issueId:'51',builds:[build.buildId]});assert.equal(repairs.result.earliestFormal.name,build.name);
  for(const ref of [...checked.evidence,...repairs.evidence]){const response=await fetch(`${h.url}/v1/knowledge/records/${ref.evidenceId}/content`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(response.status,200);assert.equal(sha256(Buffer.from(await response.arrayBuffer())),ref.sha256);}
  await until(async()=>{const jobs=(await h.db.query('SELECT status,error FROM knowledge_projection_jobs')).rows;assert.ok(!jobs.some(job=>job.status==='failed'),JSON.stringify(jobs));return jobs.length>=3&&jobs.every(job=>job.status==='succeeded');});
  const hits=await h.request(`/v1/knowledge/search?mode=fulltext&q=${encodeURIComponent('aaa ldap attribute group')}`);assert.ok(hits.items.some((item:any)=>item.payload.value.head==='aaa ldap attribute group'&&item.payload.conditions.platform==='synthetic-os'&&item.payload.conditions.scope==='configuration'));
  const claims=(await h.db.query("SELECT payload FROM knowledge_records WHERE kind='Claim' AND payload->>'predicate'='fixed-issues'")).rows;assert.ok(claims.some(row=>row.payload.value.some((issue:any)=>issue.system==='zentao'&&issue.id==='51')));
  // Seed the former leaf-name projector around the same sealed source, then
  // publish a newer projector. Changing rules must retire old statement keys.
  const job=(await h.db.query('SELECT * FROM knowledge_projection_jobs')).rows.find(row=>row.payload.sources.some((source:any)=>source.sha256===checked.result.sourceSha256)),ref=job.payload.sources.find((source:any)=>source.sha256===checked.result.sourceSha256);
  const evidence=await h.request(`/v1/knowledge/records/${ref.evidenceId}`),path=evidence.payload.path,store=new Store(JSON.parse(h.env.CIRCLE_SERVER_DATABASE_CONFIG!));store.pool=h.db;
  const auth=new Auth(store),graph=new KnowledgeGraph(store,auth,new Records(store,auth,new LocalObjects(h.env.CIRCLE_SERVER_DATA_DIR!))),products=new ProductRecords(graph),ctx={principalId:'prn_alice',tenantId:'tnt_lab',kind:'user'} as AuthContext;
  const publish=async(ruleVersion:string,subject:string,head:string)=>{
    const jobId=newId('rec');
    await h.db.query("INSERT INTO knowledge_projection_jobs(job_id,job_key,task_id,origin_task_id,tenant_id,scope_id,owner_id,payload,status) SELECT $1,$2,task_id,origin_task_id,tenant_id,scope_id,owner_id,$3,'succeeded' FROM knowledge_projection_jobs WHERE job_id=$4",[jobId,canonicalHash([jobId]),JSON.stringify({...job.payload,ruleVersion,sources:[ref]}),job.job_id]);
    await store.transaction(async tx=>{await products.importBatch(tx,ctx,'scp_lab',jobId,ruleVersion,[{sourcePath:path,entity:{subject,kind:'command',name:head,attributes:{}},predicate:'command-definition',value:{head},conditions:{build:build.name,platform:build.platform}}],new Map([[path,ref]]));await products.publishIncremental(tx,ctx,'scp_lab',jobId,[ref]);});
  };
  await publish('source-projection/1','legacy-leaf:group','group');const legacy=(await h.request('/v1/knowledge/search?mode=exact&q=legacy-leaf:group')).items[0];assert.ok(legacy);
  await publish('source-projection/2','corrected-full-path','aaa ldap attribute group');
  assert.equal((await h.request('/v1/knowledge/search?mode=exact&q=legacy-leaf:group')).items.length,0,'Old leaf-only declarations must leave the formal snapshot after reprojection of unchanged bytes');
  assert.equal((await h.request(`/v1/knowledge/records/${legacy.recordId}`)).payload.value.head,'group','Historical conclusions remain immutable');assert.equal((await h.request(`/v1/knowledge/records/${ref.sourceRecordId}`)).sha256,checked.result.sourceSha256);
});
