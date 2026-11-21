// The quotation check of the Hub (quote@1, the check expected_quotes) run by the plan check: a quote whose text is not in the entry its
// reference reads is refused here as the Hub refuses it, with the words of the Hub first and then the place in the plan, the reference
// cited and what it reads, and where the text stands. Round 37 (2026-11-17): all three plans passed check-plan and Plumb, and the Hub
// refused the DNSSEC plan because each of three sentences was cited with the reference of the entry beside the one that holds it.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {checkPlanObject,main} from './check-plan.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {lockedTreeOf,nodesText,RUN,type FlatCatalog} from '../testing/locked-tree.ts';
import {knowledgeFiles} from '../functions/knowledge-text.ts';
import {fixture,positiveBlocks,quote as blockQuote} from '../testing/blocks.ts';
import {APPENDIX,CHAPTER,ECHOED,FLAGS_INTRO,HOST_ROW,HOST_SIGNED,MANUAL,PUBLISH,REPEATED,SIGN,manualReference} from '../testing/manual-fixture.ts';

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const f=fixture();
const ROOT=f.catalog.root;
const CATALOG:FlatCatalog={...(f.catalog as unknown as FlatCatalog),manual:MANUAL};
const ref=(words:readonly string[],statement:string)=>manualReference(ROOT,words,statement);
const run=()=>frozenRun({groups:[{kind:'case-compile',contract:f.contractDoc,profile:f.profileDoc,manifest:f.inventory,manifest_sha256:f.manifest_sha256,leases:LEASES}],items:[{id:'synthetic-case',label:'合成用例',location:'src:'+'a'.repeat(64)+'/kityminder@1/n/expected',fields:f.fields}],root:ROOT,command_policy:(f.catalog as {policy:unknown}).policy});
/** The block plan of the pack's sample (configure, observe, clean up) whose causal links carry the given quotes, in the order given. */
const planOf=(quotes:Array<{reference:string;text:string}>)=>{
 const data=positiveBlocks().CONFIG;
 data.block_context!.causal_links=quotes.map(quote=>({from:'configure',to:'observe',quote}));
 return {item:'synthetic-case',handling:'handled',slots:{plan:[{text:'合成块计划',quotes:[blockQuote()],data}]}};
};
const check=(quotes:Array<{reference:string;text:string}>)=>checkPlanObject('plan.json',planOf(quotes),run(),lockedTreeOf(CATALOG));
const quotesOf=(result:ReturnType<typeof check>)=>result.problems.filter(row=>row.code==='QUOTE_MISMATCH');
const HUB_WORDS='原文与引用对不上（T03 整份不受理之一）：';

test('a quote the entry it cites holds passes, and the plan check says it ran the Hub\'s quotation check',()=>{
 const result=check([{reference:ref(CHAPTER,PUBLISH),text:PUBLISH},{reference:ref(CHAPTER,HOST_ROW),text:'该参数指定一个已存在的演示域名。'}]);
 assert.deepEqual(result.problems,[],JSON.stringify(result.problems));assert.equal(result.ok,true);
 const row=result.hub_checks!.find(value=>value.check==='expected_quotes')!;assert.equal(row.ran,true,JSON.stringify(row));
 // The one quote this machine does not read is the frozen item's own declaration of the expectation: named as the item's, not as a place of the plan.
 assert.deepEqual(row.unread!.map(value=>value.pointer),['冻结条目的 /fields/expected_nodes/0'],JSON.stringify(row));
 assert.match(result.disclosure!,/expected_quotes/);
});

test('the quotes the claim itself carries are the Hub\'s own step when it takes a submission: the plan check says it does not run it, and says nothing when the claim has none',()=>{
 const withQuotes=check([{reference:ref(CHAPTER,PUBLISH),text:PUBLISH}]);
 assert.match(withQuotes.disclosure!,/计划记录自己写的 quotes（1 条）由 Hub 受理提交时另外逐条核对，原文不在所引片段里会整份不受理；这里没有核这一步，以提交回执为准/);
 const plan=planOf([{reference:ref(CHAPTER,PUBLISH),text:PUBLISH}]);delete (plan.slots.plan[0] as Record<string,unknown>).quotes;
 const without=checkPlanObject('plan.json',plan,run(),lockedTreeOf(CATALOG));
 assert.equal(without.ok,true);assert.ok(!without.disclosure!.includes('计划记录自己写的 quotes'),without.disclosure);
});

