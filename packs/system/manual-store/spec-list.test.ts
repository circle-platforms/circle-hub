import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as dav from './functions/webdav.ts';
import {xmlParser} from '../../../hub/refs/api.ts';

const listing=(folder:string,names:string[])=>xmlParser.parse(Buffer.from(`<D:multistatus xmlns:D="DAV:">${[folder,...names].map(h=>`<D:response><D:href>${h}</D:href></D:response>`).join('')}</D:multistatus>`)).model;
const content=(out:any)=>out.artifacts.find((a:any)=>a.name==='content').json;
test('declared spec folders are listed once and only direct safe members are returned',()=>{
 const settings={spec_folders:['spec','design']};
 assert.deepEqual(dav.specListPlan({settings}).requests.map(r=>r.params?.dir),['spec','design']);
 const out:any=dav.specListProject({settings,responses:{'list-0':{ok:true,model:listing('/spec/',['/spec/APV-spec.md','/spec/child/','/spec/bad%3Bname.md','http://192.0.2.5/other.md','/spec/deeper/file.md'])},'list-1':{ok:true,model:listing('/design/',['/design/NSAE-spec.md'])}}});
 assert.deepEqual(content(out).files.map((f:any)=>f.path),['spec/APV-spec.md','design/NSAE-spec.md']);
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
test('explicit empty folders list reads nothing and invalid paths refuse before any request',()=>{
 assert.deepEqual(dav.specListPlan({settings:{spec_folders:[]}}).requests,[]);
 assert.throws(()=>dav.specListPlan({settings:{spec_folders:['../private']}}),/spec_folders.*下一步/);
});
test('listing titles come from WebDAV displayname and searches retain each folder for equal filenames',()=>{
 const model=xmlParser.parse(Buffer.from('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/spec/</D:href></D:response><D:response><D:href>/spec/neutral.md</D:href><D:propstat><D:prop><D:displayname>NSAE synthetic specification</D:displayname></D:prop></D:propstat></D:response></D:multistatus>')).model;
 const projected:any=dav.specListProject({settings:{spec_folders:['spec']},responses:{list:{ok:true,model}}});
 assert.equal(content(projected).files[0].title,'NSAE synthetic specification');
 const planned=dav.searchPlan({round:2,external:{type:'spec-search',key:'demo'},settings:{spec_folders:['spec','design']},responses:{'list-0':{ok:true,model:listing('/spec/',['/spec/demo.md'])},'list-1':{ok:true,model:listing('/design/',['/design/demo.md'])}}});
 assert.deepEqual(planned.requests.map(r=>r.params?.path),['spec/demo.md','design/demo.md']);
});
