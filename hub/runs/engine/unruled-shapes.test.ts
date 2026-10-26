import assert from 'node:assert/strict';
import {test} from 'node:test';
import {unruledShapes} from './queries.ts';
import type {RecordStore,Principal} from '../../records/api.ts';
const admin={id:'synthetic-admin',name:'合成管理员',role:'admin'} as Principal;
const record=(pack:string,run:string,submission:string)=>({created_at:'2026-10-25T00:00:00Z',body:{locks:{pack},run,submission,cross_item:[{qualifier:{marks:['decision_shape_unruled']},statement:{data:{requirement:'r',interpreter:'future@1',table:'must never leave the query'}}}]}});
test('unruled shape queries use locked pack identities, deduplicate revalidation and deny ordinary readers',async()=>{
 const data=[record('synthetic@10.6.0','run-one','a'),record('synthetic@10.6.0','run-one','a'),record('synthetic@10.6.1','run-two','b'),record('other@10.6.0','run-three','c')];
 const store={list:async()=>({items:data,next:null})} as unknown as RecordStore;
 const rows=await unruledShapes(store,admin,'synthetic');
 assert.deepEqual(rows,[{requirement:'r',interpreter:'future@1',count:2,latest_run:'run-two'}]);
 assert.deepEqual(await unruledShapes(store,admin,'absent'),[]);
 await assert.rejects(unruledShapes(store,{...admin,role:'user'},'synthetic'),/管理员/);
 assert.equal(JSON.stringify(rows).includes('must never'),false);
});
