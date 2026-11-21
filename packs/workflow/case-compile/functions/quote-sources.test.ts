// The quotation check the plan check runs (functions/quote-sources.ts) beside the core's own: the reference grammar and the verdicts of
// quote@1 over the same texts, a quote against the Hub's interpreter and its reference resolution on one tree, the shared vectors of the
// verbatim rule, and the places of a plan the Hub hands to quote@1 against the schema's own list of quotes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe,test} from 'node:test';
import {PROTOCOL_CODES} from '../../../../contracts/generated/protocol.ts';
import {ReferenceUri} from '../../../../contracts/src/reference.ts';
import {createDefaultRegistry,parseReference,resolveReference} from '../../../../hub/refs/api.ts';
import {getInterpreter,quoteMatches as hubQuoteMatches,type CheckRequest} from '../../../../hub/rules/api.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {lockedTreeOf,treeLines,type FlatCatalog} from '../testing/locked-tree.ts';
import {fixture,positiveBlocks} from '../testing/blocks.ts';
import {treeReaderOf} from '../testing/manual-tree.ts';
import {APPENDIX,CHAPTER,ECHOED,FLAGS_INTRO,HOST_ROW,HOST_SIGNED,MANUAL,PUBLISH,REPEATED,SIGN,manualReference} from '../testing/manual-fixture.ts';
import {checkInput} from './plan-boundary.ts';
import {quoteMatches} from './quote.ts';
import {QUOTE_MISMATCH_WHEN,frozenQuoteView,frozenSourceTexts,isReferenceUri,quoteVerdicts,treeAddress,type QuoteView} from './quote-sources.ts';
import {quotePlaces,quoteSubject,type QuotePlace} from './subject.ts';
import {COMMAND_CATALOG,CONTRACT_DOC,MANIFEST_DOC,PROFILE_DOC,QUOTE,goodData} from './test-support.ts';
import {isRecord} from './text.ts';

const f=fixture(),ROOT=f.catalog.root;
const CATALOG:FlatCatalog={...(f.catalog as unknown as FlatCatalog),manual:MANUAL};
const LINES=treeLines(CATALOG);
const TREE=lockedTreeOf(CATALOG);
const ref=(words:readonly string[],statement:string)=>manualReference(ROOT,words,statement);
const reader={user:'usr_synthetic',role:'user' as const};

describe('the words the plan check shares with the interpreter',()=>{
  test('the description of the code every statement starts with is the registered one',()=>{
    assert.equal(QUOTE_MISMATCH_WHEN,PROTOCOL_CODES.QUOTE_MISMATCH.when);
  });
});

describe('the verbatim rule is the core\'s, on the vectors both share',()=>{
  const vectors=(JSON.parse(readFileSync(new URL('../../../../hub/rules/quote-vectors.json',import.meta.url),'utf8')) as {vectors:Array<{note:string;fragment:string;quote:string;match:boolean}>}).vectors;
  for(const vector of vectors)test(`${vector.note}`,()=>{
    assert.equal(quoteMatches(vector.fragment,vector.quote),vector.match,'the pack\'s rule');
    assert.equal(hubQuoteMatches(vector.fragment,vector.quote),vector.match,'the core\'s rule');
  });
  test('they agree on white space of every kind, an unpaired surrogate and the strings around them',()=>{
    const pieces=['',' ','\n','\t','　',' ','​','a','中','\ud800','é','é','😀'];
    for(const fragment of pieces.flatMap(a=>pieces.map(b=>a+b)))for(const quote of pieces.flatMap(a=>pieces.map(b=>a+b)))assert.equal(quoteMatches(fragment,quote),hubQuoteMatches(fragment,quote),JSON.stringify([fragment,quote]));
  });
});

