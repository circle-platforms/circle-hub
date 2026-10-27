import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createSkillParserRegistry} from './skills.ts';
import {createDocumentCache} from './resolve.ts';
import type {PackRegistry} from '../runs/api.ts';
import type {RecordsKit} from '../records/api.ts';
import type {FunctionAttempt} from '../rules/sandbox/retry.ts';

// Runs the actual child sandbox. OS isolation is optional here so the same synthetic
// protocol tests run in CI where sandbox-exec is unavailable; macOS can require it.
async function fixture(run:(f:{parser:any;row:any;attempts:FunctionAttempt[]})=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'lazy-skill-test-'));
 try{
  await writeFile(join(dir,'parser.ts'),`
const doc={parser:'demo@1',model:{},summary:{},selectors:['x','y'],properties:['x','y'],quotation:{plain:{stream:'',units:[]},properties:{stream:'',units:[]}}};
export function parse(){return {document:structuredClone(doc)}}
export function legacy(){const document=structuredClone(doc);document.fragments=['x','y'].map(lookup=>({lookup,selector:lookup,text:lookup,byteRange:null}));return {document}}
export function crc(){return {error:{name:'ParseSyntaxError',crc_mismatch:true,message:'SYNTHETIC_PRIVATE_CONTENT /synthetic/private/secret'}}}
export async function fail(){await new Promise(r=>setTimeout(r,150));throw Error('synthetic failure')}
export function partial(){return {fragments:[{lookup:'x',selector:'x',text:'x',byteRange:null},{lookup:'y',selector:'y'}]}}
export function empty(){return {fragments:[]}}
export function good(input){return {fragments:input.selectors.filter(x=>x==='x'||x==='y').map(lookup=>({lookup,selector:lookup,text:lookup,byteRange:null}))}}
export function large(input){const text='a'.repeat(24*1024*1024);return {fragments:input.selectors.map(lookup=>({lookup,selector:lookup,text,byteRange:null}))}}
export function medium(input){const text='a'.repeat(10_000);return {fragments:input.selectors.map(lookup=>({lookup,selector:lookup,text,byteRange:null}))}}
`);
  const row:any={parser:'demo@1',media_types:['text/plain'],limits:{maxBytes:1024,maxDepth:5,maxNodes:10},function:{module:'parser.ts',export:'parse'},locate:{module:'parser.ts',export:'fail'}};
  const opened:any={info:{id:'demo-format',version:'1.0.0',digest:'a'.repeat(64),manifest:{}},handle:{directory:dir},declarations:{kind:'skill',skill:{parsers:[row]}}};
  const registry={installedSkills:async()=>[opened],open:async()=>opened} as unknown as PackRegistry;
  const attempts:FunctionAttempt[]=[];
  const parsers=(await createSkillParserRegistry({registry,records:{} as RecordsKit,sandbox:{requireOsIsolation:false,onAttempt:a=>attempts.push(a)}}).freeze!([])).parsers;
  await run({parser:parsers.get('demo@1'),row,attempts});
 }finally{await rm(dir,{recursive:true,force:true});}
}

test('concurrent lazy lookups share sandbox failures and do not cache null',async()=>fixture(async({parser,row,attempts})=>{
 const doc=await parser.parseAsync(Buffer.from('synthetic'));
 const before=attempts.length;
 const outcomes=await Promise.allSettled([doc.locate('x'),doc.locate('x')]);
 assert.deepEqual(outcomes.map(x=>x.status),['rejected','rejected']);
 assert.equal(attempts.length-before,1);
 row.locate.export='good';assert.equal((await doc.locate('x')).text,'x');
}));

test('a structured CRC finding has a fixed public reason without disclosing package text',async()=>fixture(async({parser,row})=>{
 row.function.export='crc';
 await assert.rejects(parser.parseAsync(Buffer.from('synthetic')),(error:Error)=>
   /CRC/.test(error.message)&&!error.message.includes('SYNTHETIC_PRIVATE_CONTENT')&&!error.message.includes('/synthetic/private'));
}));

test('a malformed response cannot commit a partial batch and a retry uses fresh output',async()=>fixture(async({parser,row,attempts})=>{
 row.locate.export='partial';const doc=await parser.parseAsync(Buffer.from('synthetic'));
 await assert.rejects(doc.prefetch(['x','y']),/结构无效/);
 const before=attempts.length;row.locate.export='good';
 assert.equal((await doc.locate('x')).text,'x');assert.equal(attempts.length-before,1);
}));

test('a listed selector omitted by locate is an error while an unlisted selector may be absent',async()=>fixture(async({parser,row})=>{
 row.locate.export='empty';const doc=await parser.parseAsync(Buffer.from('synthetic'));
 await assert.rejects(doc.locate('x'),/未返回清单中声明的片段/);
 assert.equal(await doc.locate('absent'),null);
 delete row.locate;await assert.rejects(parser.parseAsync(Buffer.from('synthetic')),/缺少 locate 声明/);
 row.function.export='legacy';const legacy=await parser.parseAsync(Buffer.from('synthetic'));
 assert.equal((await legacy.locate('x')).text,'x');assert.equal(legacy.locate('absent'),null);
}));

