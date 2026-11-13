import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { recoverRead } from './recover-read.ts';

const user={id:'usr_01hzzzzzzzzzzzzzzzzzzzzzza',name:'synthetic',role:'user' as const};
const trace='1'.repeat(32),at='2035-01-01T00:00:00.000Z',bytes=Buffer.from('合成原文'),sha=sha256Hex(bytes);
test('source reply recovery requires current access, the same tier and clean source captures',async()=>{
  let allowed=true,tier='model_readable',clean=true;
  const artifact={body:{scan:{inspected:true,truncated:false,findings:[] as unknown[]}}};
  const deps={records:{artifacts:{source:async()=>allowed?{bytes:tier==='retain_only'?null:bytes,size:bytes.length,mediaType:'text/plain',readTier:tier}:null,records:async()=>[{body:{scan:{...artifact.body.scan,findings:clean?[]:[{}]}}}]}},knowledge:{},runs:{}} as unknown as ServerDeps;
  const args={reference:`src:${sha}`},answer={call_result:'ok',errors:[],trace,content:{reference:args.reference,read_tier:'model_readable',readable:true,text:'合成原文'}};
  const recovered=await recoverRead(deps,user,args,answer,trace,at);assert.equal(recovered?.content?.text,'合成原文');assert.match(recovered!.content!.note!,/历史快照/);
  allowed=false;assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);
  allowed=true;tier='retain_only';assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);
  tier='model_readable';clean=false;assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);
});

test('a tree reply is recovered only while its root, source captures and dynamic records remain readable',async()=>{
  const root='a'.repeat(64),contribution='c'.repeat(64),feeding='d'.repeat(64),sourceRecord='e'.repeat(64);
  let rootAllowed=true,sourceAllowed=true,held=false,withdrawn=false;
  const scan={inspected:true,truncated:false,findings:[]};
  const source=async()=>sourceAllowed?{bytes,size:bytes.length,sha256:sha,readTier:'model_readable',artifact:{body:{scan}}}:null;
  const deps={records:{artifacts:{source}},knowledge:{__context:{admin:user,records:{artifacts:{source}}},treeReader:()=>({hasRoot:async()=>rootAllowed}),rootSources:async()=>[{sha256:sha,artifact:sourceRecord}],layers:{contributions:{readView:async()=>({record:contribution,status:held?'credential_unreadable':'valid',contribution:{}})}},feeding:{recordState:async()=>({validity:withdrawn?'invalid':'valid'})}},runs:{}} as unknown as ServerDeps;
  const args={root,paths:['/synthetic'],depth:0};
  const answer={call_result:'ok',errors:[],trace,root,nodes:[{path:'/synthetic',reference:`tree:${root}/synthetic`,name:'合成节点',level:'leaf',digest:'f'.repeat(64),children:[],entries:[],contributions:[{record:contribution,status:'valid',note:'合成引用'}],feeding_objects:[{object:'b'.repeat(64),reference:`rec:${feeding}`}]}],coverage:{complete:true,examined:1,total:1}};
  const recovered=await recoverRead(deps,user,args,answer,trace,at);assert.equal(recovered?.nodes?.[0].name,'合成节点');assert.match(recovered!.coverage!.note!,/历史快照/);
  rootAllowed=false;assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);rootAllowed=true;
  sourceAllowed=false;assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);sourceAllowed=true;
  held=true;assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);held=false;
  withdrawn=true;assert.equal(await recoverRead(deps,user,args,answer,trace,at),null);
});
