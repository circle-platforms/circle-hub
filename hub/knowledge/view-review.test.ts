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
