import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as provider from '../../packages/execution/src/flow-provider.ts';

const policy={submitTool:'submit',statusTool:'status',resultTool:'results',reconcileTool:'reconcile',lease:{acquireTool:'acquire',heartbeatTool:'heartbeat',releaseTool:'release'}};
const context={principalId:'prn_synthetic',tenantId:'tnt_synthetic',kind:'user' as const};
function fixture(elevated:string,kind='user'){let role='member';const checked:string[]=[],services={auth:{check:async()=>({kind}),roles:{role:async()=>role}}},binding={asset:{declaration:{credentials:[]}},config:{receiptPolicy:policy},tools:['submit','status','results','reconcile','acquire','heartbeat','release','prepare'].map(name=>({name,effect:['status','results','reconcile','prepare'].includes(name)?'read':'write',minimumRole:name===elevated?'admin':'member'}))};return {services,binding,checked,setRole:(next:string)=>{role=next;}};}
test('Protocol Tool roles: member submission cannot delegate an administrator-only lease status results heartbeat or release call',async()=>{
 const authorize=(provider as any).providerProtocolTools;for(const elevated of ['acquire','status','results','heartbeat','release']){const f=fixture(elevated);await provider.providerTool(f.services,context,'scp_synthetic',f.binding,'submit');await assert.rejects(authorize(f.services,context,'scp_synthetic',f.binding,'submit'),(error:any)=>error.code==='FORBIDDEN_ACTION');f.setRole('admin');await authorize(f.services,context,'scp_synthetic',f.binding,'submit');}
});
test('Protocol Tool roles: ordinary reads and reconciliation check only their mechanical call chain while role changes remain live',async()=>{
 const authorize=(provider as any).providerProtocolTools,f=fixture('acquire');await authorize(f.services,context,'scp_synthetic',f.binding,'prepare');await authorize(f.services,context,'scp_synthetic',f.binding,'submit',true);const g=fixture('status');g.setRole('admin');await authorize(g.services,context,'scp_synthetic',g.binding,'submit');g.setRole('member');await assert.rejects(authorize(g.services,context,'scp_synthetic',g.binding,'submit'),(error:any)=>error.code==='FORBIDDEN_ACTION');const reconcile=fixture('reconcile');await assert.rejects(authorize(reconcile.services,context,'scp_synthetic',reconcile.binding,'submit',true),(error:any)=>error.code==='FORBIDDEN_ACTION');
});
test('Protocol Tool roles: service identities retain scope grants instead of acquiring human roles',async()=>{
 const f=fixture('status','service');f.services.auth.roles.role=async()=>{throw new Error('Machine authority must not be converted into a human role');};await (provider as any).providerProtocolTools(f.services,{...context,kind:'service'},'scp_synthetic',f.binding,'submit');
});
