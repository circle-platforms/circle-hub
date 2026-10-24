import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {makeWorld,startPostgres,catalogXml} from './test-support.ts';
import {completeKnowledgeView} from './complete-view.ts';
import {canonicalBytes} from '../records/api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('impact exclusions on an earlier page remain incomplete at the final page and refuse full binding',async t=>{
 const w=await makeWorld(postgres,{knowledge:{limits:{maxViewBytes:65536+1600}}});t.after(()=>w.close());
 const names=['Synthetic_10_6_1','Synthetic_10_6_2'],roots:string[]=[];
 for(const [side,name] of names.entries()){
  w.external.set('site:tree:'+name,{bytes:catalogXml({sample:Array.from({length:10},(_,i)=>({name:'cmd'+i,help:'side '+side}))}),mediaType:'application/xml'});
  const made=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:'site:tree:'+name}}});assert.ok(made.ok);roots.push(made.root!);
 }
 const from={build:names[0],root:roots[0]},to={build:names[1],root:roots[1]};
 const all=await w.knowledge.views.impact('acme',from,to,['definition'],[]);
 const excluded=new Set([all.changes[0].before[0],all.changes[0].after[0]]);
 let after:string|null=null,pages=0,last:any,first:any;
 const id=`knowledge:impact:acme:${names.join('..')}?changed=definition&attached=`;
 const reader={accepts:async()=>true,read:async(uri:string)=>{
  const token=uri.includes('&after=')?uri.split('&after=')[1]:null;
  const view=await w.knowledge.views.impact('acme',from,to,['definition'],[],null,null,excluded,token);
  if(view.next)view.next=id+'&after='+view.next;
  const artifact=await w.kit.artifacts.ingest({bytes:canonicalBytes(view),mediaType:'application/json',origin:{generated:{generator:'synthetic@1',inputs:[]}},author:{user:null},provenanceType:'projected',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false}});
  return {ok:true as const,id:uri,revision:roots.join('..'),manifest:'a'.repeat(64),artifacts:[{name:'original',artifact}]};
 }};
 do{last=await w.knowledge.views.impact('acme',from,to,['definition'],[],null,null,excluded,after);first??=last;after=last.next;assert.ok(++pages<30);}while(after);
 assert.ok(pages>1);assert.match(first.notes.join('\n'),/凭据/);assert.equal(last.truncated,true);
 const bound=await completeKnowledgeView(id,{principal:w.user,run:null,purpose:'synthetic exclusion regression'},reader,w.kit);
 assert.equal(bound.ok,false);if(!bound.ok)assert.match(bound.reason,/未交付|凭据/);
});

test('complete impact binding refuses a placement node delivered on two distinct change pages',async t=>{
 const w=await makeWorld(postgres);t.after(()=>w.close());
 const root='a'.repeat(64),id='knowledge:impact:acme:Synthetic_10_6_1..Synthetic_10_6_2?changed=definition&attached=case';
 const reader={accepts:async()=>true,read:async(uri:string)=>{
  const second=uri!==id,digest=(second?'2':'1').repeat(64),path=second?'/b':'/a';
  const view={schema:'impact-view@1',product:'acme',from:{build:'Synthetic_10_6_1',root},to:{build:'Synthetic_10_6_2',root},changed_kinds:['definition'],attached_kinds:['case'],changes:[{path,change:'added',before:[],after:[digest]}],placements:[{path:'/a',from:[],to:['3'.repeat(64)]}],entries:{[digest]:{entry:digest,kind:'definition',statement:'synthetic',data:{},reference:`tree:${root}${path}@${digest}`}},totals:{changed_paths:2,attached_from:0,attached_to:1},truncated:!second,next:second?null:id+'&after=synthetic',skipped:{from:0,to:0},notes:[]};
  const artifact=await w.kit.artifacts.ingest({bytes:canonicalBytes(view),mediaType:'application/json',origin:{generated:{generator:'synthetic@1',inputs:[]}},author:{user:null},provenanceType:'projected',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false}});
  return {ok:true as const,id:uri,revision:root+'..'+root,manifest:'a'.repeat(64),artifacts:[{name:'original',artifact}]};
 }};
 const bound=await completeKnowledgeView(id,{principal:w.user,run:null,purpose:'synthetic duplicate placement'},reader,w.kit);
 assert.equal(bound.ok,false);if(!bound.ok)assert.match(bound.reason,/重复.*节点/);
});
