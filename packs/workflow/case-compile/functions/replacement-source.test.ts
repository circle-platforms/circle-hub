// A replacement may only replace an address the locked tree parses out of the author's own commands (decision 115). Round 37: all
// three writers wrote the documentation address that the recompose step put into its adapted commands (192.0.2.10, 2001:db8::1,
// ...) as the source of a replacement and were refused once, with a refusal that said what the rule is and nothing about the
// address they had written, the record it came from or what to write instead. The rule is unchanged (the first test); the refusal
// now names the place, the value seen, the allowed set and the next step, and says where in the frozen recomposition record the
// address comes from when it does come from there. Synthetic addresses only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkAddresses} from './checks.ts';
import {fixture} from '../testing/inverse-alternatives.ts';

const RECEIPT='rec:'+'9'.repeat(64),CASE_ID='syn-case-1';
const ON='192.0.2.10',ON6='2001:db8:1::10',AUTHORED='198.51.100.7',PLACEHOLDER='203.0.113.9',PLACEHOLDER6='2001:db8::1';

function entry(catalog:{root:string;entries:Array<Record<string,unknown>>},word:string,type:'ipv4'|'ipv6'){
  catalog.entries.push({words:['show','demo',word],reference:`tree:${catalog.root}/commands/show/demo/${word}`,signatures:[{id:'1',reference:`src:${catalog.root}/xml@1/x/commands/${word}[1]/arguments`,params:[{name:'address',type,native_type:{name:type==='ipv4'?'IPADDR':'IP6ADDR',declaration:`src:${catalog.root}/xml@1/x/commands/${word}[1]/arguments/arg[1]`,grammar:'famx-command-tree@1'}}]}]});
}
/** The plan configures nothing but one read-only command that takes an address; the author wrote one address; the record is the given one. */
function subjectOf(planned:string,replacements:Array<{case:string;bed:string}>,record?:Record<string,unknown>,authored:string[]=[`show demo peer ${AUTHORED}`]){
  const value=fixture([`show demo ${planned.includes(':')?'peer6':'peer'} ${planned}`]);
  const catalog=value.subject.command_catalog as {root:string;entries:Array<Record<string,unknown>>};
  entry(catalog,'peer','ipv4');entry(catalog,'peer6','ipv6');
  const subject=value.subject as unknown as Record<string,unknown>;
  subject.case_texts=authored;
  (subject.data as Record<string,unknown>).replacements=replacements;
  if(record!==undefined){
    // The plan declares the recomposition it consumes, as every plan of a run with a record does; this case has no expectation slot.
    subject.recomposition={receipt:RECEIPT,record};
    (subject.data as Record<string,unknown>).recomposition={receipt:RECEIPT,case_id:CASE_ID,slots:[],rebindings:[]};
  }
  return value;
}
/** A recomposition record the way the frozen run carries it: the adapted ledger with commands, the unknowns, the states. */
const recordOf=(over:{adapted?:Array<Record<string,unknown>>;unknowns?:Array<Record<string,unknown>>;concretizations?:Array<Record<string,unknown>>;states?:Array<Record<string,unknown>>}={})=>({
  case:{id:CASE_ID},atoms:[],expectation_slots:[],ledgers:{original:[],adapted:over.adapted??[],concretizations:over.concretizations??[],rebindings:[]},unknowns:over.unknowns??[],sources:{states:over.states??[]},
});
const adapted=(atom:string,...commands:string[])=>({atom,action:'structural_completion',commands,text:'补全前置'});
const rows=(value:ReturnType<typeof subjectOf>)=>checkAddresses(value);
const refusals=(value:ReturnType<typeof subjectOf>)=>rows(value).filter(row=>row.code==='case-compile.replacement_invalid');
const has=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(text.includes(part),`missing ${JSON.stringify(part)} in: ${text}`);};
const lacks=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(!text.includes(part),`unexpected ${JSON.stringify(part)} in: ${text}`);};

test('the rule is unchanged: the author\'s address may be replaced, any other source is refused as a plan error, and nothing becomes unknown',()=>{
  const ok=rows(subjectOf(ON,[{case:AUTHORED,bed:ON}]));
  assert.ok(!ok.some(row=>row.code==='case-compile.replacement_invalid'||row.verdict==='unknown'),JSON.stringify(ok));
  const placeholder=rows(subjectOf(ON,[{case:PLACEHOLDER,bed:ON}],recordOf({adapted:[adapted('a2',`show demo peer ${PLACEHOLDER}`)]})));
  assert.deepEqual(placeholder.map(row=>[row.verdict,row.code,row.pointer]),[['refute','case-compile.replacement_invalid','/data/replacements/0']]);
  const nothing=rows(subjectOf(ON,[{case:PLACEHOLDER,bed:ON}]));
  assert.deepEqual(nothing.map(row=>[row.verdict,row.code,row.pointer]),[['refute','case-compile.replacement_invalid','/data/replacements/0']]);
});

