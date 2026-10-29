import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {livePids} from '../../../../hub/rules/sandbox/sandbox.ts';
import {residentSizes,residentTreeSizes} from '../../../../hub/rules/sandbox/resident.ts';
import {osIsolationAvailable} from '../../../../hub/rules/sandbox/isolation.ts';
import {createSkillParserRegistry} from '../../../../hub/refs/skills.ts';
import {createDocumentCache} from '../../../../hub/refs/resolve.ts';
import {parseDocument, QUOTATION_UNITS} from '../../../../hub/refs/parser.ts';
import type {PackRegistry} from '../../../../hub/runs/api.ts';
import type {RecordsKit} from '../../../../hub/records/api.ts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const packDir=fileURLToPath(new URL('../',import.meta.url));
// Portable synthetic tests run where OS isolation is absent as well. Where it is
// available (sandbox-exec on macOS, bubblewrap with AppArmor on Linux) the
// wrapper still enables it and reports osIsolation.

type Shape={name:string;bytes:Buffer;minElements:number};
function deepAttributes():Shape {
 const row=(i:number)=>`<item name="cmd_${i}" help_string="synthetic command" user_level="view" lock="none" func="do"/>`;
 const lines:string[]=[];let size=0;
 for(let i=0;size<2_100_000;i++){const x=row(i);lines.push(x);size+=Buffer.byteLength(x);}
 const names=Array.from({length:15},(_,i)=>'synthetic_section_'+i);
 return {name:'deep attributes',bytes:Buffer.from('<commands>'+names.map(n=>`<${n}>`).join('')+lines.join('')+[...names].reverse().map(n=>`</${n}>`).join('')+'</commands>'),minElements:20_000};
}
function richAttributes():Shape {
 const row=(i:number)=>`<item name="demo_${i}" help_string="synthetic control instruction for a sample value" user_level="view" lock="none" func="synthetic_action"><arguments><arg name="address" type="IPV4" help_string="synthetic endpoint"/><arg name="count" type="U32" help_string="synthetic count"/></arguments></item>`;
 const lines:string[]=[];let size=0;
 for(let i=0;size<2_100_000;i++){const x=row(i);lines.push(x);size+=Buffer.byteLength(x);}
 return {name:'rich attributes',bytes:Buffer.from('<commands><menu name="demo">'+lines.join('')+'</menu></commands>'),minElements:20_000};
}
function deepText():Shape {
 const names=Array.from({length:40},(_,i)=>'layer'+i);
 return {name:'deep long text',bytes:Buffer.from('<r>'+names.map(n=>`<${n}>`).join('')+'x'.repeat(2_050_000)+'<z/>'.repeat(20_000)+[...names].reverse().map(n=>`</${n}>`).join('')+'</r>'),minElements:20_000};
}

