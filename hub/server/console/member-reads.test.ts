// Synthetic loopback credentials; the projection must not broaden a member's device view.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {openTestRecords} from '../../testing/records.ts';
import {circlesOf} from './connections.ts';
import {circleNames} from './circles.ts';
import type {PageContext} from './pages.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('batched Circle projection hides disabled owners and revoked devices and scopes an ordinary reader to their own devices',async t=>{
 const kit=await openTestRecords({postgres});t.after(()=>kit.close());const {user:admin}=await kit.principals.bootstrapAdmin('管理员'),a=await kit.principals.createUser(admin,'甲'),b=await kit.principals.createUser(admin,'乙');
 const client=await kit.principals.registerClient('合成 Circle',['http://127.0.0.1/callback']);
 const own=await kit.principals.issueToken(admin,a.id,'合成标签',client.id),revoked=await kit.principals.issueToken(admin,a.id,'合成已断开');await kit.principals.revokeToken(admin,revoked.id);await kit.principals.issueToken(admin,b.id,'合成停用成员设备');await kit.principals.setDisabled(admin,b.id,true);
 const context=(principal:typeof admin,isAdmin:boolean)=>({principal,admin:isAdmin,deps:{records:kit}} as unknown as PageContext);
 const mine=await circlesOf(context(a,false));assert.deepEqual(mine.map(row=>row.token.id),[own.id]);assert.equal(mine[0].name,'合成 Circle');
 const all=await circlesOf(context(admin,true));assert.ok(all.some(row=>row.token.id===own.id));assert.ok(!all.some(row=>row.token.id===revoked.id||row.token.user===b.id));
 await kit.principals.revokeToken(admin,own.id);assert.deepEqual(await circlesOf(context(a,false)),[]);
 const tokens=await kit.principals.tokens(a.id);const fallback=await circleNames({client:id=>kit.principals.client(id)},tokens);assert.equal(fallback.get(own.id),'合成 Circle');assert.equal(fallback.get(revoked.id),'合成已断开');
});
