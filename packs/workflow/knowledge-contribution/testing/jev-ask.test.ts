import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { main } from '../tools/jev/jev.ts';
import { fakeHub, fakeJev, entry, node, JEV_KEY, HUB_KEY, MODEL, ROOT } from './servers.ts';
async function scratch(t:any){const dir=await mkdtemp(join(tmpdir(),'jev-skill-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
export async function run(dir:string,args:string[],keys=JEV_KEY+'\n'+HUB_KEY+'\n'){const out:string[]=[];const err:string[]=[];const code=await main(args,{cwd:dir,stdin:Readable.from([keys]),stdout:s=>out.push(s),stderr:s=>err.push(s)});return {code,out,err};}
const input=(rows:any[])=>({schema:'jev-ask@1',pieces:rows.map((v,i)=>({id:'p'+i,reference:v.reference,kind:'definition',text:'untrusted request text'})),questions:{q:{type:'noul',pieces:['p0'],instructions:'Does `p0` describe synthetic behavior?'}}});
test('ask fetches authoritative manual text logs provenance keeps credentials separate and reuses a whole request',async t=>{
 const dir=await scratch(t);const item=entry('definition','synthetic manual passage',1,'/manual');const hub=await fakeHub([node('/manual',[item])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());await writeFile(join(dir,'ask.json'),JSON.stringify(input([item])));
 const args=['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'];const first=await run(dir,args);assert.equal(first.code,0,first.err.join('\n'));assert.equal(jev.requests.length,1);assert.equal((jev.requests[0]!.body.state as Record<string,unknown>).p0,'synthetic manual passage');assert.equal(jev.requests[0]!.headers.authorization,'Bearer '+JEV_KEY);assert.ok(!JSON.stringify(jev.requests).includes(HUB_KEY));assert.ok(!JSON.stringify(hub.requests).includes(JEV_KEY));
 assert.equal((await run(dir,args)).code,0);assert.equal(jev.requests.length,1);const requests=(await readFile(join(dir,'result/requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(requests.length,2);assert.deepEqual(requests.map(v=>v.phase),['sending','completed']);assert.equal(requests[0].request_digest,requests[1].request_digest);assert.equal(requests[0].fragments[0].reference,item.reference);assert.equal(requests[0].fragments[0].bytes,Buffer.byteLength(item.statement));
 const all=JSON.stringify(first)+await Promise.all((await readdir(join(dir,'result'))).map(f=>readFile(join(dir,'result',f),'utf8'))).then(v=>v.join(''));
 for(const key of [JEV_KEY,HUB_KEY])for(let i=0;i+12<=key.length;i++)assert.ok(!all.includes(key.slice(i,i+12)));
});
for(const kind of ['case','defect','observation'])test(`default egress refuses ${kind} text before Jev and opt-in is per invocation`,async t=>{
 const dir=await scratch(t);const item=entry(kind,'RESTRICTED-'+kind+'-TEXT',2,'/restricted');const hub=await fakeHub([node('/restricted',[item])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());await writeFile(join(dir,'ask.json'),JSON.stringify(input([item])));const args=['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'];
 assert.equal((await run(dir,args)).code,1);assert.equal(jev.requests.length,0);assert.equal((await run(dir,[...args,'--send',kind])).code,0);assert.ok(JSON.stringify(jev.requests[0]).includes('RESTRICTED-'+kind+'-TEXT'));assert.equal((await run(dir,args)).code,1);assert.equal(jev.requests.length,1);
});
test('src fragments need explicit opt-in and non-model-readable content is never sent',async t=>{
 const dir=await scratch(t);const reference='src:'+'c'.repeat(64)+'/text@1/l/1';const hub=await fakeHub([],{[reference]:{text:'synthetic source'}});const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());await writeFile(join(dir,'ask.json'),JSON.stringify({schema:'jev-ask@1',pieces:[{id:'p0',reference}],questions:{q:{type:'noul',pieces:['p0'],instructions:'Judge `p0`'}}}));const args=['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'];assert.equal((await run(dir,args)).code,1);assert.equal(jev.requests.length,0);assert.equal((await run(dir,[...args,'--send','src'])).code,0);
 const blocked=await fakeHub([],{[reference]:{tier:'function_bytes_only'}});t.after(()=>blocked.close());const next=args.map(v=>v===hub.url?blocked.url:v);assert.equal((await run(dir,[...next,'--send','src'])).code,1);assert.equal(jev.requests.length,1);
});
test('bad missing placeholders extra key flags and environment-only keys never reach either service',async t=>{
 const dir=await scratch(t);const hub=await fakeHub([]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());const args=['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'];
 for(const keys of ['%JEV_API_KEY%\n'+HUB_KEY,'\n'+HUB_KEY,'invalid key\n'+HUB_KEY,JEV_KEY+'\n%HUB_TOKEN%',HUB_KEY])assert.equal((await run(dir,args,keys)).code,1);
 assert.equal((await run(dir,[...args,'--key',JEV_KEY])).code,1);assert.equal((await run(dir,args,'')).code,1);assert.equal(hub.requests.length,0);assert.equal(jev.requests.length,0);
});
test('an echoed key or 12-character run is discarded without any persisted answer or output leak',async t=>{
 const dir=await scratch(t);const item=entry('definition','synthetic manual',3,'/manual');const hub=await fakeHub([node('/manual',[item])]);const jev=await fakeJev(()=>({body:{model:MODEL,answers:{},echo:JEV_KEY.slice(3,15),usage:{input_tokens:1,output_tokens:1}}}));t.after(()=>hub.close());t.after(()=>jev.close());await writeFile(join(dir,'ask.json'),JSON.stringify(input([item])));const result=await run(dir,['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result']);assert.equal(result.code,3);await assert.rejects(readFile(join(dir,'result/judgments.jsonl')));assert.ok(!JSON.stringify(result).includes(JEV_KEY.slice(3,15)));
});
test('copied standalone skill runs outside the repository with stdin credentials',async t=>{
 const dir=await scratch(t);const item=entry('definition','synthetic standalone manual',4,'/manual');const hub=await fakeHub([node('/manual',[item])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());await cp(new URL('../tools/jev/',import.meta.url),join(dir,'skill'),{recursive:true,filter:source=>!source.endsWith('.test.ts')});await writeFile(join(dir,'ask.json'),JSON.stringify(input([item])));
 const result=await new Promise<{code:number|null;text:string}>(done=>{const child=spawn(process.execPath,[join(dir,'skill/jev.ts'),'ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'],{cwd:dir,env:{PATH:process.env.PATH}});let text='';child.stdout.on('data',v=>text+=v);child.stderr.on('data',v=>text+=v);child.on('exit',code=>done({code,text}));child.stdin.end(JEV_KEY+'\n'+HUB_KEY+'\n');});assert.equal(result.code,0,result.text);assert.ok(!result.text.includes(JEV_KEY));assert.equal(jev.requests.length,1);assert.ok(JSON.parse(await readFile(join(dir,'result/answers.json'),'utf8')).answers.q);
});

test('changing one piece only reasks its dependent batch and never sends an unselected restricted kind',async t=>{
 const dir=await scratch(t);const first=entry('definition','first synthetic manual',31,'/manual');const second=entry('behaviour','second synthetic manual',32,'/manual');const restricted=entry('defect','NEVER-EXFILTRATE-DEFECT',33,'/manual');const nodes=[node('/manual',[first,second,restricted])];const hub=await fakeHub(nodes);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());const value={schema:'jev-ask@1',pieces:[{id:'p0',reference:first.reference},{id:'p1',reference:second.reference}],questions:{a:{type:'noul',pieces:['p0'],instructions:'Judge `p0`'},b:{type:'noul',pieces:['p1'],instructions:'Judge `p1`'}}};await writeFile(join(dir,'ask.json'),JSON.stringify(value));const args=['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'];assert.equal((await run(dir,args)).code,0);assert.equal(jev.requests.length,2);first.statement='changed first synthetic manual';assert.equal((await run(dir,args)).code,0);assert.equal(jev.requests.length,3);assert.ok(!JSON.stringify(jev.requests).includes('NEVER-EXFILTRATE-DEFECT'));
});

test('environment credentials are ignored even when a complete valid invocation could otherwise run',async t=>{
 const dir=await scratch(t);const item=entry('definition','synthetic environment-boundary manual',40,'/manual');const hub=await fakeHub([node('/manual',[item])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());await writeFile(join(dir,'ask.json'),JSON.stringify(input([item])));
 const {fileURLToPath}=await import('node:url');const result=await new Promise<number|null>((done,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/jev/jev.ts',import.meta.url)),'ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result'],{cwd:dir,env:{PATH:process.env.PATH,JEV_API_KEY:JEV_KEY,HUB_TOKEN:HUB_KEY}});child.stdout.resume();child.stderr.resume();child.on('error',reject);child.on('exit',done);child.stdin.end();});assert.equal(result,1);assert.equal(hub.requests.length,0);assert.equal(jev.requests.length,0);
});

test('credentials embedded in otherwise allowed URLs or output paths are refused before any request or write',async t=>{
 const dir=await scratch(t);const hub=await fakeHub([]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());
 for(const [hubUrl,out]of [[hub.url+'/'+JEV_KEY,'result'],[hub.url,HUB_KEY]]){const result=await run(dir,['ask','--hub',hubUrl!,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out',out!]);assert.equal(result.code,1);assert.ok(!JSON.stringify(result).includes(JEV_KEY));assert.ok(!JSON.stringify(result).includes(HUB_KEY));}
 assert.equal(hub.requests.length,0);assert.equal(jev.requests.length,0);assert.deepEqual(await readdir(dir),[]);
});

test('the judged input is the declared piece, not a piece the question text mentions', async t => {
 const dir=await scratch(t);const first=entry('definition','first synthetic manual passage',41,'/manual');const second=entry('definition','second synthetic manual passage',42,'/manual');
 const hub=await fakeHub([node('/manual',[first,second])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());
 // Reproduces the retired rule: the client read the first backticked id out of the instructions and recorded that piece
 // as the judged input. Only the declared piece is sent, and only it is recorded.
 const value={schema:'jev-ask@1',pieces:[{id:'p0',reference:first.reference},{id:'p1',reference:second.reference}],questions:{q:{type:'noul',pieces:['p1'],instructions:'Does `p0` describe synthetic behavior?'}}};
 await writeFile(join(dir,'ask.json'),JSON.stringify(value));
 const result=await run(dir,['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result']);
 assert.equal(result.code,0,result.err.join('\n'));assert.equal(jev.requests.length,1);
 assert.deepEqual(Object.keys(jev.requests[0]!.body.state as Record<string,unknown>),['p1']);
 const {inputDigest}=await import('../tools/jev/lib/api.ts');
 const judgments=(await readFile(join(dir,'result/judgments.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(judgments.length,1);
 assert.equal(judgments[0].question_id,'q');
 assert.equal(judgments[0].input_digest,inputDigest(second.statement));
 assert.equal(judgments[0].state_digest,inputDigest({p1:second.statement}));
 assert.equal(judgments[0].request_id,`synthetic-request-1`);
});

test('a question whose pieces are undeclared, empty or unknown is a structural problem and nothing is sent', async t => {
 const dir=await scratch(t);const item=entry('definition','synthetic manual passage',43,'/manual');
 const hub=await fakeHub([node('/manual',[item])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());
 const questions=[{type:'noul',instructions:'Judge `p0`'},{type:'noul',pieces:[],instructions:'Judge `p0`'},{type:'noul',pieces:['p9'],instructions:'Judge `p9`'},{type:'noul',pieces:'p0',instructions:'Judge `p0`'}];
 for(const [at,question] of questions.entries()){
  await writeFile(join(dir,'ask.json'),JSON.stringify({schema:'jev-ask@1',pieces:[{id:'p0',reference:item.reference}],questions:{q:question}}));
  const result=await run(dir,['ask','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--input','ask.json','--out','result-'+at]);
  const text=result.err.join('\n');
  assert.equal(result.code,1,JSON.stringify(question)+' '+text);
  assert.match(text,/pieces/);assert.match(text,/下一步/);
 }
 assert.equal(jev.requests.length,0);
});
