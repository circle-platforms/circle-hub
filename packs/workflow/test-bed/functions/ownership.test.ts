import { CheckOutcome } from '../../../../contracts/src/tables.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import project from './project.ts';
import { bedOutcomes } from './check-bed.ts';
import type { FrozenLeases } from './conclude.ts';

const manifest={schema:'test-bed-manifest@1',beds:[{name:'sample',devices:[{name:'client',type:'client',ipv4:['192.0.2.10/26'],ipv6:[]}],services:[],reserved:[]}]};
const now='2026-10-24T08:00:00.000Z';
const view=(mine=true):FrozenLeases=>({now,registrations:[{prefix:'bed/sample/',mine}],entries:[{key:'bed/sample/client',until:null,since:now,run:'run_synthetic',mine:false,holder:{user:'usr_synthetic',name:'合成持有人'},jobs:['synthetic-job']}]});
function run(parameters:Record<string,unknown>,leases:FrozenLeases={now,entries:[],registrations:[]}){
  return project({inputs:[{slot:'inventory',model:manifest}],parameters,context:{leases}});
}
const subject=(out:any)=>({items:out.items.map((row:any)=>({...row,location:'src:'+'a'.repeat(64)+'/json@1/'+row.location.selector})),context:{groups:out.groups}});

test('each ownership action projects and recomputes, then rejects a tampered conclusion',()=>{
  for(const action of ['register','unregister','force_release']){
    const out=run({action,bed:'sample',reason:'  合成用户原话  '},action==='register'?undefined:view()) as any;
    assert.ok(!out.error,JSON.stringify(out));
    assert.equal(out.lease_requests[0].op,action);
    if(action==='register')assert.equal(out.lease_requests[0].prefix,'bed/sample/');
    if(action==='force_release')assert.equal(out.lease_requests[0].reason,'  合成用户原话  ');
    const frozen=subject(out);
    assert.equal(bedOutcomes(frozen)[0]!.verdict,'support');
    frozen.items[0].fields.conclusion='改过的结论';
    const mismatch=bedOutcomes(frozen)[0]!;
    assert.equal(mismatch.verdict,'refute');assert.equal(mismatch.code,`test-bed.${action}_mismatch`);
  }
});

test('refusals disclose the missing or conflicting fact and its correction',()=>{
  for(const [parameters,leases,code] of [
    [{action:'register',bed:'missing'},view(),'test-bed.unknown_bed'],
    [{action:'register',bed:'sample'},view(),'test-bed.already_owned'],
    [{action:'force_release',bed:'sample',reason:'合成原因'},view(false),'test-bed.not_owner'],
    [{action:'force_release',bed:'sample'},view(),'test-bed.reason_required'],
  ] as const){const out=run(parameters,leases) as any;assert.equal(out.error.code,code);assert.ok(out.error.fix);}
});

test('default search and facts disclose every occupied device without inventing an end or leaking a hidden holder',()=>{
  for(const action of ['search','facts'])for(const owner of [true,false]){
    const leases=view();if(!owner)delete leases.entries[0]!.holder;
    const out=run({action},leases) as any;assert.ok(!out.error);
    const text=JSON.stringify(out.items);
    assert.ok(text.includes('run_synthetic')&&text.includes(now)&&text.includes('synthetic-job'));
    assert.equal(text.includes('合成持有人'),owner);
    assert.ok(!text.includes('ttl_seconds'));
    assert.equal(bedOutcomes(subject(out))[0]!.verdict,'support');
  }
});

test('acquire has no duration and never allocates an address held without expiry',()=>{
  const leases=view();leases.entries.push({key:'bed/sample/ip/192.0.2.1',until:null});
  const out=run({action:'acquire',bed:'sample',need:{devices:[{type:'client',count:1}]},addresses:{segment:'192.0.2.0/26',count:1}},leases) as any;
  assert.ok(!out.error,JSON.stringify(out));
  assert.ok(!out.lease_requests[0].keys.includes('bed/sample/ip/192.0.2.1'));
  assert.equal(Object.hasOwn(out.lease_requests[0],'ttl_seconds'),false);
});

test('missing frozen input remains transitional with a missing fact and a bounded action',()=>{
  const outcome=bedOutcomes({})[0]!;
  assert.equal(outcome.verdict,'unknown');
  CheckOutcome.parse(outcome);
  assert.match(outcome.missing!, /冻结.*清单/);
  assert.ok(outcome.data?.missing_fact);
  const next=outcome.data?.next_action as Record<string,unknown>;
  for(const field of ['action','object','owner','deadline'])assert.ok(next[field]);
});