describe('a reference is read as the core reads it',()=>{
  const good=ref(CHAPTER,PUBLISH);
  const corpus=[
    good,good.replace('Widget%20Signing','Widget Signing'),good.replace('%20','%2f'),good.replace('%20','%2F'),good.replace('%20','%41'),good.replace('%20','%c2'),good.replace('演示服务（DEMO）','%E6%BC%94%E7%A4%BA%E6%9C%8D%E5%8A%A1%EF%BC%88DEMO%EF%BC%89'),
    good.replace('%20','%'),good.replace('%20','%4'),good.replace('%20','%ZZ'),good.replace('/manual/','//manual/'),good.replace(/@[0-9a-f]{64}$/,''),good.replace(/@[0-9a-f]{64}$/,'@'),good.replace(/@[0-9a-f]{64}$/,'@'+'A'.repeat(64)),
    good.replace(/@[0-9a-f]{64}$/,'@'+'a'.repeat(63)),good.replace(/@[0-9a-f]{64}$/,'@'+'a'.repeat(64)+'0'),good.replace(ROOT,ROOT.toUpperCase()),good.replace(ROOT,ROOT.slice(1)),good+'/',good.replace('@','%40'),
    good.replace('Widget%20Signing','Widget%20Signing/'),good.replace('/manual/cli-widget','/'),'tree:'+ROOT+'/','tree:'+ROOT+'/@'+'a'.repeat(64),'tree:'+ROOT,'tree:'+ROOT+'/manual',`tree:${ROOT}/manual/${'x/'.repeat(300)}y`,
    good.replace('Widget%20Signing','Widget\u0000Signing'),good.replace('Widget%20Signing','Widget​Signing'),good.replace('Widget%20Signing','Widget%E2%80%8BSigning'),good.replace('Widget%20Signing','Widget\ud800Signing'),good.replace('Widget%20Signing','Widget%E2%80'),
    good.replace('Widget%20Signing','Widget%25Signing'),good.replace('Widget%20Signing','Widget%Signing'),good.replace('Widget%20Signing','Widget%40Signing'),good.replace('Widget%20Signing','Widget%3ASigning'),good.replace('Widget%20Signing','é'),
    'entry:'+'a'.repeat(64),'entry:'+'a'.repeat(63),'entry:'+'A'.repeat(64),'entry:'+'a'.repeat(64)+'/x',
    `src:${'a'.repeat(64)}`,`src:${'a'.repeat(64)}/kityminder@1/n/abc`,`src:${'a'.repeat(64)}/kityminder@1/n/abc/@assertion`,`src:${'a'.repeat(64)}/kityminder@1/n/abc:1-2`,`src:${'a'.repeat(64)}/kityminder@1/n/abc:2-1`,`src:${'a'.repeat(64)}/kityminder@01/n/abc`,`src:${'a'.repeat(64)}/Kityminder@1/n/abc`,`src:${'a'.repeat(64)}/kityminder/n/abc`,`src:${'a'.repeat(64)}/kityminder@1/`,`src:${'a'.repeat(64)}/kityminder@1/n//abc`,`src:${'a'.repeat(64)}/kityminder@1/n/a b`,
    `rec:${'a'.repeat(64)}`,`rec:${'a'.repeat(64)}#/a/b`,`rec:${'a'.repeat(64)}#`,`rec:${'a'.repeat(64)}#/a~2`,`rec:${'a'.repeat(64)}#a`,
    '','tree:','file:///etc/passwd',' '+good,good+' ',good+'\n','Tree:'+ROOT+'/',
  ];
  test('the shape of a reference is the core\'s (ReferenceUri), spelling by spelling',()=>{
    for(const input of corpus)assert.equal(isReferenceUri(input),ReferenceUri.safeParse(input).success,JSON.stringify(input.slice(0,160)));
  });
  test('a tree reference is read exactly as hub/refs parseReference reads it: the same root, path and entry, or neither reads it',()=>{
    for(const input of corpus.filter(value=>value.startsWith('tree:'))){
      let core:{root:string;path:string;entry?:string}|null=null;
      try{if(ReferenceUri.safeParse(input).success){const parsed=parseReference(input);if(parsed.scheme==='tree')core={root:parsed.root,path:parsed.path,...(parsed.entry!==undefined?{entry:parsed.entry}:{})};}}catch{core=null;}
      const own=isReferenceUri(input)?treeAddress(input):null;
      assert.deepEqual(own===null?null:{root:own.root,path:own.path,...(own.entry!==null?{entry:own.entry}:{})},core,JSON.stringify(input.slice(0,160)));
    }
    assert.notEqual(treeAddress(good),null);
  });
  test('every reference of the synthetic tree is canonical, as the Hub writes it',()=>{
    for(const node of LINES.slice(1))for(const entry of node.entries)assert.notEqual(treeAddress(entry.reference),null,entry.reference);
  });
});