test('the sentence of one entry cited with the reference of the entry beside it is refused with the Hub\'s words and the reference that holds it (round 37)',()=>{
 const neighbour=ref(CHAPTER,HOST_ROW),right=ref(CHAPTER,PUBLISH);
 const result=check([{reference:neighbour,text:PUBLISH}]);
 const [own,...rest]=quotesOf(result);assert.ok(own,JSON.stringify(result.problems));assert.deepEqual(rest,[]);
 assert.equal(result.ok,false);assert.equal(own.verdict,'refute');
 assert.equal(own.pointer,'/block_context/causal_links/0/quote/reference','the field to change is the reference');
 assert.ok(own.message.startsWith(`${HUB_WORDS}所引片段里没有 “${PUBLISH}”`),own.message);
 assert.ok(own.message.includes('位置：/slots/plan/0/data/block_context/causal_links/0/quote/reference'),own.message);
 assert.ok(own.message.includes(neighbour)&&own.message.includes(HOST_ROW),`the reference cited and what it reads: ${own.message}`);
 assert.ok(own.message.includes(`这句原文在 ${right}`)&&own.message.includes('把 reference 改成它'),own.message);
 assert.ok(!own.message.includes(neighbour+'（'),'the cited reference is not offered back');
});

test('the same sentence at several places is refused at each, and several entries that hold it are all named, the chapter of the cited entry first',()=>{
 const neighbour=ref(CHAPTER,HOST_ROW),chapter=ref(CHAPTER,ECHOED),appendix=ref(APPENDIX,REPEATED);
 const result=check([{reference:neighbour,text:ECHOED},{reference:chapter,text:ECHOED},{reference:neighbour,text:ECHOED}]);
 assert.deepEqual(quotesOf(result).map(row=>row.pointer),['/block_context/causal_links/0/quote/reference','/block_context/causal_links/2/quote/reference']);
 const own=quotesOf(result)[0];
 assert.ok(own.message.includes(`允许：${chapter}`)&&own.message.includes(appendix),own.message);
 assert.ok(own.message.indexOf(chapter)<own.message.indexOf(appendix),'the entry of the cited chapter comes first');
 assert.ok(own.message.includes('这句原文在上面允许的 2 处；把 reference 改成其中一处'),own.message);
});

test('a sentence that stands in no entry is refused and told it has to be copied from the knowledge, with the reference left alone',()=>{
 const cited=ref(CHAPTER,SIGN),made=SIGN.replace('合成签名','合成的签名');
 const result=check([{reference:cited,text:made}]);
 const [own]=quotesOf(result);assert.ok(own,JSON.stringify(result.problems));
 assert.equal(own.pointer,'/block_context/causal_links/0/quote/text','nothing else holds the text: the text is what has to change');
 assert.ok(own.message.startsWith(`${HUB_WORDS}所引片段里没有 “${made}”`),own.message);
 assert.ok(own.message.includes('这份下载里没有一处逐字含这句话')&&own.message.includes('逐字取自冻结知识'),own.message);
 assert.ok(!own.message.includes('把 reference 改成它'),own.message);
});

test('the other refusals of the Hub\'s quotation check are the Hub\'s: a reference that is no reference, one of another root, an entry the tree does not have, a standalone entry and an empty quote',()=>{
 const good=ref(CHAPTER,PUBLISH),elsewhere=good.replace(ROOT,'e'.repeat(64)),missing=good.replace(/@[0-9a-f]{64}$/,'@'+'c'.repeat(64));
 const result=check([
  {reference:good.replace('Widget%20Signing','Widget Signing'),text:PUBLISH},
  {reference:elsewhere,text:PUBLISH},
  {reference:missing,text:PUBLISH},
  {reference:'entry:'+'d'.repeat(64),text:PUBLISH},
  {reference:good,text:'   '},
 ]);
 const words=quotesOf(result).map(row=>row.message.split('；位置：')[0]);
 assert.deepEqual(words,[
  `${HUB_WORDS}引用写法不对，请使用 src:<摘要>、tree:<根>/<路径>@<条目> 或 rec:<记录>#/<字段>`,
  `${HUB_WORDS}引用 ${elsewhere} 的源文件不是这次运行的输入，请改引本运行已绑定的输入（src:<摘要> 或 tree:<锁定根>/<路径>@<条目>）`,
  `${HUB_WORDS}引用 ${missing} 的片段不存在`,
  `${HUB_WORDS}知识条目不能单独作根据（B01 R[5]），请改写为 tree:<根>/<路径>@<条目>`,
  `${HUB_WORDS}引文为空`,
 ]);
});