test('a source that is an address of an adapted command of the recomposition record is said to be that, with the place in the record and the correct form',()=>{
  const value=subjectOf(ON,[{case:PLACEHOLDER,bed:ON}],recordOf({
    adapted:[adapted('a3','show demo peer 198.51.100.77'),adapted('a2',`show demo peer ${PLACEHOLDER}`)],
    unknowns:[{missing:`按命令语法必填暂用文档保留地址 ${PLACEHOLDER}`,next_action:'脚本编写按测试环境替换'}],
  }));
  const [row,...rest]=refusals(value);
  assert.equal(rest.length,0);assert.equal(row.verdict,'refute');assert.equal(row.pointer,'/data/replacements/0');
  has(row.statement,
    `替换的来源 ${PLACEHOLDER} 不是作者命令里的地址`,
    '重组记录里暂用的文档保留地址',
    '位置：/slots/plan/0/data/replacements/0',
    `看到：{"case":"${PLACEHOLDER}","bed":"${ON}"}`,
    `允许：${AUTHORED}`,
    '这里解析出 1 个',
    '作者动作 a2 的改写命令「show demo peer 203.0.113.9」（/ledgers/adapted/1/commands/0）',
    `下一步：删掉这一行；把测试环境清单里的地址 ${ON} 直接写进计划里原来写 ${PLACEHOLDER} 的步骤命令（该改写命令在计划里写成「show demo peer ${ON}」）；replacements 只留作者原文命令里的地址，没有就写 []`);
  lacks(row.statement,'a3','198.51.100.77','ipv4:');
});

test('an address that the record names only in a sentence of its unknowns is said to be named there, and the next step has no command to show',()=>{
  const value=subjectOf(ON,[{case:PLACEHOLDER,bed:ON}],recordOf({
    adapted:[adapted('a2','show demo peer 198.51.100.77')],
    unknowns:[{missing:'无关',next_action:'无关'},{missing:`主设备与对端的 IP 与名称`,next_action:`暂用 RFC5737 文档保留地址（${PLACEHOLDER}/203.0.113.10）示意；由脚本编写按测试环境替换为实际地址`}],
  }));
  const [row]=refusals(value);
  has(row.statement,'重组记录里暂用的文档保留地址','unknowns 第 2 条（/unknowns/1/next_action）写着「','暂用 RFC5737 文档保留地址（203.0.113.9/203.0.113.10）示意','不在任何改写命令里',`把测试环境清单里的地址 ${ON} 直接写进计划里用到这个地址的步骤命令的地址参数`,'没有就写 []');
  lacks(row.statement,'作者动作','该改写命令');
});

test('an address that only starts like one the record names is not claimed to come from it',()=>{
  const value=subjectOf(ON,[{case:'203.0.113.9',bed:ON}],recordOf({
    adapted:[adapted('a2','show demo peer 203.0.113.99')],
    unknowns:[{missing:'暂用 203.0.113.90 和 203.0.113.9.5',next_action:'按测试环境替换'}],
  }));
  const [row]=refusals(value);
  lacks(row.statement,'重组记录','改写命令','unknowns');
  has(row.statement,'替换的来源 203.0.113.9 不是作者命令里的地址','位置：/slots/plan/0/data/replacements/0','看到：','允许：198.51.100.7','下一步：删掉这一行');
});

test('an address the record does not hold, or a case with no record, keeps the plain refusal with place, value, allowed set and next step',()=>{
  for(const record of [recordOf({adapted:[adapted('a2','show demo peer 198.51.100.55')]}),undefined]){
    const [row]=refusals(subjectOf(ON,[{case:PLACEHOLDER,bed:ON}],record));
    has(row.statement,`替换的来源 ${PLACEHOLDER} 不是作者命令里的地址`,'位置：/slots/plan/0/data/replacements/0',`看到：{"case":"${PLACEHOLDER}","bed":"${ON}"}`,`允许：${AUTHORED}`,'替换表只收锁定命令树从作者原文命令里解析出的地址参数（这里解析出 1 个），不按外形从散文里找地址','下一步：删掉这一行','replacements 只留作者原文命令里的地址');
    lacks(row.statement,'重组记录','ipv4:');
  }
  const [none]=refusals(subjectOf(ON,[{case:PLACEHOLDER,bed:ON}],undefined,[]));
  has(none.statement,'允许：无','这里解析出 0 个');
});

test('an IPv6 address is matched by its value whatever its notation, and the command of the record is shown with the bed address in its place',()=>{
  const value=subjectOf(ON6,[{case:'2001:0DB8:0:0:0:0:0:1',bed:ON6}],recordOf({adapted:[adapted('a2',`show demo peer6 ${PLACEHOLDER6}`)]}),[]);
  const [row]=refusals(value);
  has(row.statement,'2001:0DB8:0:0:0:0:0:1','重组记录里暂用的文档保留地址','作者动作 a2 的改写命令「show demo peer6 2001:db8::1」',`在计划里写成「show demo peer6 ${ON6}」`);
});

test('a source that is not a documentation address is still said to come from the record when the record holds it, without the documentation wording',()=>{
  const value=subjectOf(ON,[{case:'127.0.0.9',bed:ON}],recordOf({adapted:[adapted('a2','show demo peer 127.0.0.9')]}));
  const [row]=refusals(value);
  has(row.statement,'是重组记录里写到的地址','作者动作 a2 的改写命令「show demo peer 127.0.0.9」');
  lacks(row.statement,'文档保留地址');
});

test('the refusal text is only text: the plan is not rewritten and the other findings of the check are those it always gave',()=>{
  const value=subjectOf(ON,[{case:PLACEHOLDER,bed:ON}],recordOf({adapted:[adapted('a2',`show demo peer ${PLACEHOLDER}`)]}));
  const before=JSON.stringify(value.subject.data);
  const all=rows(value);
  assert.equal(JSON.stringify(value.subject.data),before);
  assert.equal(all.length,1,JSON.stringify(all));
  const family=rows(subjectOf(ON,[{case:PLACEHOLDER6,bed:ON}],recordOf({adapted:[adapted('a2',`show demo peer6 ${PLACEHOLDER6}`)]})));
  assert.deepEqual(family.map(row=>[row.verdict,row.code,row.pointer]),[['refute','case-compile.replacement_invalid','/data/replacements/0'],['refute','case-compile.replacement_invalid','/data/replacements/0']],'a mapping across address families and a source that is no author address are two findings of one row, as before');
});
