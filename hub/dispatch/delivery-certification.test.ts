import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';

for(const change of ['different-session','revoked-version']) {
  test(`C4.1 negative proof rejects an uncertified delivering version: ${change}`,async t=>{
    let version=change==='different-session'?'0':'1';
    const c=await setupJournal({lost:true,absent:true,uncertified:change==='revoked-version',supportedVersions:['0','1'],serverVersion:()=>version});t.after(()=>c.close());
    const first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.frozen,true);
    version='1';
    await c.registry.update(c.admin,c.executor.id,{...c.registered.definition,reconciliation:{...c.registered.definition.reconciliation,protocol_versions:change==='revoked-version'?['2']:['0','1']},premises:{request_journal:{version:'1',evidence:[`src:${c.proof.body.sha256}`]}}});
    const state=await c.service.resume(c.admin,first.job);
    assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);
    assert.match(state.missing_fact!,/发送会话版本/);assert.match(state.next_action!,/认证|登记/);
    assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  });
}
