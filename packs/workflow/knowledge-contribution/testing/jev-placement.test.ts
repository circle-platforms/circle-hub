import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { main } from '../tools/jev/jev.ts';
import { fakeHub, fakeJev, entry, node, digest, MODEL, JEV_KEY, HUB_KEY, ROOT } from './servers.ts';
import { thresholdOf, maskLiterals } from '../tools/jev/lib/calibration.ts';
import { thresholdOf as referenceThreshold, maskLiterals as referenceMask } from '../../../../hub/knowledge/api.ts';
import { Judge } from '../tools/jev/lib/judge.ts';
import { LocalStore, secretGuard } from '../tools/jev/lib/local.ts';
function sampleRows(count=80){return Array.from({length:count},(_,i)=>entry('definition',`synthetic passage number ${i} has a stable marker`,i+1,'/alpha/beta'));}
async function setup(t:any,handler?:Parameters<typeof fakeJev>[0],count=80){const dir=await mkdtemp(join(tmpdir(),'jev-placement-'));t.after(()=>rm(dir,{recursive:true,force:true}));const rows=sampleRows(count);const hub=await fakeHub([node('/',[],[{name:'alpha',path:'/alpha',digest:digest(901)}]),node('/alpha',[entry('case','NEVER-SEND-CASE-DESCRIPTION',900,'/alpha')],[{name:'beta',path:'/alpha/beta',digest:digest(902)}]),node('/alpha/beta',rows)]);const jev=await fakeJev(handler);t.after(()=>hub.close());t.after(()=>jev.close());await writeFile(join(dir,'pieces.json'),JSON.stringify({pieces:[{id:'p1',reference:rows[0]!.reference}]}));return {dir,hub,jev,rows};}
async function run(s:Awaited<ReturnType<typeof setup>>,action:string,extra:string[]=[]){const out:string[]=[];const err:string[]=[];const code=await main([action,'--hub',s.hub.url,'--model',MODEL,'--base-url',s.jev.url,'--root',ROOT,'--under','/','--out','result',...extra],{cwd:s.dir,stdin:Readable.from([JEV_KEY+'\n'+HUB_KEY+'\n']),stdout:v=>out.push(v),stderr:v=>err.push(v)});return {code,out,err};}
function samples(count:number,p=0.9){return Array.from({length:count},(_,i)=>({input:digest(i+1),expected:'alpha',chosen:'alpha',probability:p}));}
async function seed(s:Awaited<ReturnType<typeof setup>>){await mkdir(join(s.dir,'result'));await writeFile(join(s.dir,'result/calibration.jsonl'),JSON.stringify({model:MODEL,chain:'placement.choice',samples:samples(80)})+'\n');}
function choiceBody(request:any,mode:string){const answers=Object.fromEntries(Object.entries(request.questions).map(([id,q]:[string,any])=>{const keys=Object.keys(q.criteria);const selected=mode==='none'?'none':keys[0]!;const probabilities=Object.fromEntries(keys.map(k=>[k,mode==='tie'?1/keys.length:k===selected?(mode==='low'?0.7:1):(mode==='low'?0.3/(keys.length-1):0)]));return [id,{type:'choice',choice:selected,confidence:1,probabilities}];}));return {model:MODEL,answers,usage:{input_tokens:1,output_tokens:1}};}
test('calibration math masking and minimum sample behavior equal retained pure rules',()=>{
 for(const values of [[],samples(29),samples(30),samples(80),[...samples(75),{input:digest(90),chosen:'beta',expected:'alpha',probability:0.5}]])assert.deepEqual(thresholdOf(values),referenceThreshold(values));
 for(const text of ['Alpha command value','中文词 Alpha ALPHA','prefixalpha alpha beta'])assert.equal(maskLiterals(text,['alpha','中文词']),referenceMask(text,['alpha','中文词']));assert.equal(thresholdOf(samples(29)).threshold,null);
});
test('calibrate dry-run sends no judgment requests and the real scripted calibration gates two descents',async t=>{
 const s=await setup(t);assert.equal((await run(s,'calibrate',['--dry-run'])).code,0);assert.equal(s.jev.requests.length,0);
 const calibrated=await run(s,'calibrate');assert.equal(calibrated.code,0,calibrated.err.join('\n'));assert.ok(s.jev.requests.length>=80);const file=(await readFile(join(s.dir,'result/calibration.jsonl'),'utf8')).trim();const set=JSON.parse(file);assert.ok(set.samples.length>=80);assert.equal(thresholdOf(set.samples).threshold,1);
 const placed=await run(s,'place',['--pieces','pieces.json']);assert.equal(placed.code,0,placed.err.join('\n'));const value=JSON.parse(await readFile(join(s.dir,'result/proposals.json'),'utf8'));assert.equal(value.items.length,1);assert.equal(value.items[0].data.path,'/alpha/beta');assert.equal(value.items[0].code,'placement_proposal');assert.match(value.items[0].text,/Jev@jev-scripted-10\.6\.0，p=1\.00/);assert.deepEqual(Object.keys(value.items[0].data).sort(),['path','root','source']);assert.ok(!JSON.stringify(s.jev.requests).includes('NEVER-SEND-CASE-DESCRIPTION'));
 const before=s.jev.requests.length;assert.equal((await run(s,'place',['--pieces','pieces.json'])).code,0);assert.equal(s.jev.requests.length,before);
});
for(const mode of ['none','tie','low','uncalibrated'])test(`placement stops with explicit ${mode} reason and no proposal`,async t=>{
 const s=await setup(t,(request)=>({body:choiceBody(request,mode)}));if(mode!=='uncalibrated')await seed(s);const value=await run(s,'place',['--pieces','pieces.json']);assert.equal(value.code,0,value.err.join('\n'));const result=JSON.parse(await readFile(join(s.dir,'result/placement.json'),'utf8'));assert.equal(result.items[0].path,null);assert.ok(result.items[0].reason);assert.equal(JSON.parse(await readFile(join(s.dir,'result/proposals.json'),'utf8')).items.length,0);
});
test('413 and max_tokens_exceeded split a failed batch into two halves once',async t=>{
 for(const status of [413,422]){const dir=await mkdtemp(join(tmpdir(),'jev-split-'));t.after(()=>rm(dir,{recursive:true,force:true}));const server=await fakeJev((_request,index)=>index===1?{status,body:{error:{code:'max_tokens_exceeded'}}}:{});t.after(()=>server.close());const store=await LocalStore.open('result',dir,secretGuard([JEV_KEY,HUB_KEY]));const judge=new Judge(MODEL,()=>JEV_KEY,server.url,store,[]);const result=await judge.ask({state:{p:'synthetic manual'},questions:{a:{type:'noul',instructions:'First `p`'},b:{type:'noul',instructions:'Second `p`'}},pieces:[]});assert.deepEqual(result.failed,[]);assert.equal(server.requests.length,3);assert.deepEqual(server.requests.map(v=>Object.keys(v.body.questions).length),[2,1,1]);}
});

