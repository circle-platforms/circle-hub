import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {KnowledgePort} from '../ports.ts';
import {sha256Hex,type SourceArtifact} from '../records/api.ts';
import {SourceLoader} from './sources.ts';
import {recoverySourcesReadable} from './recovery-sources.ts';

const user={id:'synthetic-admin',name:'合成管理员',role:'admin' as const};
const bytes=Buffer.from('synthetic source');
const sha256=sha256Hex(bytes);
const artifact={digest:'a'.repeat(64),body:{sha256,size:bytes.length,visibility:{admins:true},scan:{inspected:false,clean:false,truncated:false,findings:[]}}} as unknown as SourceArtifact;

test('unscanned source admission preserves read tiers, administrator visibility and size limits',async()=>{
 const current={artifact,bytes,size:bytes.length,mediaType:'text/plain',readTier:'model_readable'};
 const loader=new SourceLoader({artifacts:{source:async()=>current}} as unknown as ConstructorParameters<typeof SourceLoader>[0],user,'合成内容策略');
 const load={ok:true as const,id:'synthetic:manual:1',revision:null,artifact};
 assert.equal((await loader.readable(load,bytes.length)).ok,true,'unscanned does not mean forbidden');
 current.readTier='retain_only';assert.equal((await loader.readable(load,bytes.length)).ok,false);
 current.readTier='function_bytes_only';assert.equal((await loader.readable(load,bytes.length)).ok,false);
 current.readTier='model_readable';assert.equal((await loader.readable(load,bytes.length-1)).ok,false);
 assert.equal((await loader.readable({...load,artifact:{...artifact,body:{...artifact.body,visibility:{...artifact.body.visibility,admins:false}}}},bytes.length)).ok,false);
});

test('unscanned recovery preserves source integrity, read permission and actual scan findings',async()=>{
 const current={artifact,bytes,size:bytes.length,readTier:'model_readable'};
 const knowledge={__context:{admin:user,records:{artifacts:{source:async()=>current}}},treeReader:()=>({hasRoot:async()=>true}),rootSources:async()=>[{sha256,artifact:artifact.digest}]} as unknown as KnowledgePort;
 const check=()=>recoverySourcesReadable(knowledge,user,'b'.repeat(64));
 assert.equal(await check(),true,'unscanned is not a credential finding');
 current.bytes=Buffer.from('changed');assert.equal(await check(),false);
 current.bytes=bytes;current.readTier='retain_only';assert.equal(await check(),false);
 current.readTier='model_readable';current.artifact={...artifact,body:{...artifact.body,scan:{...artifact.body.scan,truncated:true}}};assert.equal(await check(),false);
 current.artifact={...artifact,body:{...artifact.body,scan:{...artifact.body.scan,findings:[{kind:'basic_credential'} as never]}}};assert.equal(await check(),false);
});
