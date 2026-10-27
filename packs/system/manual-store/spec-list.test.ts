import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as dav from './functions/webdav.ts';
import {xmlParser} from '../../../hub/testing/parsers.ts';
import {startPostgres} from '../../../hub/testing/postgres.ts';
import {startWebDavStub} from '../../../hub/connectors/testing/api.ts';
import {openSystemKit,artifactBytes} from '../testing/kit.ts';

const listing=(folder:string,names:string[])=>xmlParser.parse(Buffer.from(`<D:multistatus xmlns:D="DAV:">${[folder,...names].map(h=>`<D:response><D:href>${h}</D:href></D:response>`).join('')}</D:multistatus>`)).model;
const content=(out:any)=>out.artifacts.find((a:any)=>a.name==='content').json;
test('inventory reads require declared folders while legacy searches retain their default',()=>{
 assert.throws(()=>dav.specListPlan({settings:{}}),/spec_folders.*下一步/);
 assert.deepEqual(dav.searchPlan({round:1,external:{type:'spec-search',key:'demo'},settings:{}}).requests.map(r=>r.params?.dir),['spec']);
});
test('declared spec folders are listed once and only direct safe members are returned',()=>{
 const settings={spec_folders:['spec','design']};
 assert.deepEqual(dav.specListPlan({settings}).requests.map(r=>r.params?.dir),['spec','design']);
 const out:any=dav.specListProject({settings,responses:{'list-0':{ok:true,model:listing('/spec/',['/spec/FAMX-spec.md','/spec/child/','/spec/bad%3Bname.md','http://192.0.2.5/other.md','/spec/deeper/file.md'])},'list-1':{ok:true,model:listing('/design/',['/design/FAMY-spec.md'])}}});
 assert.deepEqual(content(out).files.map((f:any)=>f.path),['spec/FAMX-spec.md','design/FAMY-spec.md']);
 assert.deepEqual(content(out).directories.map((f:any)=>f.path),['spec/child']);
 assert.equal(content(out).complete,true);
 assert.match(out.warnings.join('\n'),/bad;name.md/);
 assert.ok(!JSON.stringify(dav.specListPlan({settings})).includes('product'));
});
test('unread folders produce an incomplete listing and a concrete recovery action',()=>{
 const out:any=dav.specListProject({settings:{spec_folders:['spec']},responses:{list:{ok:false,status:403}}});
 assert.equal(content(out).complete,false);assert.deepEqual(content(out).unread,['spec']);
 assert.match(out.warnings.join('\n'),/spec.*下一步/);
});
test('legacy folder joins the one list and emits the exact migration warning',()=>{
 const settings={spec_folders:['design'],spec_folder:'legacy'};
 assert.deepEqual(dav.specListPlan({settings}).requests.map(r=>r.params?.dir),['design','legacy']);
 const out:any=dav.specListProject({settings,responses:{'list-0':{ok:true,model:listing('/design/',[])},'list-1':{ok:true,model:listing('/legacy/',[])}}});
 assert.ok(out.warnings.includes('旧设置 spec_folder 已并入 spec_folders，下一步资源管理员改用 spec_folders'));
 assert.deepEqual(dav.searchPlan({round:1,external:{type:'spec-search',key:'demo'},settings}).requests.map(r=>r.params?.dir),['design','legacy']);
});
test('the request cap applies after deduplicating the merged legacy folder',()=>{
 const spec_folders=Array.from({length:32},(_,i)=>'directory'+i);
 assert.equal(dav.specListPlan({settings:{spec_folders,spec_folder:'directory0'}}).requests.length,32);
});
test('an empty folder configuration and invalid paths refuse before any request',()=>{
 assert.throws(()=>dav.specListPlan({settings:{spec_folders:[]}}),/spec_folders.*下一步/);
 assert.throws(()=>dav.specListPlan({settings:{spec_folders:['../private']}}),/spec_folders.*下一步/);
});
test('listing titles come from WebDAV displayname and searches retain each folder for equal filenames',()=>{
 const model=xmlParser.parse(Buffer.from('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/spec/</D:href></D:response><D:response><D:href>/spec/neutral.md</D:href><D:propstat><D:prop><D:displayname>FAMY synthetic specification</D:displayname></D:prop></D:propstat></D:response></D:multistatus>')).model;
 const projected:any=dav.specListProject({settings:{spec_folders:['spec']},responses:{list:{ok:true,model}}});
 assert.equal(content(projected).files[0].title,'FAMY synthetic specification');
 // A search keeps every configured folder in its listing and reads nothing: keyword retrieval selects no source.
 const responses={'list-0':{ok:true,model:listing('/spec/',['/spec/demo.md'])},'list-1':{ok:true,model:listing('/design/',['/design/demo.md'])}};
 const planned=dav.searchPlan({round:2,external:{type:'spec-search',key:'demo'},settings:{spec_folders:['spec','design']},responses});
 assert.deepEqual(planned.requests,[]);assert.equal(planned.done,true);assert.equal(planned.original,'list-0');
 const searched:any=dav.searchProject({external:{type:'spec-search',key:'demo'},settings:{spec_folders:['spec','design']},responses,original:'list-0'});
 const meta=searched.artifacts.find((a:any)=>a.name==='meta').json;
 assert.deepEqual(meta.files.map((f:any)=>f.path),['spec/demo.md','design/demo.md']);
 assert.equal(meta.terms_used,false);
});
test('the connector reads declared and empty directories but refuses undeclared inventory',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const kit=await openSystemKit(pg,['manual-store']);t.after(()=>kit.close());
 const stub=await startWebDavStub({'/spec/FAMX.md':'# Synthetic','/design/FAMY.md':'# Synthetic','/empty/sub/':''});t.after(()=>stub.close());
 const cases:Array<{settings:Record<string,unknown>;paths:string[]|null;folders:string[]}>=
  [{settings:{spec_folders:['spec','design']},paths:['design/FAMY.md','spec/FAMX.md'],folders:['/design/','/spec/']},
   {settings:{spec_folder:'/spec/'},paths:['spec/FAMX.md'],folders:['/spec/']},
   {settings:{spec_folders:['design','/spec/'],spec_folder:'spec'},paths:['design/FAMY.md','spec/FAMX.md'],folders:['/design/','/spec/']},
   {settings:{spec_folders:['empty']},paths:[],folders:['/empty/']},
   {settings:{},paths:null,folders:[]}];
 for(const {settings,paths,folders} of cases){
  const resource=await kit.connectors.admin.addResource(kit.admin,{system_pack:'manual-store',name:'合成规格库',environment:'test',origins:{'manual-store':stub.origin},settings});
  const before=stub.requests.length;
  const read=await kit.connectors.reader.read('manual:spec-list:configured',{principal:kit.admin,run:null,purpose:'synthetic inventory'});
  if(paths===null)assert.equal(read.ok,false);
  else{
   assert.ok(read.ok,read.ok?'':read.reason);
   const data=JSON.parse(Buffer.from(await artifactBytes(kit,read.artifacts.find(a=>a.name==='content')!.artifact.body.sha256)).toString());
   assert.equal(data.complete,true);assert.deepEqual(data.files.map((file:{path:string})=>file.path).sort(),paths);
  }
  assert.deepEqual(stub.requests.slice(before).filter(request=>request.method==='PROPFIND').map(request=>decodeURIComponent(request.path)).sort(),folders);
  await kit.connectors.admin.disable(kit.admin,resource.id);
 }
});
