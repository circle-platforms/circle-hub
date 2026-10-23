import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';
import {jobCommand} from '../server/cli-job.ts';

for(const cause of ['version','declaration','snapshot']) {
  test(`C4.5 the operator sees the specific pre-delivery refusal and next action for ${cause}`,async t=>{
    const c=await setupJournal({supportedVersions:cause==='version'?['2']:['1'],beforeIdentityMissing:cause==='snapshot'});t.after(()=>c.close());
    if(cause==='declaration') {const d=structuredClone(c.registered.definition);delete d.reconciliation!.identity;await c.registry.update(c.admin,c.executor.id,d);}
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
    assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.includes('send_blob'),false);
    assert.match(state.reason!,cause==='version'?/会话版本/:cause==='declaration'?/字段声明/:/日志身份|主体|边界/);
    assert.match(state.next_action!,cause==='version'?/版本|协议/:cause==='declaration'?/字段|声明/:/日志|原件|边界/);
    const lines:string[]=[];const s={out:(s:string)=>lines.push(s),err:(s:string)=>lines.push(s),admin:async()=>c.admin,records:async()=>c.kit,hub:async()=>({dispatch:c.service,records:c.kit}),options:{},ctx:{io:{cwd:c.kit.dataDir}}};
    await jobCommand(s,['status',state.job]);assert.ok(lines.some(line=>line.includes(state.reason!)));assert.ok(lines.some(line=>line.includes(state.next_action!)));
  });
}
