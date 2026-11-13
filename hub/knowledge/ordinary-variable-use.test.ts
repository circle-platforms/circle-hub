import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import type {ProductHandle,KnowledgePackReadPort} from '../ports.ts';
import type {RecordVariables} from '../records/api.ts';
import {resolveProductVariables} from './variables.ts';

const packReads:KnowledgePackReadPort={readPackDirectory:async()=>{throw new Error('unused directory reader');},packSchema:()=>({ok:true,schema:z.number().int().min(1)})};

test('product variables preserve the recorded decision and mark only ordinary variable uses',async()=>{
 const decision='a'.repeat(64),by={id:'synthetic-admin',name:'合成管理员',role:'admin' as const};
 const product={id:'synthetic-product',version:'1.0.0',product:{variables:[{name:'DEMO_COUNT',schema:{type:'integer',minimum:1},default:1}],producers:[{params:{count:'${var:DEMO_COUNT}'}}]}} as unknown as ProductHandle;
 const variables={snapshot:async()=>new Map([['DEMO_COUNT',decision]]),valueAt:async(name:string,digest:string)=>{assert.equal(name,'DEMO_COUNT');assert.equal(digest,decision);return 2;},history:async()=>[{version:3,decision:{digest:decision}}]} as unknown as Pick<RecordVariables,'snapshot'|'valueAt'|'history'>;
 const resolved=await resolveProductVariables(packReads,product,variables,by,false);
 assert.ok(!('problems'in resolved));
 assert.deepEqual(resolved.uses,[{kind:'var',at:'synthetic-product@1.0.0#/producers/0/params/count',name:'DEMO_COUNT',decision}]);
 const dry=await resolveProductVariables(packReads,product,undefined,by,true);
 assert.ok(!('problems'in dry));assert.deepEqual(dry.uses,[],'a default has no recorded decision to invent');
});
