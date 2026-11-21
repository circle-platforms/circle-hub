import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres} from '../testing/postgres.ts';
import {openTestRecords} from '../testing/records.ts';
import {Database,createPool} from './db.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

const runId=(letter:string):string=>'run_'+'0'.repeat(25)+letter;

/** What `work` asked the database. A cast of the bodies is what made a page cost seconds, so it is the fact to pin. */
async function statements<T>(work:()=>Promise<T>):Promise<{value:T;seen:string[]}>{
 const original=Database.prototype.query,seen:string[]=[];
 Database.prototype.query=(async function(this:Database,...args:Parameters<typeof original>){seen.push(String(args[0]));return original.apply(this,args);}) as typeof original;
 try{return {value:await work(),seen};}finally{Database.prototype.query=original;}
}
const castsBodies=(seen:readonly string[]):boolean=>seen.some(text=>text.includes('::json'));

test('current run entries order and paginate runs without reading bodies to sort',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const store=kit.store;
 const ids=['b','a','c','d'].map(runId),dates=['2026-11-03T01:00:00.000Z','2026-11-03T03:00:00.000Z','2026-11-03T01:00:00.000Z','2026-11-03T02:00:00.000Z'];
 for(let i=0;i<4;i++)await store.put({kind:'run',schema:'synthetic-order@1',provenance:'declared',body:{started_at:dates[i],run:ids[i]},index:[{key:'runs.pack',value:i===3?'other':'main'},{key:'runs.started',value:dates[i]+' '+ids[i]}]});
 const queries=[{limit:4},{limit:2},{after:[dates[3]!,ids[3]!] as const,limit:2},{pack:'main',limit:3},{after:[dates[3]!,ids[3]!] as const,pack:'main',limit:1}];
 const read=async()=>statements(async()=>Promise.all(queries.map(query=>store.runCandidates!<{run:string}>(query))));
 const fromIndex=await read();
 assert.equal(castsBodies(fromIndex.seen),false);
 assert.deepEqual(fromIndex.value.map(page=>page.map(r=>r.body.run)),[
  [ids[1],ids[3],ids[2],ids[0]], [ids[1],ids[3]], [ids[2],ids[0]],
  [ids[1],ids[2],ids[0]], [ids[2]],
 ]);
 const owner=new Database(createPool(kit.database,1));t.after(()=>owner.end());
 assert.equal((await owner.query(`SELECT count(*)::int AS n FROM record_index WHERE key='runs.started'`)).rows[0]!.n,4);

});