test('a flagged status line and an introduction beside each other: the three sentences of round 37 are each refused with the entry that holds them',()=>{
 const result=check([{reference:ref(CHAPTER,HOST_ROW),text:SIGN},{reference:ref(CHAPTER,HOST_ROW),text:PUBLISH},{reference:ref(CHAPTER,FLAGS_INTRO),text:HOST_SIGNED}]);
 const rows=quotesOf(result);assert.equal(rows.length,3,JSON.stringify(result.problems));
 for(const [index,[statement,words]] of ([[SIGN,CHAPTER],[PUBLISH,CHAPTER],[HOST_SIGNED,CHAPTER]] as const).entries())assert.ok(rows[index].message.includes(`这句原文在 ${ref(words,statement)}`),rows[index].message);
});

/** What `main` writes to stdout and stderr and the code it returns. */
async function runCli(argv:string[]):Promise<{code:number;stdout:string;stderr:string}>{
 const out:string[]=[],err:string[]=[],stdoutWrite=process.stdout.write.bind(process.stdout),stderrWrite=process.stderr.write.bind(process.stderr);
 process.stdout.write=((chunk:string|Uint8Array)=>{out.push(String(chunk));return true;}) as typeof process.stdout.write;
 process.stderr.write=((chunk:string|Uint8Array)=>{err.push(String(chunk));return true;}) as typeof process.stderr.write;
 try{return {code:await main(argv),stdout:out.join(''),stderr:err.join('')};}finally{process.stdout.write=stdoutWrite;process.stderr.write=stderrWrite;}
}

test('from a run download the refusal says which lines of knowledge/manual.txt the entry stands on, and says nothing of lines when the file is not there',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'plan-quote-lines-'));
 try{
  // The download the way download-run.ts leaves it: run.json, knowledge/nodes.jsonl and the text files rendered from it.
  const bytes=Buffer.from(nodesText(CATALOG,RUN));
  const files=knowledgeFiles(bytes,RUN).outputs;
  await mkdir(join(dir,'knowledge'));
  for(const file of files)await writeFile(join(dir,file.name),file.bytes);
  await writeFile(join(dir,'run.json'),JSON.stringify(run()));
  const planFile=join(dir,'plan.json');
  await writeFile(planFile,JSON.stringify(planOf([{reference:ref(CHAPTER,HOST_ROW),text:PUBLISH},{reference:ref(CHAPTER,FLAGS_INTRO),text:HOST_SIGNED}])));
  const refused=await runCli(['--file',planFile,'--run',dir]);
  assert.equal(refused.code,1,refused.stderr);
  const report=JSON.parse(refused.stdout) as {ok:boolean;problems:Array<{code:string;pointer:string;message:string}>;hub_checks:Array<{check:string;ran:boolean}>};
  assert.equal(report.ok,false);assert.equal(report.hub_checks.find(row=>row.check==='expected_quotes')!.ran,true);
  const quotes=report.problems.filter(row=>row.code==='QUOTE_MISMATCH');assert.equal(quotes.length,2,JSON.stringify(report.problems));
  // The lines are counted in the file as written: the heading line `· 引用 <reference>`, then the statement.
  const text=Buffer.from(files.find(file=>file.name==='knowledge/manual.txt')!.bytes).toString('utf8').split('\n');
  for(const [problem,statement] of [[quotes[0]!,PUBLISH],[quotes[1]!,HOST_SIGNED]] as const){
   const at=text.findIndex(line=>line.startsWith(`· 引用 ${ref(CHAPTER,statement)}`))+1;assert.ok(at>1,statement);
   assert.equal(text[at],statement,'the statement is the line under the heading');
   assert.ok(problem.message.includes(`${ref(CHAPTER,statement)}（knowledge/manual.txt 第 ${at}-${at+1} 行）；把 reference 改成它`),problem.message);
  }
  // The stderr line names the first problems with their pointers, as for every refused plan.
  assert.ok(refused.stderr.includes('/block_context/causal_links/0/quote/reference:'),refused.stderr);
  // The same plan against a download that has no text files: the entry is named, no line is made up.
  await rm(join(dir,'knowledge','manual.txt'));await rm(join(dir,'knowledge','commands.txt'));
  const bare=JSON.parse((await runCli(['--file',planFile,'--run',dir])).stdout) as typeof report;
  const own=bare.problems.filter(row=>row.code==='QUOTE_MISMATCH')[0]!;
  assert.ok(own.message.includes(`这句原文在 ${ref(CHAPTER,PUBLISH)}；把 reference 改成它`)&&!own.message.includes('第 '),own.message);
 }finally{await rm(dir,{recursive:true,force:true});}
});