/** The text the Hub's graded read gives for a reference over `lines`, or the grade it refuses it with (hub/runs/engine/evaluate.ts gradeFragment, with the real resolution of hub/refs). */
async function hubRead(reference:string,lines:typeof LINES,roots:readonly string[],texts:ReadonlyMap<string,string>):Promise<{text:string}|{why:string}>{
  let parsed;try{parsed=parseReference(reference);}catch{return {why:'malformed'};}
  if(parsed.scheme==='entry')return {why:'entry_unaddressed'};
  if(parsed.scheme==='tree'&&!roots.includes(parsed.root))return {why:'not_bound'};
  if(parsed.scheme!=='tree'){const text=texts.get(reference);return text===undefined?{why:'unavailable'}:{text};}
  const read=await resolveReference(reference,{reader,parsers:createDefaultRegistry(),trees:treeReaderOf(lines)});
  if(!read.resolved)return {why:read.code==='REFERENCE_UNRESOLVED'?'no_fragment':'unavailable'};
  if(!read.groundable)return {why:'not_groundable'};
  if(read.text===null)return {why:'no_fragment'};
  if(Buffer.byteLength(read.text,'utf8')>1024*1024)return {why:'too_large'};
  return {text:read.text};
}
const TABLE={schema:'quote@1',origin:'合成',tier:'blocking',basis:'要求项 expected_grounded：每个期望结果的引文必须逐字出现在其来源里',item:'/item',quotes:[{select:'$.quotes[*]',text:'/text',reference:'/reference'}]};
/** The core's interpreter over the same quotes and the texts the Hub's read gave them. */
async function hubOutcomes(quotes:Array<{reference:string;text:string}>,lines:typeof LINES,roots:readonly string[],texts:ReadonlyMap<string,string>){
  const read=new Map<string,Awaited<ReturnType<typeof hubRead>>>();
  for(const quote of quotes)if(!read.has(quote.reference))read.set(quote.reference,await hubRead(quote.reference,lines,roots,texts));
  const request:CheckRequest={interpreter:'quote@1',table:TABLE,subject:{item:'synthetic-item',quotes},context:{},sources:{
    text:reference=>{const got=read.get(reference);return got!==undefined&&'text' in got?got.text:undefined;},
    why:reference=>{const got=read.get(reference);return got===undefined?'unavailable':'text' in got?'bound':got.why as never;},
  }};
  return getInterpreter('quote@1')!.run(request);
}
const placesOf=(quotes:Array<{reference:string;text:string}>):QuotePlace[]=>quotes.map((quote,index)=>({quote,place:`/block_context/causal_links/${index}/quote`}));
const viewOf=(tree=TREE,texts:Record<string,string>={}):QuoteView=>({root:ROOT,unversionedRoot:null,tree,texts:new Map(Object.entries(texts))});

