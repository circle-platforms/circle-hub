import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {jobCommand} from '../server/cli-job.ts';

const cli=(c:Awaited<ReturnType<typeof setup>>,lines:string[])=>({out:(s:string)=>lines.push(s),err:(s:string)=>lines.push(s),admin:async()=>c.admin,records:async()=>c.kit,hub:async()=>({dispatch:c.service,records:c.kit}),options:{},ctx:{io:{cwd:c.kit.dataDir}}});

// A seat's version and the product's build identity are judged against a run's locked build only, so those two causes take
// the precheck with a run that locks one (decision 120).
for(const cause of ['manifest','seat','acquire','connect','extra','product'] as const) {
  test(`PI16 precheck names the missing ${cause} fact and its recovery without remote values`,async t=>{
    const locked=cause==='seat' || cause==='product';
    const c=await setup({mode:cause==='acquire'?'busy':undefined,lockedBuild:locked?'synthetic-build':undefined,extraTools:cause==='extra'?['peek_extra']:[],alter:(name,value)=>cause==='seat' && name==='inspect_bound_seat'?{output:'version: DO_NOT_DISCLOSE_REMOTE_VALUE'}:name==='peek_extra'?{ok:false,error:'DO_NOT_DISCLOSE_REMOTE_VALUE'}:value});t.after(()=>c.close());
    const d=structuredClone(c.executor.definition);
    if(cause==='manifest') {
      const source=c.kit.artifacts.source.bind(c.kit.artifacts);
      c.kit.artifacts.source=async(...args)=>args[1]===d.manifest_sha256?null:source(...args);
    }
    if(cause==='extra')await c.registry.update(c.admin,c.executor.id,{...d,allowed_tools:[...d.allowed_tools,'peek_extra'],precheck_reads:[{tool:'peek_extra',arguments:{},conditions:[{pointer:'/ok',equals:true}]}]});
    if(cause==='product')c.service.options.knowledge={builds:async()=>[],resolveBuild:async()=>null};
    if(cause==='connect')await c.endpoint.close();
    const lines:string[]=[];
    assert.equal(await jobCommand(cli(c,lines),['precheck','--executor',c.executor.id,...(locked?['--booking',c.run]:[])]),1);
    const text=lines.join('\n');const words={manifest:/清单/,seat:/synthetic-0.*version/,acquire:/租约/,connect:/连接|会话/,extra:/附加|第 1/,product:/产品/};
    assert.match(text,words[cause]);assert.match(text,/缺事实/);assert.match(text,/下一步/);assert.doesNotMatch(text,/DO_NOT_DISCLOSE_REMOTE_VALUE|synthetic-secret/);
    assert.equal(c.calls.includes('send_blob'),false);
  });
}

// Decision 120: the bed has no version baseline. Without a run's locked build each seat's version report is recorded as the
// device's observation and judged against nothing, as is a condition bound to the build; the answer says so without the value.
test('a precheck without a run\'s locked build records each seat\'s version and judges no build',async t=>{
  const other='version: DO_NOT_DISCLOSE_REMOTE_VALUE';
  const c=await setup({alter:(name,value)=>name==='inspect_slot'?{...value,build:'DO_NOT_DISCLOSE_REMOTE_VALUE'}:name==='inspect_bound_seat' && String(value.output).startsWith('version:')?{output:other}:value});t.after(()=>c.close());
  const state=await c.service.precheck(c.admin,c.executor.id);
  assert.equal(state.failed_checks,undefined);
  assert.deepEqual(state.unjudged,[{step:'precheck.evaluated',pointer:'/build'},{step:'device_probe',seat:'synthetic-0',check:'version'},{step:'device_probe',seat:'synthetic-1',check:'version'}]);
  const events=await c.service.journal.events(state.job);
  assert.ok(events.some(e=>e.body.detail.readonly_verified===true));
  assert.ok(events.some(e=>e.body.detail.phase==='device_probe' && e.body.detail.check==='version' && e.body.detail.judged===false && e.body.detail.matched===true));
  const lines:string[]=[];
  assert.equal(await jobCommand(cli(c,lines),['precheck','--executor',c.executor.id]),0);
  const text=lines.join('\n');
  assert.match(text,/未对照：条件 "\/build"、座位 "synthetic-0" 的 version、座位 "synthetic-1" 的 version；没有运行锁定的构建/);
  assert.doesNotMatch(text,/DO_NOT_DISCLOSE_REMOTE_VALUE|未满足核对/);
  assert.equal(c.calls.includes('send_blob'),false);
});

test('an executor definition that names a build is refused when it is written',async t=>{
  const c=await setup();t.after(()=>c.close());
  for(const key of ['build','build_base']) {
    const input={...c.executor.definition,precheck_context:{product:'synthetic-product',[key]:'synthetic-build'}};
    await assert.rejects(c.registry.update(c.admin,c.executor.id,input),new RegExp(`执行器定义不带构建：删掉 precheck_context\\.${key}`));
    await assert.rejects(c.registry.add(c.admin,{...input,id:undefined}),new RegExp(`precheck_context\\.${key}`));
  }
  const kept=await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,precheck_context:{product:'synthetic-product'}});
  assert.deepEqual(kept.definition.precheck_context,{product:'synthetic-product'});
});