test('oversized sandbox output is split until valid batches succeed', {timeout:120_000},async()=>fixture(async({parser,row,attempts})=>{
 row.locate.export='large';const doc=await parser.parseAsync(Buffer.from('synthetic'));
 const before=attempts.length;await doc.prefetch(['x','y','unlisted']);
 assert.ok(attempts.length-before>=3);assert.equal((await doc.locate('x')).text.length,24*1024*1024);
 assert.equal((await doc.locate('unlisted')).text.length,24*1024*1024);
}));


test('separate lazy lookups share the request deadline', {timeout:10_000},async()=>fixture(async({parser,row,attempts})=>{
 row.locate.export='good';const doc=await parser.parseAsync(Buffer.from('synthetic'));
 const cache=createDocumentCache(2,16*1024*1024,1000);cache.set('synthetic',doc);
 assert.equal((await doc.locate('x')).text,'x');
 await new Promise(resolve=>setTimeout(resolve,1100));
 const before=attempts.length;
 await assert.rejects(doc.locate('y'),(error:any)=>error.code==='SANDBOX_TIMEOUT'&&error.detail.limit==='operation');
 assert.equal(attempts.length,before,'expired request must not launch another sandbox');
 cache.dispose?.();
}));

test('overlapping HTML ranges split when their aggregate exceeds the sandbox limit', {timeout:120_000},async()=>{
 const {fileURLToPath}=await import('node:url');
 const directory=fileURLToPath(new URL('../../packs/skill/html-format/',import.meta.url));
 const row={parser:'html@1',media_types:['text/html'],limits:{maxBytes:16*1024*1024,maxDepth:256,maxNodes:1_000_000,maxAttributes:512},function:{module:'functions/parse.ts',export:'default'},locate:{module:'functions/parse.ts',export:'locate'}};
 const opened:any={info:{id:'html-format',version:'1.0.0',digest:'a'.repeat(64),manifest:{}},handle:{directory},declarations:{kind:'skill',skill:{parsers:[row]}}};
 const attempts:FunctionAttempt[]=[];
 const registry={installedSkills:async()=>[opened],open:async()=>opened} as unknown as PackRegistry;
 const parsers=(await createSkillParserRegistry({registry,records:{} as RecordsKit,sandbox:{requireOsIsolation:false,onAttempt:a=>attempts.push(a)}}).freeze!([])).parsers;
 const parser=parsers.get('html@1')!;
 const bytes=Buffer.from('<html><body>'+Array.from({length:1200},(_,i)=>`<p>${i} ${'x'.repeat(760)}</p>`).join('')+'</body></html>');
 const doc=await parser.parseAsync!(bytes);assert.equal(typeof doc.prefetch,'function');
 const ranges=Array.from({length:100},(_,i)=>`b/0-${1199-i}`);
 const before=attempts.length;await doc.prefetch!(ranges);
 assert.ok(attempts.length-before>=3,'oversized first batch must be split');
 for(const selector of ranges)assert.ok((await doc.locate(selector))?.text.length);
});


test('cache budget refusal leaves no new fragments and cancels queued batches', {timeout:20_000},async()=>fixture(async({parser,row,attempts})=>{
 row.locate.export='medium';const doc=await parser.parseAsync(Buffer.from('synthetic'));
 const cache=createDocumentCache(2,1024*1024,10_000);cache.set('synthetic',doc);
 const selectors=Array.from({length:300},(_,i)=>`v${i}`);
 const before=attempts.length;
 await assert.rejects(doc.prefetch(selectors),(error:any)=>error.code==='SANDBOX_OUTPUT_TOO_LARGE'&&error.detail.limit==='document_cache_bytes');
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(attempts.length-before,1,'a failed first batch must stop all queued batches');
 await assert.rejects(doc.locate('v0'),(error:any)=>error.code==='SANDBOX_OUTPUT_TOO_LARGE');
 assert.equal(attempts.length-before,1,'a rejected batch must not appear as a cache hit');
 cache.dispose?.();
}));

test('a failed sandbox or malformed batch cancels that request\'s queued work but allows explicit retry', {timeout:20_000},async()=>{
 for(const mode of ['fail','partial'])await fixture(async({parser,row,attempts})=>{
  row.locate.export=mode;const doc=await parser.parseAsync(Buffer.from('synthetic'));
  const selectors=Array.from({length:300},(_,i)=>`v${i}`);
  const before=attempts.length;
  await assert.rejects(doc.prefetch(selectors));
  row.locate.export='medium';
  assert.equal((await doc.locate('v256')).text.length,10_000,`${mode}: an immediate explicit retry should launch a fresh batch`);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(attempts.length-before,2,`${mode}: queued second batch must never start`);
 });
});

test('a failed shared pending lookup also cancels new queued selectors in its waiting request', {timeout:20_000},async()=>fixture(async({parser,row,attempts})=>{
 row.locate.export='fail';const doc=await parser.parseAsync(Buffer.from('synthetic'));
 const before=attempts.length;
 const first=doc.locate('x');
 const second=doc.prefetch(['x','extra']);
 const outcomes=await Promise.allSettled([first,second]);
 assert.deepEqual(outcomes.map(x=>x.status),['rejected','rejected']);
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(attempts.length-before,1,'waiting request must not start its new selector after shared failure');
 row.locate.export='medium';assert.equal((await doc.locate('extra')).text.length,10_000);
}));