describe('the verdicts are the interpreter\'s, quote by quote, on one tree',()=>{
  const publish=ref(CHAPTER,PUBLISH),big='甲'.repeat(300_000);
  const HUGE:FlatCatalog={...CATALOG,manual:[...MANUAL,{words:['cli-widget','Huge'],entries:[{statement:big},{statement:big},{statement:big}]},{words:['cli-widget','Quiet'],entries:[]},{words:['cli-widget','Quiet','Child'],entries:[{statement:'子节点原文'}]}]};
  const HUGE_LINES=treeLines(HUGE),HUGE_TREE=lockedTreeOf(HUGE),HUGE_ENTRY=HUGE_TREE.nodes.get('/manual/cli-widget/Huge')!.entries[0].reference as string;
  const FROZEN='健康检查间隔设置成功',FROZEN_REF=`src:${'a'.repeat(64)}/kityminder@1/n/expected`;
  const quotes:Array<[string,string,string]>=[
    ['the whole entry',publish,PUBLISH],
    ['a piece of an entry',publish,'签名密钥发布到设备'],
    ['an entry that is one table row',ref(CHAPTER,HOST_ROW),HOST_ROW],
    ['a row\'s cell',ref(CHAPTER,HOST_ROW),'该参数指定一个已存在的演示域名。'],
    ['a sentence cited with the reference of the entry beside it',ref(CHAPTER,HOST_ROW),PUBLISH],
    ['another sentence cited with the entry before it',ref(CHAPTER,FLAGS_INTRO),HOST_SIGNED],
    ['a sentence of an entry that two entries hold',ref(CHAPTER,HOST_ROW),ECHOED],
    ['a sentence that stands in no entry',ref(CHAPTER,SIGN),SIGN+'（改写）'],
    ['a sentence with a space added',publish,PUBLISH.replace('用于','用于 ')],
    ['a sentence in half-width brackets where the manual has full-width',ref(CHAPTER,FLAGS_INTRO),FLAGS_INTRO.replace('“','"').replace('”','"')],
    ['a quote with white space around it',publish,` ${PUBLISH}\n`],
    ['a quote of nothing but white space',publish,' \n\t　'],
    ['an empty quote',publish,''],
    ['a quote with an unpaired surrogate',publish,'签名\ud800密钥'],
    ['a quote longer than 80 characters that is not there',publish,SIGN.repeat(2)],
    ['a path without an entry: the statements of its entries joined by a blank line',ref(CHAPTER,PUBLISH).replace(/@[0-9a-f]{64}$/,''),`${HOST_ROW}\n\n${SIGN}`],
    ['a path without an entry: one entry of it',ref(CHAPTER,PUBLISH).replace(/@[0-9a-f]{64}$/,''),PUBLISH],
    ['a path without an entry: text the node does not have',ref(CHAPTER,PUBLISH).replace(/@[0-9a-f]{64}$/,''),'不在这一章里的话'],
    ['a node with no entries: the names of its children',`tree:${ROOT}/manual/cli-widget/Quiet`,'Child'],
    ['the root path',`tree:${ROOT}/`,'commands'],
    ['a reference that is no reference',publish.replace('Widget%20Signing','Widget Signing'),PUBLISH],
    ['an escape in lower case',publish.replace('%20','%2f'),PUBLISH],
    ['an escape that was not needed',publish.replace('Widget','%57idget'),PUBLISH],
    ['a trailing slash',publish.replace(/@[0-9a-f]{64}$/,'/'),PUBLISH],
    ['an entry of another root',publish.replace(ROOT,'e'.repeat(64)),PUBLISH],
    ['a path the tree does not have',publish.replace('Widget%20Signing','Widget%20Nothing'),PUBLISH],
    ['an entry the node does not have',publish.replace(/@[0-9a-f]{64}$/,'@'+'c'.repeat(64)),PUBLISH],
    ['an entry of another node cited at this node',ref(APPENDIX,REPEATED).replace('Widget%20Appendix','Widget%20Signing'),ECHOED],
    ['a standalone entry',`entry:${'d'.repeat(64)}`,PUBLISH],
    ['a source of the frozen run with its text',FROZEN_REF,FROZEN],
    ['a source of the frozen run with another text',FROZEN_REF,'别的文字'],
    ['a source of the frozen run, text in white space only',FROZEN_REF,'   '],
    ['an entry the huge node has, under the cap alone',HUGE_ENTRY,big],
    ['the huge node whole: its three entries together are over the cap',`tree:${ROOT}/manual/cli-widget/Huge`,big],
  ];
  test('every quote is supported, refused or refused with the same grade as the interpreter does',async()=>{
    const list=quotes.map(([,reference,text])=>({reference,text})),texts=new Map([[FROZEN_REF,FROZEN]]);
    const hub=await hubOutcomes(list,HUGE_LINES,[ROOT],texts);
    const own=quoteVerdicts('synthetic-item',placesOf(list),{root:ROOT,unversionedRoot:null,tree:HUGE_TREE,texts});
    assert.equal(hub.length,list.length);assert.equal(own.unread.length,0,JSON.stringify(own.unread));assert.equal(own.outcomes.length,list.length);
    for(const [index,[label]] of quotes.entries()){
      const core=hub[index]!,mine=own.outcomes[index]!;
      assert.equal(mine.verdict,core.verdict,`${label}: ${mine.statement}`);assert.equal(mine.code,core.code,label);
      // The words of the interpreter come first, byte for byte; a refusal here goes on with where, what was read and what to do.
      if(core.verdict==='support')assert.equal(mine.statement,core.statement,label);
      else assert.ok(mine.statement.startsWith(core.statement+'；位置：'),`${label}:\n  core ${core.statement}\n  mine ${mine.statement}`);
      assert.equal(mine.pointer!.startsWith(`/data/block_context/causal_links/${index}/quote/`),true,label);
      assert.deepEqual(mine.grounds,[list[index]!.reference],label);
    }
    assert.ok(hub.some(row=>row.verdict==='support')&&hub.some(row=>row.verdict==='refute'),'the list holds both');
    assert.ok(hub.filter(row=>row.verdict==='refute').length>=20,'and many ways to be refused');
  });
  test('the cap on a fragment is the core\'s: the whole huge node is refused, one of its entries is not',async()=>{
    const list=[{reference:`tree:${ROOT}/manual/cli-widget/Huge`,text:big},{reference:HUGE_ENTRY,text:big}];
    const hub=await hubOutcomes(list,HUGE_LINES,[ROOT],new Map()),own=quoteVerdicts('synthetic-item',placesOf(list),viewOf(HUGE_TREE));
    assert.deepEqual(own.outcomes.map(row=>row.verdict),hub.map(row=>row.verdict));assert.deepEqual(hub.map(row=>row.verdict),['refute','support']);
    assert.ok(own.outcomes[0]!.statement.includes('超过大小上限'),own.outcomes[0]!.statement);
  });
  test('a quote this machine cannot read is neither refused nor passed: it is listed with the reason',()=>{
    const own=quoteVerdicts('synthetic-item',[...placesOf([{reference:`src:${'a'.repeat(64)}/kityminder@1/n/other`,text:'某一节点的文字'},{reference:`rec:${'b'.repeat(64)}#/x`,text:'记录里的字'},{reference:publish,text:PUBLISH}]),{quote:{reference:`src:${'a'.repeat(64)}/kityminder@1/n/e/@assertion`,text:'{"op":"found"}'},place:'/fields/expected_nodes/0',frozen:true}],viewOf());
    assert.deepEqual(own.outcomes.map(row=>row.verdict),['support']);
    assert.deepEqual(own.unread.map(row=>row.place),['/block_context/causal_links/0/quote','/block_context/causal_links/1/quote','/fields/expected_nodes/0']);
    assert.deepEqual(own.unread.map(row=>row.frozen),[undefined,undefined,true],'only the frozen item\'s own declaration is marked as the item\'s');
    assert.ok(own.unread.every(row=>row.why.length>8));
    // The Hub also answers an entry the product placed in no node when it is asked for at the root; an entry the download lacks there is not refused here.
    const unplaced=quoteVerdicts('synthetic-item',placesOf([{reference:`tree:${ROOT}/@${'c'.repeat(64)}`,text:'未放置条目的原文'}]),viewOf());
    assert.deepEqual(unplaced.outcomes,[]);assert.deepEqual(unplaced.unread.map(row=>row.why),['根节点上未放置的条目不在下载里']);
  });
  test('the unversioned root of the run is a root the run is bound to, whose tree the download does not hold: not refused, not read',()=>{
    const other='b'.repeat(64),view:QuoteView={...viewOf(),unversionedRoot:other};
    const own=quoteVerdicts('synthetic-item',placesOf([{reference:`tree:${other}/manual/x@${'a'.repeat(64)}`,text:'另一个根下的原文'}]),view);
    assert.deepEqual(own.outcomes,[]);assert.deepEqual(own.unread.map(row=>row.why),['下载目录里只有本次运行锁定的根，没有这个根的树']);
    assert.equal(frozenQuoteView({root:ROOT,unversioned_root:other,items:[]},TREE).unversionedRoot,other);
  });
  test('without the downloaded tree a tree reference is not read, and a reference of another root is still refused',()=>{
    const own=quoteVerdicts('synthetic-item',placesOf([{reference:publish,text:PUBLISH},{reference:publish.replace(ROOT,'e'.repeat(64)),text:PUBLISH}]),{root:ROOT,unversionedRoot:null,texts:new Map()});
    assert.deepEqual(own.outcomes.map(row=>row.verdict),['refute']);assert.deepEqual(own.unread.map(row=>row.why),['缺本次冻结根的命令树 knowledge/nodes.jsonl']);
  });
  test('the entries that hold a sentence are named in the tree\'s order, the cited node first, and a common phrase is counted, not listed',()=>{
    const many:FlatCatalog={...CATALOG,manual:[{words:['a'],entries:Array.from({length:30},(_,index)=>({statement:`第${index}条：同一句话。`}))},{words:['b'],entries:[{statement:'另一章：同一句话。'}]},{words:['c'],entries:[{statement:'别的'}]}]};
    const tree=lockedTreeOf(many),cited=ref(['c'],'别的');
    const own=quoteVerdicts('synthetic-item',placesOf([{reference:cited,text:'同一句话。'}]),viewOf(tree));
    const message=own.outcomes[0]!.statement;
    assert.ok(message.includes('这句原文在上面允许的 31 处')&&message.includes('…（共 31 个）'),message);
    assert.equal(own.outcomes[0]!.pointer,'/data/block_context/causal_links/0/quote/reference');
  });
});

