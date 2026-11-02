// Synthetic page metadata and bodies use the real store; no external system or model is called.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
import {withReadScope,type RecordStore} from '../records/api.ts';
import {Database} from '../records/db.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('recent knowledge pages sort before body hydration, keep tie order and hydrate only the authorized page',async t=>{
 let at=Date.parse('2026-11-03T08:00:00.000Z');const w=await makeWorld(postgres,{now:()=>new Date(at)});t.after(w.close);const spaces=w.knowledge.spaces!;
 const written:{entry:string;at:string;path:string}[]=[];
 for(let n=0;n<125;n++){at=Date.parse('2026-11-03T08:00:00.000Z')+(n%3)*1000;const path=n%2?'/shared':'/private',row=await spaces.write(w.user,{kind:'observation',statement:'合成分页记录 '+n,path,data:{text:'合成正文'}});written.push({entry:row.entry,at:new Date(at).toISOString(),path});}
 const expected=[...written].sort((a,b)=>b.at.localeCompare(a.at));
 const root=(await spaces.current(w.user.id))!,entryRecords=new Set(root.body.entries.map(r=>r.record)),getMany=w.kit.store.getMany.bind(w.kit.store);const read=new Set<string>();
 w.kit.store.getMany=async(...args)=>{for(const id of args[0])if(entryRecords.has(id))read.add(id);return getMany(...args);};
 const page=await spaces.recent(w.user,'personal',100);assert.equal(page.total,125);assert.deepEqual(page.items.map(v=>v.row.entry),expected.slice(0,100).map(v=>v.entry));assert.equal(read.size,100,'off-page bodies are not hydrated');
 await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id});
 const shared=await spaces.recent(w.outsider,'shared',7);assert.equal(shared.total,written.filter(r=>r.path==='/shared').length);assert.deepEqual(shared.items.map(v=>v.row.entry),expected.filter(r=>r.path==='/shared').slice(0,7).map(r=>r.entry));assert.ok(shared.items.every(v=>v.cited_count===null));
 await spaces.grant(w.user,{path:'/shared',audience:'member',member:w.outsider.id,revoke:true});assert.deepEqual(await spaces.recent(w.outsider,'shared',7),{items:[],total:0});
 const duplicate=await spaces.recent(w.user,'personal',7);assert.deepEqual(duplicate.items.map(v=>v.row.entry),expected.slice(0,7).map(r=>r.entry));
 const current=(await spaces.current(w.user.id))!;const refs=current.body.entries.slice(0,4).map(row=>({path:row.path,entry:row.entry}));
 const batch=await spaces.entries(w.user,current.root,refs);assert.deepEqual(batch,await Promise.all(refs.map(row=>spaces.entry(w.user,current.root,row.path,row.entry))));
 await spaces.withdraw(w.user,refs[0].entry);assert.equal((await spaces.entries(w.user,current.root,refs))[0]?.row.status,'withdrawn','historic roots show the current withdrawal without rewriting their body');
});
test('same-size knowledge pages use bounded SQL after off-page growth and retain current withdrawal and unknown counts',async t=>{
 const w=await makeWorld(postgres);t.after(w.close);const spaces=w.knowledge.spaces!;
 for(let n=0;n<14;n++)await spaces.write(w.user,{kind:'observation',statement:'合成增长记录 '+n,path:'/notes'});
 const original=Database.prototype.query;let calls=0;Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){calls++;return original.apply(this,args);}) as typeof original;t.after(()=>{Database.prototype.query=original;});
 calls=0;const before=await spaces.recent(w.user,'personal',5),small=calls;
 for(let n=14;n<34;n++)await spaces.write(w.user,{kind:'observation',statement:'合成增长记录 '+n,path:'/notes'});
 calls=0;const after=await spaces.recent(w.user,'personal',5);assert.equal(calls,small);assert.equal(before.items.length,after.items.length);assert.equal(after.total,34);assert.ok(after.items.every(v=>v.row.status==='unverified'&&v.cited_count===0));
 const native=w.kit.store.entryCandidates,times=w.kit.store.entryTimes;w.kit.store.entryCandidates=undefined;
 try{assert.deepEqual(await spaces.recent(w.user,'personal',5),after);w.kit.store.entryTimes=undefined;assert.deepEqual(await spaces.recent(w.user,'personal',5),after);}finally{w.kit.store.entryCandidates=native;w.kit.store.entryTimes=times;}
 // Optional counters preserve unknown instead of inventing zero in stores that do not expose the count port.
 const store=w.kit.store as RecordStore,counts=store.countIndexed;store.countIndexed=undefined;
 try{await withReadScope(async()=>assert.ok((await spaces.recent(w.user,'personal',5)).items.every(v=>v.cited_count===null)));}finally{store.countIndexed=counts;}
});
