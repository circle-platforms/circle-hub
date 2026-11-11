// The latest accepted result of a run is found by reading as few results as its history allows (issue 200): one when the
// newest is the accepted one, and pages that double when it is not, with the same answer whatever the first page's size.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,notAccepted,sha} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {newId} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openTestRecords} from '../../testing/records.ts';
import {latestAccepted,putResult} from './store.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

test('the newest accepted result is read alone; a tail of rejected ones is read in pages that double',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());
 const limits:number[]=[];
 const store=new Proxy(kit.store,{get(target,property){const value=Reflect.get(target,property,target);
  if(property==='find')return (query:{limit?:number;kind?:string},tx?:unknown)=>{if(query.kind==='validation_result')limits.push(query.limit??-1);return (value as (...a:unknown[])=>unknown).call(target,query,tx);};
  return typeof value==='function'?value.bind(target):value;}});
 let n=0;
 const put=async(run:string,ok:boolean)=>(await putResult(kit.store,ValidationResult.parse({...(ok?accepted:notAccepted),run,submission:sha('synthetic submission '+(++n))}),new Date(Date.UTC(2026,10,11,0,0,n)).toISOString())).digest;
 const asked=async(run:string,first?:number)=>{limits.length=0;const found=await latestAccepted(store,run,first);return {digest:found?.digest??null,limits:[...limits]};};

 const steady=newId('run');
 for(let i=0;i<6;i++)await put(steady,true);
 const newest=await put(steady,true);
 assert.deepEqual(await asked(steady),{digest:newest,limits:[1]},'one result read to show one');

 const troubled=newId('run');
 await put(troubled,true);const last=await put(troubled,true);
 for(let i=0;i<9;i++)await put(troubled,false);
 assert.deepEqual(await asked(troubled),{digest:last,limits:[1,2,4,8]},'nine rejected results after it: four pages, fifteen results at most');
 assert.equal((await asked(troubled,100)).digest,last,'the same answer from one large page');
 assert.equal((await asked(troubled,3)).digest,last);

 const never=newId('run');
 for(let i=0;i<4;i++)await put(never,false);
 assert.deepEqual(await asked(never),{digest:null,limits:[1,2,4]});
 assert.deepEqual(await asked(newId('run')),{digest:null,limits:[1]});
});