function monitor(){
 let childPeak=0,totalPeak=0,rounds=0,active:Promise<void>|undefined;
 const sample=()=>{
  if(active)return;
  const pids=livePids();
  // Each child's whole process tree, as the sandbox's own watchdog measures it: under bubblewrap the
  // child is bubblewrap, and Node runs below it in a PID namespace (resident.ts).
  active=Promise.all([residentTreeSizes(pids),residentSizes([process.pid])]).then(([trees,own])=>{
   const child=pids.reduce((sum,pid)=>{const bytes=trees.get(pid);return sum+(typeof bytes==='number'&&bytes>0?bytes:0);},0);
   childPeak=Math.max(childPeak,child);totalPeak=Math.max(totalPeak,child+(own.get(process.pid)??0));rounds++;
  }).finally(()=>{active=undefined;});
 };
 const timer=setInterval(sample,25);
 return async()=>{clearInterval(timer);await active;return {childPeak,totalPeak,rounds};};
}
for(const [label,make] of [['deep attributes',deepAttributes],['rich attributes',richAttributes],['deep long text',deepText]] as const)test(`XML sandbox bound: ${label}`,{timeout:30_000},async()=>{
 const {name,bytes,minElements}=make();
 assert.ok(bytes.length>=2_000_000);
 const osIsolation=await osIsolationAvailable();
 const stop=monitor(),started=performance.now();
 try {
 // A stub registry supplies an installed package; parsing and locating use the
 // same sandbox wrapper, wire hydration, and operation cache as production.
 const skill=JSON.parse(await readFile(join(packDir,'skill.json'),'utf8'));
 const digest='a'.repeat(64);
 const opened={info:{id:'xml-format',version:'1.0.3',digest,manifest:{}},declarations:{kind:'skill',skill},handle:{directory:packDir}};
 const registry={installedSkills:async()=>[opened],open:async()=>opened} as unknown as PackRegistry;
 let output=0;
 const attempts:number[]=[];
 // Measuring output entails JSON.stringify, adding transient memory and time.
 const parsers=createSkillParserRegistry({registry,records:{} as RecordsKit,sandbox:{requireOsIsolation:false,onAttempt:attempt=>attempts.push(attempt.durationMs)},onWireOutput:bytes=>{output=bytes;}});
 await parsers.refresh!();
 const parser=parsers.get('xml@1');assert.ok(parser);
 const beforeParse=process.memoryUsage().rss;
 const document=await parseDocument(parser,bytes);
 const parseMs=performance.now()-started;
 const selectors=document.listSelectors(''),properties=document.listSelectors('',{properties:true});
 assert.ok((document.summary().elements as number)>=minElements && selectors.length>=minElements);
 assert.ok(output>0 && output<=24*1024*1024,`${name}: ${output} bytes`);
 const first=selectors[0],last=selectors.at(-1)!;
 const quotation=document as typeof document & {[QUOTATION_UNITS]:(options:{properties:boolean})=>{units:unknown[]}};
 console.log('XML_HYDRATE_METRICS '+JSON.stringify({name,estimated:document.retainedBytes?.(),beforeParse,afterParse:process.memoryUsage().rss,selectorChars:selectors.reduce((n,s)=>n+s.length,0),propertyChars:properties.reduce((n,s)=>n+s.length,0),plainUnits:quotation[QUOTATION_UNITS]({properties:false}).units.length,propertyUnits:quotation[QUOTATION_UNITS]({properties:true}).units.length}));
 const cache=createDocumentCache(32);
 cache.set('synthetic',document);
 assert.equal(cache.get('synthetic'),document);
 await document.prefetch?.([first,last]);
 assert.ok(await document.locate(first));assert.ok(await document.locate(last));
 const fullMs=performance.now()-started;
 const rss=await stop();
 assert.ok(rss.rounds>0 && rss.childPeak>0,'sandbox child memory was sampled');
 // Node parsing 2 MB holds far more than 64 MiB; a few MiB would be the launcher's own size, not Node's.
 assert.ok(rss.childPeak>64*1024*1024,`${name}: child peak ${rss.childPeak} is not Node's`);
 // Leave 32 MiB of sampled headroom below the sandbox's 448 MiB RSS watchdog.
 assert.ok(rss.childPeak<416*1024*1024,`${name}: child peak ${rss.childPeak}`);
 // Includes this test process, live sandbox children and earlier shapes' retained
 // V8 pages; this is a sampled process total, not a promise about all Hub traffic.
 assert.ok(rss.totalPeak<1152*1024*1024,`${name}: total peak ${rss.totalPeak}`);
 assert.ok(attempts.length===2 && attempts[0]<3_000,`${name}: parse sandbox ${attempts[0]} ms`);
 assert.ok(parseMs<5_000 && fullMs<10_000,`${name}: elapsed ${fullMs} ms`);
 console.log('XML_SANDBOX_METRICS '+JSON.stringify({name,input:bytes.length,output,parseSandboxMs:attempts[0],parseMs:Math.round(parseMs),fullMs:Math.round(fullMs),osIsolation,...rss}));
 } finally { await stop(); }
});
