// Cleared-ground checks use the existing exact source index, never each team source body.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalize,sha256Hex,type Transaction} from '../records/api.ts';
import {makeWorld,startPostgres} from './test-support.ts';

test('team src grounds use indexed matching sources and immediately observe a later purge',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await makeWorld(pg);t.after(w.close);
 const spaces=w.knowledge.spaces!,source=await spaces.importFile(w.user,Buffer.from('合成原件：每次保留两份。'),'text/plain','synthetic.txt','/private');
 const personal=await spaces.write(w.user,{kind:'observation',statement:'合成规则每次保留两份',path:'/private',grounds:[{reference:'src:'+source.body.sha256,quotation:'每次保留两份'}]});
 const view=await spaces.entry(w.user,personal.root,'/private',personal.entry);assert.ok(view);
 const link=await w.kit.store.find({key:'knowledge.space.source_hash',value:source.body.sha256,kind:'knowledge_space_source'});const original=link.items[0].body as Record<string,unknown>;
 const sources:string[]=[];
 for(let n=0;n<400;n++){
  const sha=n===399?source.body.sha256:sha256Hex('synthetic-unrelated-'+n);
  const row=await w.kit.store.put({kind:'knowledge_space_source',schema:'knowledge-space-source@1',provenance:'declared',body:{...original,space:'team',sha256:sha,path:'/team-'+n},index:[{key:'knowledge.space.source_hash',value:sha}]});sources.push(row.digest);
 }
 const copied=await w.kit.store.put({kind:'knowledge_space_entry',schema:'knowledge-space-entry@1',provenance:'declared',body:{...view.body,space:'team'}});
 const previous=await spaces.ensure(w.admin,'team'),node=await w.kit.objects.put(Buffer.from(canonicalize({name:'',children:[],entries:[personal.entry]})),'application/json');
 const version=await w.kit.store.put({kind:'knowledge_space_version',schema:'knowledge-space-version@1',provenance:'projected',body:{...previous.body,parent:previous.root,tree:node.sha256,sources,directories:['/','/team'],entries:[{path:'/team',entry:personal.entry,record:copied.digest,status:'verified'}]},index:[{key:'knowledge.space.version',value:'team'}]});
 const get=w.kit.store.get.bind(w.kit.store),many=w.kit.store.findMany.bind(w.kit.store);let direct=0,matched=0;
 w.kit.store.get=async(...args)=>{if(sources.includes(args[0]))direct++;return get(...args);};
 w.kit.store.findMany=async <B>(query:Parameters<typeof many>[0],tx?:Transaction)=>{const rows=await many<B>(query,tx);if(query.key==='knowledge.space.source_hash')matched+=rows.length;return rows;};
 assert.equal((await spaces.entry(w.admin,version.digest,'/team',personal.entry))?.row.status,'verified');
 assert.equal(direct,0);assert.ok(matched<=2,'only the matching private/team source rows are loaded');
 const epoch=(await w.kit.personalPayloads!.inspect(personal.root))!.epoch;await w.kit.personalPayloads!.purge(w.user,epoch);
 assert.equal((await spaces.entry(w.admin,version.digest,'/team',personal.entry))?.row.status,'unverified');
 assert.equal(direct,0);assert.ok(matched<=3,'no stale per-process false cache survives a purge');
 assert.deepEqual((await w.kit.store.get(copied.digest))?.body,copied.body);
});
