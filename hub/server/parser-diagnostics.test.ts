import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RecordsKit } from '../records/api.ts';
import { createSkillParserRegistry } from '../refs/skills.ts';
import type { PackRegistry } from '../runs/api.ts';
import type { ServerDeps } from './api.ts';
import { callTool } from './tools.ts';

test('start and reference reads report the declared failed parser function through the real sandbox', async () => {
  const directory=await mkdtemp(join(tmpdir(),'synthetic-parser-diagnostic-'));
  try {
    await writeFile(join(directory,'parser.ts'),`export function fail(input){throw Error(Buffer.from(input.bytes,'base64').toString())}
export function parse(){const q={stream:'',units:[]};return {document:{parser:'synthetic@1',model:{},summary:{},selectors:['n/x'],properties:['n/x'],quotation:{plain:q,properties:q}}}}
export function locate(input){throw Error(Buffer.from(input.bytes,'base64').toString())}\n`);
    const row={parser:'synthetic@1',media_types:['application/x-synthetic'],limits:{maxBytes:4096,maxDepth:5,maxNodes:10},function:{module:'parser.ts',export:'fail'},locate:{module:'parser.ts',export:'locate'}};
    const opened={info:{id:'synthetic-format',version:'1.0.0',digest:'a'.repeat(64),manifest:{}},handle:{directory},declarations:{kind:'skill',skill:{parsers:[row]}}};
    const registry={installedSkills:async()=>[opened],open:async()=>opened} as unknown as PackRegistry;
    const parsers=(await createSkillParserRegistry({registry,records:{} as RecordsKit,sandbox:{requireOsIsolation:false}}).freeze!([])).parsers;
    const parser=parsers.get('synthetic@1')!;
    const source=Buffer.from('synthetic private source');
    const sha=createHash('sha256').update(source).digest('hex');
    const notes:string[]=[];
    const principal={id:'usr_01hzzzzzzzzzzzzzzzzzzzzzza',name:'synthetic',role:'user' as const};
    const call=()=>({principal,context:{traceId:'a'.repeat(32),sessionId:'synthetic',adminNote:(value:string)=>notes.push(value)},state:{method:'tools/call',tool:'',args:null,started:0,runId:null,callResult:null,acceptance:null,errorCode:null,notes:[]}}) as Parameters<typeof callTool>[1];
    const deps={records:{artifacts:{source:async()=>({bytes:source,mediaType:'application/x-synthetic',size:source.length,readTier:'model_readable'})}},knowledge:{treeReader:()=>({})},parsers,runs:{startRun:async()=>parser.parseAsync!(source)}} as unknown as ServerDeps;
    const start=await callTool(deps,call(),'start_run',{pack:'synthetic',inputs:{}});
    assert.equal(start.isError,true);
    assert.match(JSON.stringify(start.structuredContent),/SOURCE_RETRYABLE.*FUNCTION_THREW/);
    assert.match(notes.join('\n'),/解析 synthetic@1，synthetic-format@1\.0\.0\/parser\.ts#fail/);
    assert.ok(!JSON.stringify(start).includes(source.toString()));
    assert.ok(!notes.join('\n').includes(source.toString()));

    notes.length=0;row.function.export='parse';
    const read=await callTool(deps,call(),'get_nodes',{reference:`src:${sha}/synthetic@1/n/x`});
    assert.equal(read.isError,true);
    assert.match(JSON.stringify(read.structuredContent),/SOURCE_RETRYABLE.*FUNCTION_THREW/);
    assert.match(notes.join('\n'),/定位 synthetic@1，synthetic-format@1\.0\.0\/parser\.ts#locate/);
    assert.ok(!JSON.stringify(read).includes(source.toString()));
    assert.ok(!notes.join('\n').includes(source.toString()));
  } finally { await rm(directory,{recursive:true,force:true}); }
});
