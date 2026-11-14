// Synthetic loopback instances and real low-privilege runtime records; no executor or business endpoint is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHub, type TestHub } from '../../hub/server/testing-real.ts';
import { startPostgres } from '../../hub/testing/postgres.ts';
import { applyDeployment, exportDeployment } from '../../hub/server/cli-apply.ts';
import { createEnvironmentManagementPorts } from '../../hub/server/test-environments-console.ts';
import { environmentPermissionSources } from '../../hub/server/env-permission-sources.ts';
import { openRecords } from '../../hub/records/api.ts';
import { ExecutorNames, ExecutorRegistry } from '../../hub/dispatch/api.ts';
import { definition as syntheticExecutor } from '../../hub/dispatch/testing/definition.ts';
import type { Session } from '../../hub/server/cli-session.ts';

const options={repositoryPacks:false,stubs:false,mindmapSkill:false,workbookSkill:false,xmlSkill:false,htmlSkill:false};
function session(hub:TestHub):Session {
  return {ctx:{io:{cwd:hub.records.dataDir,env:{},stdout:()=>{}}},options:{},config:()=>hub.deps.config,
    admin:async()=>hub.admin.principal,viewer:async()=>hub.admin.principal,records:async()=>hub.records,hub:async()=>hub.hub,
    leases:async()=>hub.leases,out:()=>{},err:()=>{},
  } as unknown as Session;
}