test('unusable child names get stable aliases and too many children stop before judgment',async t=>{
 const {optionNames,narrowCandidates}=await import('../tools/jev/lib/placement.ts');const children=[{name:'12',path:'/12',description:'synthetic'},{name:'none',path:'/none',description:null}];assert.deepEqual([...optionNames(children).keys()],['child-1','child-2']);const many=Array.from({length:255},(_,i)=>({name:'child-'+i,path:'/child-'+i,description:null}));assert.equal(narrowCandidates(many,'unrelated synthetic content'),null);assert.equal(narrowCandidates(many,many.map(v=>v.name).join(' ')),null);
 const s=await setup(t);assert.equal((await run(s,'place',['--pieces','pieces.json','--dry-run'])).code,0);assert.equal(s.jev.requests.length,0);
});

test('place uses aliased numeric child names and refuses oversized child sets before asking',async t=>{
 for(const large of [false,true]){const dir=await mkdtemp(join(tmpdir(),'jev-child-options-'));t.after(()=>rm(dir,{recursive:true,force:true}));const source=entry('definition','unrelated synthetic passage',77,'/source');const names=large?Array.from({length:255},(_,i)=>'child-'+i):['12'];const children=[...names.map((name,i)=>({name,path:'/'+name,digest:digest(i+200)})),{name:'source',path:'/source',digest:digest(900)}];const hub=await fakeHub([node('/',[],children),...names.map(name=>node('/'+name)),node('/source',[source])]);const jev=await fakeJev();t.after(()=>hub.close());t.after(()=>jev.close());await mkdir(join(dir,'result'));await writeFile(join(dir,'result/calibration.jsonl'),JSON.stringify({model:MODEL,chain:'placement.choice',samples:samples(80)})+'\n');await writeFile(join(dir,'pieces.json'),JSON.stringify({pieces:[{id:'p',reference:source.reference}]}));const err:string[]=[];const code=await main(['place','--hub',hub.url,'--model',MODEL,'--base-url',jev.url,'--root',ROOT,'--under','/','--pieces','pieces.json','--out','result'],{cwd:dir,stdin:Readable.from([JEV_KEY+'\n'+HUB_KEY+'\n']),stdout:()=>{},stderr:v=>err.push(v)});assert.equal(code,0,err.join('\n'));const result=JSON.parse(await readFile(join(dir,'result/placement.json'),'utf8'));if(large){assert.equal(jev.requests.length,0);assert.match(result.items[0].reason,/254/);}else{assert.equal(result.items[0].path,'/12');assert.ok(Object.values(jev.requests[0]!.body.questions).some(q=>q.type==='choice'&&Object.hasOwn(q.criteria,'child-1')));}}
});
