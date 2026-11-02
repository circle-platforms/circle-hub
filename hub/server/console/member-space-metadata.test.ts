import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newId,type User} from '../../records/api.ts';
import {memberSpaceMetadata} from './member-space-metadata.ts';
import type {PageContext} from './pages.ts';

test('administrator metadata counts only current all-administrator grants and discloses no private titles or counts',async()=>{
 const owner=newId('usr'),other=newId('usr'),user={id:owner,name:'合成成员',disabled:false} as User;
 const base={space:owner,path:'/private-directory',by:owner,at:'2026-11-02T00:00:00.000Z',audience:'administrators',member:null,action:'grant'};
 const {path:_path,...packGrant}=base;
 const ctx={admin:true,principal:{id:other,role:'admin'},deps:{knowledge:{spaces:{usage:async()=>({knowledge:31,memory:17,used:48,limit:1073741824,remaining:1073741776,over:0})}},records:{store:{findMany:async({kind}:{kind:string})=>kind==='knowledge_space_grant'?[{body:base},{body:{...base,action:'revoke'}}]:kind==='memory_grant'?[{body:{...base,intent:'a'.repeat(64)}},{body:{...base,intent:'b'.repeat(64),audience:'member',member:other}}]:[{body:{...packGrant,pack:'synthetic-personal'}}]}}}} as unknown as PageContext;
 const rows=await memberSpaceMetadata(ctx,user),text=JSON.stringify(rows);
 assert.match(text,/48 B/);assert.match(text,/知识 0/);assert.match(text,/记忆 1/);assert.match(text,/工作流与通用技能 1/);assert.doesNotMatch(text,/不可披露|private-directory|entries|条目数量|历史版本/);
 assert.doesNotMatch(JSON.stringify(await memberSpaceMetadata({...ctx,admin:false},user)),/48 B/);
 assert.match(JSON.stringify(await memberSpaceMetadata(ctx,{...user,disabled:true})),/记忆 0/);
});
