import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {jobCommand} from '../server/cli-job.ts';

for(const cause of ['manifest','build','seat','acquire','connect','extra','product'] as const) {
  test(`PI16 precheck names the missing ${cause} fact and its recovery without remote values`,async t=>{
    const c=await setup({mode:cause==='acquire'?'busy':undefined,extraTools:cause==='extra'?['peek_extra']:[],alter:(name,value)=>cause==='seat' && name==='inspect_bound_seat'?{output:'version: DO_NOT_DISCLOSE_REMOTE_VALUE'}:name==='peek_extra'?{ok:false,error:'DO_NOT_DISCLOSE_REMOTE_VALUE'}:value});t.after(()=>c.close());
    const d=structuredClone(c.executor.definition);
    if(cause==='manifest') {
      const source=c.kit.artifacts.source.bind(c.kit.artifacts);
      c.kit.artifacts.source=async(...args)=>args[1]===d.manifest_sha256?null:source(...args);
    }
    if(cause==='build'){delete d.precheck_context.build;await c.registry.update(c.admin,c.executor.id,d);}
    if(cause==='extra')await c.registry.update(c.admin,c.executor.id,{...d,allowed_tools:[...d.allowed_tools,'peek_extra'],precheck_reads:[{tool:'peek_extra',arguments:{},conditions:[{pointer:'/ok',equals:true}]}]});
    if(cause==='product')c.service.options.knowledge={builds:async()=>[],resolveBuild:async()=>null};
    if(cause==='connect')await c.endpoint.close();
    const lines:string[]=[];const s={out:(s:string)=>lines.push(s),err:(s:string)=>lines.push(s),admin:async()=>c.admin,records:async()=>c.kit,hub:async()=>({dispatch:c.service,records:c.kit}),options:{},ctx:{io:{cwd:c.kit.dataDir}}};
    assert.equal(await jobCommand(s,['precheck','--executor',c.executor.id]),1);
    const text=lines.join('\n');const words={manifest:/清单/,build:/锁定构建/,seat:/synthetic-0.*version/,acquire:/租约/,connect:/连接|会话/,extra:/附加|第 1/,product:/产品/};
    assert.match(text,words[cause]);assert.match(text,/缺事实/);assert.match(text,/下一步/);assert.doesNotMatch(text,/DO_NOT_DISCLOSE_REMOTE_VALUE|synthetic-secret/);
    assert.equal(c.calls.includes('send_blob'),false);
  });
}