describe('the quotes of a plan, and the place of each',()=>{
  const frozen=(subjectFixture:ReturnType<typeof fixture>)=>frozenRun({groups:[{kind:'case-compile',contract:subjectFixture.contractDoc,profile:subjectFixture.profileDoc,manifest:subjectFixture.inventory,manifest_sha256:subjectFixture.manifest_sha256,leases:{now:'2026-10-23T02:00:00.000Z',entries:[]}}],items:[{id:'synthetic-case',label:'合成用例',location:'src:'+'a'.repeat(64)+'/kityminder@1/n/expected',fields:subjectFixture.fields}],root:ROOT,command_policy:(subjectFixture.catalog as {policy:unknown}).policy});
  const rawOf=(data:unknown,subjectFixture=f)=>{const run=frozen(subjectFixture);return checkInput(run,(run.items as Array<Record<string,unknown>>)[0]!,{plan:[{text:'合成计划',data}]},{entries:subjectFixture.catalog.entries as unknown[],complete:true});};
  const placesFor=(data:unknown,subjectFixture=f)=>{const found=quotePlaces(rawOf(data,subjectFixture));assert.equal(found.kind,'quotes',JSON.stringify(found));return found.kind==='quotes'?found.places:[];};
  const manualQuote=(statement:string)=>({reference:ref(CHAPTER,statement),text:statement});

  test('the subject the Hub gets is the quotes of these places, as it always was',()=>{
    const data=positiveBlocks().CONFIG;data.block_context!.causal_links=[{from:'configure',to:'observe',quote:manualQuote(PUBLISH)}];data.block_context!.preconditions=[{id:'p1',state:'present',for:'observe',established_by:['configure'],quote:manualQuote(SIGN)}];
    const raw=rawOf(data),found=quotePlaces(raw);
    assert.equal(found.kind,'quotes');
    assert.deepEqual((quoteSubject(raw) as {quotes:unknown[]}).quotes,found.kind==='quotes'?found.places.map(row=>row.quote):[]);
  });
  test('a flat plan: an expectation and a step\'s precondition source, at the places the writer wrote them',()=>{
    const run=frozenRun({groups:[{kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC,leases:{now:'2026-10-23T02:00:00.000Z',entries:[]}}],items:[{id:'doc:case-1',label:'合成用例',location:QUOTE.reference,fields:{}}],root:(COMMAND_CATALOG as {root:string}).root,command_policy:(COMMAND_CATALOG as {policy:unknown}).policy});
    const data=goodData();data.steps[1]!.precondition_source=manualQuote(SIGN);
    const found=quotePlaces(checkInput(run,(run.items as Array<Record<string,unknown>>)[0]!,{plan:[{text:'合成计划',data}]},{entries:(COMMAND_CATALOG as {entries:unknown[]}).entries,complete:true}));
    assert.equal(found.kind,'quotes',JSON.stringify(found));
    assert.deepEqual(found.kind==='quotes'?found.places.map(row=>[row.place,row.quote.text]):[],[['/expects/0/quote',QUOTE.text],['/steps/1/precondition_source',SIGN]]);
  });
  test('a block plan: the quote of an assertion, of a causal link, of a precondition and of a responder are each at their own place in the plan file',()=>{
    const data=positiveBlocks().CONFIG;
    data.block_context!.causal_links=[{from:'configure',to:'observe',quote:manualQuote(PUBLISH)}];
    data.block_context!.preconditions=[{id:'p1',state:'present',for:'observe',established_by:['configure'],quote:manualQuote(SIGN)}];
    data.block_context!.responders=[{output:'observe',kind:'device',ref:'dut0',quote:manualQuote(HOST_SIGNED)}];
    const places=placesFor(data);
    assert.deepEqual(places.map(row=>row.place),['/blocks/1/assertions/0/quote','/block_context/preconditions/0/quote','/block_context/causal_links/0/quote','/block_context/responders/0/quote','/fields/expected_nodes/0']);
    assert.equal(places.at(-1)!.frozen,true);assert.ok(places.at(-1)!.quote.reference.endsWith('/@assertion'));
    assert.deepEqual(places.slice(1,4).map(row=>row.quote.text),[SIGN,PUBLISH,HOST_SIGNED]);
  });
  test('the other block kinds that carry a quote: a comparison of two captures, an expectation taken from a capture',()=>{
    const blocks=positiveBlocks();
    assert.deepEqual(placesFor(blocks.CAPTURE_COMPARE).map(row=>row.place).filter(place=>place.startsWith('/blocks/')),['/blocks/2/quote','/blocks/2/quote']);
    assert.deepEqual(placesFor(blocks.EXPECT_FROM).map(row=>row.place).filter(place=>place.startsWith('/blocks/')),['/blocks/1/quote']);
  });
  test('every place the slot schema declares for a quote is one the Hub reads, or is the quote of an expectation another place already carries',()=>{
    const schema=JSON.parse(readFileSync(new URL('../slots.schema.json',import.meta.url),'utf8')) as unknown;
    const found:string[]=[];
    const walk=(value:unknown,path:string[]):void=>{
      if(Array.isArray(value))value.forEach((row,index)=>walk(row,[...path,String(index)]));
      else if(isRecord(value))for(const [key,row] of Object.entries(value)){
        const props=isRecord(row)&&isRecord(row.properties)?row.properties:{};
        if(key==='quote'||key==='precondition_source'||('reference' in props&&'text' in props))found.push([...path,key].join('/'));
        walk(row,[...path,key]);
      }
    };
    walk(schema,[]);
    const BASE='item/plan/data/properties';
    // How the Hub's subject builder (quotePlaces) reaches each place of the schema, checked above for the plan kinds that have them.
    const READ:Record<string,string>={
      [`${BASE}/expects/items/properties/quote`]:'a flat plan\'s expectation: expects[i].quote',
      [`${BASE}/steps/items/properties/precondition_source`]:'a flat plan\'s step: steps[i].precondition_source',
      [`${BASE}/block_context/properties/preconditions/items/properties/quote`]:'block_context.preconditions[i].quote',
      [`${BASE}/block_context/properties/causal_links/items/properties/quote`]:'block_context.causal_links[i].quote',
      [`${BASE}/block_context/properties/responders/items/properties/quote`]:'block_context.responders[i].quote',
      [`${BASE}/blocks/items/anyOf/1/properties/assertions/items/properties/quote`]:'OBSERVE_ASSERT: lowered to an expectation of the plan, blocks[i].assertions[j].quote',
      [`${BASE}/blocks/items/anyOf/5/properties/quote`]:'CAPTURE_COMPARE: lowered to expectations, blocks[i].quote',
      [`${BASE}/blocks/items/anyOf/6/properties/quote`]:'EXPECT_FROM: lowered to an expectation, blocks[i].quote',
      [`${BASE}/criteria/items/properties/quote`]:'a typed criterion: its quote has to equal the quote of the expectation that names it (functions/block-expected.ts), which is read',
    };
    assert.deepEqual([...found].sort(),Object.keys(READ).sort(),'a quote the schema gained has to be put here with the way the Hub reads it (or the plan check will not say where it is refused)');
  });
  test('the frozen item\'s own texts: an expectation node and an atom are the texts of their src: references, the declared assertion under /@assertion',()=>{
    const texts=frozenSourceTexts(frozen(f));
    assert.equal(texts.get(f.fields.expected_nodes[0]!.reference),f.fields.expected_nodes[0]!.text);
    assert.equal(texts.get(f.fields.expected_nodes[0]!.reference+'/@assertion'),JSON.stringify(f.fields.expected_nodes[0]!.declaration));
    assert.deepEqual(frozenQuoteView({root:ROOT,items:[]},TREE).texts.size,0);
  });
});

