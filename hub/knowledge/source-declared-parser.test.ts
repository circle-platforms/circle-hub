import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';

import type {Artifacts} from '../records/api.ts';
import {SourceLoader,type ReadableSource} from './sources.ts';
const makeLoader=()=>new SourceLoader({parsers:createDefaultRegistry(),artifacts:{} as Artifacts,external:{accepts:async()=>false,read:async id=>({ok:false,id,reason:'synthetic unread'})}},{id:'synthetic-admin',name:'合成管理员',role:'admin'},'合成声明解析');
const bytes=Buffer.from('= Synthetic manual\n\n== Chapter\n\nA synthetic paragraph with a NUL: \0 and more text.\n');
const source:ReadableSource={revision:null,artifact:{} as ReadableSource['artifact'],readTier:'model_readable',external:'svn:file:17/chapter.adoc',sha256:'a'.repeat(64),mediaType:'application/octet-stream',size:bytes.length,bytes};

test('a declared text parser handles octet-stream and counts NUL without rewriting observed media type',async()=>{
 const loader=makeLoader();
 assert.equal((await loader.parse(source)).ok,false);
 const parsed=await loader.parse(source,'text@1');assert.ok(parsed.ok,parsed.ok?'':parsed.reason);
 assert.equal(parsed.value.parser,'text@1');assert.equal(parsed.value.mediaType,'application/octet-stream');
 assert.equal((parsed.value.document.model as {nulRemoved:number}).nulRemoved,1);
 assert.ok(!(parsed.value.document.model as {lines:string[]}).lines.join('\n').includes('\0'));
 assert.ok(parsed.value.parseNote?.includes('服务器媒体类型 application/octet-stream，按来源声明以 text@1 解析'));
 assert.equal((await loader.parse(source)).ok,false,'a declared parse cannot populate the undeclared media-recognition cache');
 assert.ok((await loader.parse(source,'text@1')).ok);
});

test('declared parser lookup and parse failures never fall back to media recognition',async()=>{
 const loader=makeLoader();const plain={...source,mediaType:'text/plain'};
 const missing=await loader.parse(plain,'text@99');assert.equal(missing.ok,false);if(!missing.ok)assert.match(missing.reason,/来源声明.*text@99.*登记/);
 assert.equal((await loader.parse(plain,'json@1')).ok,false,'invalid JSON stays rejected even when ordinary text could parse');
 assert.ok((await loader.parse(plain)).ok,'the ordinary source still uses the media recognizer');
});

test('declared parser documents remain separate when server charset options differ for the same bytes',async()=>{
 const loader=makeLoader();const bytes=Buffer.from('café');
 const utf8={...source,bytes,size:bytes.length,mediaType:'text/plain; charset=utf-8'};
 const latin={...utf8,mediaType:'text/plain; charset=iso-8859-1'};
 const first=await loader.parse(utf8,'text@1');const second=await loader.parse(latin,'text@1');assert.ok(first.ok&&second.ok);
 assert.equal((await first.value.document.locate('l/1'))!.text,'café');assert.equal((await second.value.document.locate('l/1'))!.text,'cafÃ©');
 assert.equal((await (await loader.documentWith(utf8,'text@1'))!.locate('l/1'))!.text,'café');
});
