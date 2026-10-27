import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recognize, type ParseError} from '../refs/api.ts';
import type {Artifacts} from '../records/api.ts';
import {SourceLoader,type ReadableSource} from './sources.ts';

test('sync source parsing preserves the core refusal and executable fix without raw input',async()=>{
 const parsers=createDefaultRegistry();
 const bytes=new TextEncoder().encode('{"value":SyntheticPrivateJsonFragment}');
 let rejected:ParseError|undefined;
 assert.equal(recognize(parsers,bytes,'application/json',{},error=>{rejected=error;}),null);
 assert.ok(rejected);
 const loader=new SourceLoader({parsers,artifacts:{} as Artifacts,external:{accepts:async()=>false,read:async id=>({ok:false,id,reason:'合成未读取'})}},{id:'synthetic-admin',name:'合成管理员',role:'admin'},'合成同步');
 const source={external:'site:document:synthetic',sha256:'a'.repeat(64),mediaType:'application/json',size:bytes.length,bytes} as ReadableSource;
 const result=await loader.parse(source);assert.equal(result.ok,false);
 if(result.ok)return;
 assert.ok(result.reason.includes(rejected.message));assert.ok(result.reason.includes(rejected.parser));
 if(rejected.fix)assert.ok(result.reason.includes(rejected.fix));
 assert.ok(!result.reason.includes('SyntheticPrivateJsonFragment'));
});