test('an unmodified deployment v3 export restores environment identities by name, owners and all assignment audiences into an empty instance', {timeout:180000}, async()=>{
  const postgres=await startPostgres();let source:TestHub|undefined,target:TestHub|undefined;
  try {
    source=await createTestHub({...options,postgres});
    const by=source.admin.principal;
    const responsible=await source.createUser('合成责任人'),member=await source.createUser('合成成员');
    const dormant=await source.createUser('合成停用受众');
    const team=await source.records.teams.create(by,'合成团队');await source.records.teams.add(by,team.id,member.user.id);
    await source.records.testEnvironments.inherit(by,environmentPermissionSources());
    const executors=new ExecutorRegistry(source.records);
    const linked=[];
    for(const name of ['合成执行器甲','合成执行器乙'])linked.push(await executors.add(by,{...syntheticExecutor('http://127.0.0.1:9'),target:'synthetic-target-a',resources:['synthetic/a/device']},name));
    const at=new Date().toISOString();
    const first=await source.records.testEnvironments.register(by,{name:'合成环境甲',target:'synthetic-target-a',prefixes:[{prefix:'synthetic/a/',owner:responsible.user.id,registered_at:at}],resources:[],executors:linked.map(executor=>executor.id),enabled:true,missing_facts:[]});
    const second=await source.records.testEnvironments.register(by,{name:'合成环境乙',target:'synthetic-target-b',prefixes:[],resources:[{key:'synthetic/b/device',owner:responsible.user.id,registered_at:at}],executors:[],enabled:true,missing_facts:[]});
    await source.records.testEnvironments.registerBookingPrefix(by,{prefix:'ordinary/bookings/',owner:responsible.user.id});
    const expiresAt='2099-01-01T00:00:00.000Z';
    await source.records.authorizations.assignResource(by,first.id,team.id,{expiresAt});
    await source.records.authorizations.assignResource(by,first.id,member.user.id);
    await source.records.authorizations.assignResource(by,second.id,'*');
    await source.records.authorizations.assignResource(by,second.id,responsible.user.id);
    await source.records.authorizations.unassignResource(by,second.id,responsible.user.id);
    await source.records.authorizations.assignResource(by,first.id,dormant.user.id,{expiresAt});
    await source.records.principals.setDisabled(by,responsible.user.id,true);
    await source.records.principals.setDisabled(by,dormant.user.id,true);
    const definition=await exportDeployment(session(source));
    assert.equal(definition.schema,'deployment@3');assert.equal(Object.hasOwn(definition,'leaseRegistrations'),false);
    assert.equal(definition.environmentAssignments.length,4);
    assert.deepEqual(definition.testEnvironments[0].executors,['合成执行器甲','合成执行器乙']);
    assert.equal(definition.testEnvironments[0].prefixes[0].owner,responsible.user.name);
    assert.doesNotMatch(JSON.stringify({environments:definition.testEnvironments,assignments:definition.environmentAssignments}),/(?:env|exe|usr|tm)_[0-9a-z]{26}/);
    target=await createTestHub({...options,postgres});
    const report=await applyDeployment(session(target),definition);
    assert.deepEqual(report.differences,[]);
    const restored=await exportDeployment(session(target));
    assert.deepEqual(restored.testEnvironments,definition.testEnvironments);
    assert.deepEqual(restored.environmentAssignments,definition.environmentAssignments);
    assert.deepEqual(restored.accounts.filter(account=>account.disabled).map(account=>account.name).sort(),['合成停用受众','合成责任人'].sort());
    assert.deepEqual(restored.bookingPrefixes,definition.bookingPrefixes);
    assert.deepEqual(restored.bookingPrefixes,[{prefix:'ordinary/bookings/',owner:'合成责任人'}]);
    const repeated=await applyDeployment(session(target),definition);
    assert.equal(repeated.created,0);assert.deepEqual(repeated.differences,[]);
    const environments=await target.records.testEnvironments.list(target.admin.principal);
    const restoredFirst=environments.find(environment=>environment.name==='合成环境甲')!;
    const restoredMember=await target.records.principals.findByName('合成成员');assert.ok(restoredMember);
    assert.equal(await target.records.testEnvironments.canUse(restoredMember,restoredFirst.id),true);
    assert.equal(await target.records.testEnvironments.canUse(target.admin.principal,restoredFirst.id),false);
    const restoredDormant=await target.records.principals.findByName('合成停用受众');assert.ok(restoredDormant?.disabled);
    assert.equal(await target.records.testEnvironments.canUse(restoredDormant,restoredFirst.id),false);
    assert.equal((await target.records.testEnvironments.inheritance()).completed,true);
    const single=await openRecords({...target.records.config,database:target.records.database},{migrate:false,maxConnections:1,keyProvider:target.records.keyProvider});
    try {await single.store.withTransaction(async tx=>{
      assert.equal((await single.principals.get(restoredMember.id,tx))?.name,'合成成员');
      assert.ok((await single.principals.list(tx)).some(user=>user.id===restoredMember.id));
      assert.equal((await single.principals.some([restoredMember.id],tx)).length,1);
      const teams=await single.teams.list(target!.admin.principal,tx);assert.equal(teams.length,1);
      assert.ok((await single.teams.members(target!.admin.principal,teams[0].id,tx)).some(member=>member.user.id===restoredMember.id));
      assert.equal((await new ExecutorNames(single).list(target!.admin.principal,tx)).length,2);
    });
      const management=createEnvironmentManagementPorts(single,target.leases);
      const managed=await management.testEnvironments.list(target.admin.principal);
      const managedFirst=managed.find(environment=>environment.name==='合成环境甲')!;
      assert.equal(managedFirst.ownership[0].ownerName,'合成责任人');assert.equal(managedFirst.ownership[0].ownerDisabled,true);
      assert.ok(managedFirst.assignments.some(assignment=>assignment.subject.kind==='account'&&assignment.subject.name==='合成停用受众'&&assignment.accountDisabled===true));
      const ordinary=await management.bookingPrefixes.list(target.admin.principal);
      assert.equal(ordinary[0].ownerName,'合成责任人');assert.equal(ordinary[0].ownerDisabled,true);assert.deepEqual(ordinary[0].holders,[]);
      await assert.rejects(management.testEnvironments.list(restoredMember));
      assert.ok(target.deps.testEnvironments,'normal assembly exposes the real management port');
    }finally{await single.close();}

  } finally {
    try {await target?.close();} finally {try {await source?.close();} finally {await postgres.stop();}}
  }
});
