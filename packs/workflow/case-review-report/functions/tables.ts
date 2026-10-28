// A deterministic view of source text and already accepted claims. It creates no review judgment.
import type {Partition,Nature,ProducerKind,SourceRole,Attribution} from '../../../../contracts/generated/vocabulary.ts';
import labels from '../tables/labels.json' with {type:'json'};
import {failure,isRecord} from './common.ts';

export interface TableNode {text:string;selector:string;parent:number|null;children:number[];data:Record<string,unknown>}
export interface TableModel {nodes:TableNode[]}
export interface TableBlock {record:string;result:Record<string,any>}
export interface TableInput {
  model:TableModel;digest:string;blocks:TableBlock[];
  overall:{verdict:string;level:string|null};preconditionPriority:number|null;foldEmpty?:boolean;
}
export interface ReviewCount {cases:number;affectedCases:number;findings:number;severity:Record<string,number>;suggestions:number;refuted:number;hubChecks:number}
export interface ReviewCounts {characters:{total:number;subitems:Array<{selector:string;start:number;end:number}>};total:ReviewCount;subitems:Array<{selector:string;name:string;counts:ReviewCount}>;cross:ReviewCount}
type Kind='finding'|'suggestion'|'refuted'|'hub';
interface Note {kind:Kind;node:number;owner:number;order:number;record:string;text:string;rank:string|null;code:string|null;disposition:string|null;probe:string|null;unlocated?:boolean}
interface Place {row:number|null;group:number|null}
const DELIVERED='delivered' satisfies Partition;
const JUDGMENT='judgment' satisfies Nature,FACT='fact' satisfies Nature;
const SOURCE_ERROR='author_input' satisfies Attribution;
const MODEL='model' satisfies ProducerKind,FUNCTION='function' satisfies ProducerKind,SUBJECT='subject' satisfies SourceRole;
const records=(value:unknown):Record<string,any>[]=>Array.isArray(value)?value.filter(isRecord):[];
const text=(value:unknown):string=>typeof value==='string'?value:'';
const byText=(a:string,b:string)=>a<b?-1:a>b?1:0;
const display=(rows:readonly {code:string;label:string}[],code:string|null)=>rows.find(row=>row.code===code)?.label??code??'未声明';

/** The only transformations: reversible markup escaping and a visible newline marker. */
export function escapeTableText(value:string):string {
  let out='';
  for(const char of value.replace(/\r\n|\r/g,'\n')){
    if(char==='\n')out+='↵';
    else if(char==='↵'||'\\*_[]<|~&'.includes(char)||char.charCodeAt(0)===96)out+='\\'+char;
    else out+=char;
  }
  return out;
}

/** Source fields in document order, excluding independently reviewed nested cases and their subtrees. */
export function caseText(model:TableModel,index:number,cases:ReadonlySet<number>,preconditionPriority:number|null):string {
  const source=model.nodes[index],tags=Array.isArray(source.data.resource)?source.data.resource.filter((value):value is string=>typeof value==='string'):[];
  let out=source.text+(tags.length?'；标签：'+tags.join('，'):'');
  // Inside a case, every tagged node is an independent nested case under both review rules.
  const boundary=(at:number)=>cases.has(at)||Array.isArray(model.nodes[at].data.resource)&&(model.nodes[at].data.resource as unknown[]).length>0;
  let step=0;
  const descendants=(at:number):string[]=>{
    if(boundary(at))return [];
    return [model.nodes[at].text,...model.nodes[at].children.flatMap(descendants)];
  };
  for(const child of source.children){
    if(boundary(child))continue;
    const node=model.nodes[child];
    if(node.children.length===0)out+='；'+(preconditionPriority!==null&&node.data.priority===preconditionPriority?'前置：':'期望：')+node.text;
    else out+='；步骤 '+String(++step)+'：'+descendants(child).join(' → ');
  }
  return out;
}

export function targetNodeIndexes(model:TableModel):ReadonlyMap<string,number> {
  const bySelector=new Map<string,number>(),positional:string[]=[];
  for(const [index,node] of model.nodes.entries()){
    positional[index]=node.parent===null?'i':positional[node.parent]+'/'+model.nodes[node.parent].children.indexOf(index);
    bySelector.set(node.selector,index);bySelector.set(positional[index],index);
  }
  return bySelector;
}

export type TableResult = {markdown:string;counts:ReviewCounts} | ReturnType<typeof failure>;
export function reviewTables(input:TableInput):TableResult {
  const {model,digest}=input,bySelector=targetNodeIndexes(model);
  if(model.nodes.length===0)return failure('target_invalid','目标脑图没有根节点','重新绑定可读的同一份目标脑图后开始终稿');
  const nodeOf=(reference:unknown):number|null=>{
    if(typeof reference!=='string'||!reference.startsWith('src:'+digest+'/kityminder@1/'))return null;
    const selector=reference.slice(('src:'+digest+'/kityminder@1/').length).replace(/:\d+-\d+$/,'').replace(/\/@[^/]+$/,'');
    return bySelector.get(selector)??null;
  };
  const selected=new Map<number,{entry:Record<string,any>;block:TableBlock}>();
  for(const block of input.blocks)for(const entry of records(block.result.partitions?.[DELIVERED])){
    const index=nodeOf(entry.location);
    if(index===null)return failure('target_mismatch','已交付条目 '+text(entry.item).slice(0,60)+' 的位置在 target 中不可解析','按同一份 target 重新复核该条目，使用新回执开始终稿');
    if(selected.has(index)){const previous=selected.get(index)!;return failure('overlap','第 '+(input.blocks.indexOf(previous.block)+1)+' 块条目 '+text(previous.entry.item).slice(0,60)+' 与第 '+(input.blocks.indexOf(block)+1)+' 块条目 '+text(entry.item).slice(0,60)+' 交付同一目标节点','重新分块，确保同一节点仅由一块交付；独立复核完成后使用新回执开始终稿');}
    selected.set(index,{entry,block});
  }
  // Recover source boundaries independently of delivery, including marked candidates.
  // As in the review projection, a tagged priority-1 container outside any case
  // remains a group when it holds a case; a tagged node inside a case is nested.
  const tagged=(index:number)=>Array.isArray(model.nodes[index].data.resource)&&(model.nodes[index].data.resource as unknown[]).length>0;
  const holds=new Uint8Array(model.nodes.length),inside=new Uint8Array(model.nodes.length),boundaries=new Set<number>();
  for(let index=model.nodes.length-1;index>0;index--){const parent=model.nodes[index].parent;if(parent!==null&&(holds[index]||tagged(index)||model.nodes[index].data.priority===2))holds[parent]=1;}
  for(const [index,node] of model.nodes.entries()){
    const within=node.parent!==null&&(inside[node.parent]===1||boundaries.has(node.parent));
    inside[index]=within?1:0;
    if(selected.has(index)||(tagged(index)?within||node.data.priority!==1||!holds[index]:!within&&node.data.priority===2&&node.children.length>0&&!holds[index]))boundaries.add(index);
  }
  const cases=new Set(selected.keys()),ordered=[...cases].sort((a,b)=>a-b),groupOf=new Map<number,number>();
  for(const index of ordered){
    let outer=index;
    for(let at=model.nodes[index].parent;at!==null;at=model.nodes[at].parent)if(boundaries.has(at))outer=at;
    groupOf.set(index,model.nodes[outer].parent??0);
  }
  const groups=new Map<number,number[]>();
  for(const index of ordered){const group=groupOf.get(index)!;groups.set(group,[...(groups.get(group)??[]),index]);}
  const place=(index:number):Place=>{
    for(let at:number|null=index;at!==null;at=model.nodes[at].parent){
      if(cases.has(at))return {row:at,group:groupOf.get(at)!};
      if(at!==0&&groups.has(at))return {row:null,group:at};
    }
    return {row:null,group:null};
  };
  const sourceLocation=(claim:Record<string,any>,fallback:number):number=>{
    const location=records(claim.resolutions).find(resolution=>typeof resolution.pointer==='string'&&resolution.pointer.endsWith('/location'));
    return records(location?[location]:[]).flatMap(resolution=>Array.isArray(resolution.references)?resolution.references:[]).map(nodeOf).find(index=>index!==null)??fallback;
  };
  const notes:Array<Note&Place>=[];
  const add=(note:Note,where:Place)=>notes.push({...note,...where});
  for(const block of input.blocks){
    let order=0;
    for(const entry of records(block.result.partitions?.[DELIVERED])){
      const owner=nodeOf(entry.location)!;
      for(const requirement of records(entry.requirements))for(const claim of records(requirement.claims)){
        const statement=isRecord(claim.statement)?claim.statement:{},code=typeof statement.code==='string'?statement.code:null;
        const data=isRecord(statement.data)?statement.data:{};
        const attributed=records(requirement.layers).some(layer=>layer.layer==='static'&&layer.attribution===SOURCE_ERROR);
        const common={node:sourceLocation(claim,owner),owner,order:order++,record:block.record,text:text(statement.text),rank:typeof statement.rank==='string'?statement.rank:null,code,disposition:null,probe:null};
        if(requirement.requirement==='verification'&&claim.qualifier?.nature===JUDGMENT&&claim.warrant?.producer===MODEL&&labels.dispositions.some(row=>row.code===code)){
          add({...common,kind:code===labels.dispositions.find(row=>row.display==='推翻')?.code?'refuted':'finding',disposition:code,probe:typeof data.probe==='string'?data.probe:null},place(common.node));
        }
        if(claim.qualifier?.nature===FACT&&claim.warrant?.producer===FUNCTION){
          if(claim.qualifier?.source_role===SUBJECT&&attributed&&statement.verdict==='refute'&&data.expected!==true&&code!==null)add({...common,kind:'hub'},place(common.node));
          // The verifier's source-facts check carries original claims and their original record references as data.
          if(statement.verdict==='support')for(const original of records(data.source_facts)){
            const fact=isRecord(original.claim)?original.claim:{},factStatement=isRecord(fact.statement)?fact.statement:{};
            const qualifier=isRecord(fact.qualifier)?fact.qualifier:{},warrant=isRecord(fact.warrant)?fact.warrant:{};
            if(!isRecord(original.layer)||original.layer.attribution!==SOURCE_ERROR||qualifier.nature!==FACT||qualifier.source_role!==SUBJECT||warrant.producer!==FUNCTION||factStatement.verdict!=='refute'||isRecord(factStatement.data)&&factStatement.data.expected===true||typeof factStatement.code!=='string')continue;
            const at=sourceLocation(fact,nodeOf(original.location)??owner);
            add({...common,node:at,kind:'hub',code:factStatement.code,text:text(factStatement.text),record:text(original.reference),order:order++},place(at));
          }
        }
      }
    }
    for(const claim of records(block.result.cross_item)){
      const statement=isRecord(claim.statement)?claim.statement:{};
      if(claim.qualifier?.nature!==JUDGMENT||claim.warrant?.producer!==MODEL||statement.code!=='suggestion')continue;
      const indexes=[...new Set((Array.isArray(claim.grounds)?claim.grounds:[]).map(nodeOf).filter((at):at is number=>at!==null))].sort((a,b)=>a-b);
      const destinations=indexes.map(place);
      const row=destinations.length&&destinations.every(p=>p.row!==null&&p.row===destinations[0].row)?destinations[0].row:null;
      const group=destinations.length&&destinations.every(p=>p.group!==null&&p.group===destinations[0].group)?destinations[0].group:null;
      add({kind:'suggestion',node:indexes[0]??Number.MAX_SAFE_INTEGER,owner:Number.MAX_SAFE_INTEGER,order:order++,record:block.record,text:text(statement.text),rank:typeof statement.rank==='string'?statement.rank:null,code:'suggestion',disposition:null,probe:null,unlocated:indexes.length===0},{row,group});
    }
  }
  notes.sort((a,b)=>a.node-b.node||a.owner-b.owner||a.order-b.order||byText(a.record,b.record));
  const count=(rows:readonly number[],own:readonly Note[]):ReviewCount=>({
    cases:rows.length,affectedCases:rows.filter(index=>own.some(note=>(note.kind==='finding'||note.kind==='hub')&&'row'in note&&note.row===index)).length,
    findings:own.filter(note=>note.kind==='finding').length,
    severity:Object.fromEntries(labels.ranks.map(rank=>[rank.code,own.filter(note=>note.kind==='finding'&&note.rank===rank.code).length])),
    suggestions:own.filter(note=>note.kind==='suggestion').length,refuted:own.filter(note=>note.kind==='refuted').length,hubChecks:own.filter(note=>note.kind==='hub').length,
  });
  const description=(note:Note):string=>{
    const e=escapeTableText,rank=note.rank===null?'':display(labels.ranks,note.rank);
    if(note.kind==='hub')return '【'+e(display(labels.hubCodes,note.code))+'】'+e(note.text);
    if(note.kind==='suggestion')return '【'+e(rank)+'】'+e(note.text)+(note.unlocated?'（没有写落点）':'');
    const disposition=labels.dispositions.find(row=>row.code===note.disposition)?.display??note.disposition??'';
    return '【'+[disposition,rank,note.probe===null?'':display(labels.probes,note.probe)].filter(Boolean).map(e).join('·')+'】'+e(note.text);
  };
  const list=(own:readonly Note[],kind:Kind)=>own.filter(note=>note.kind===kind).map(description).join(' ')||'无';
  const summary=(counts:ReviewCount)=>'用例 '+counts.cases+' 个，有发现的 '+counts.affectedCases+' 个；发现 '+counts.findings+' 条'+(counts.findings?'（'+labels.ranks.filter(rank=>counts.severity[rank.code]>0).map(rank=>rank.label+' '+counts.severity[rank.code]).join('、')+'）':'')+'；Hub 核对 '+counts.hubChecks+' 条；建议 '+counts.suggestions+' 条';
  const nameOf=(group:number):string=>{
    if(group===0)return '（直接在文档根下）';
    const parts:string[]=[];for(let at:number|null=group;at!==null&&at!==0;at=model.nodes[at].parent)parts.unshift(model.nodes[at].text);return parts.join(' › ');
  };
  const subitems=[...groups].sort(([a],[b])=>a-b).map(([group,rows])=>({selector:model.nodes[group].selector,name:nameOf(group),counts:count(rows,notes.filter(note=>note.group===group))}));
  const cross=notes.filter(note=>note.group===null),counts={total:count(ordered,notes),subitems,cross:count([],cross)};
  const models=[...new Set(input.blocks.flatMap(block=>records(block.result.cross_item).filter(claim=>claim.qualifier?.nature===JUDGMENT&&claim.warrant?.producer===MODEL&&labels.finalCodes.some(code=>code.code===claim.statement?.code)).map(claim=>text(claim.warrant.id))))].sort(byText);
  const lines=[
    '## 用例评审结果：'+escapeTableText(model.nodes[0].text),
    '- 整体结论 '+escapeTableText(input.overall.verdict)+'，等级 '+escapeTableText(input.overall.level??'未声明')+'（Hub 按 '+input.blocks.length+' 块复核结论取最差算出）',
    '- '+summary(counts.total)+'；初评发现被复核推翻 '+counts.total.refuted+' 条',
    '- 用例原文逐字取自 src:'+digest+'，原文的换行显示为 ↵；发现和建议是复核方（'+escapeTableText(models.join('、')||'结论未声明模型，须补交声明后重新复核')+'）的判断，原样列出，内容未经平台验证；Hub 核对列为已存的字面和目录事实，位置、引文和处置已由 Hub 核对',
  ];
  const headings:Array<{selector:string;title:string}>=[];
  for(const [ordinal,group] of [...groups.keys()].sort((a,b)=>a-b).entries()){
    const rows=groups.get(group)!,own=notes.filter(note=>note.group===group),groupCount=subitems[ordinal].counts;
    const heading='### '+(ordinal+1)+'. '+escapeTableText(nameOf(group));
    headings.push({selector:model.nodes[group].selector,title:heading});
    if(input.foldEmpty!==false&&!own.some(note=>note.kind!=='refuted')){lines.push('',heading+' —— 用例 '+rows.length+' 个，无发现');continue;}
    lines.push('',heading,summary(groupCount),'','| 序号 | 用例原文 | Hub 核对 | 评审发现 | 改进建议 |','| --- | --- | --- | --- | --- |');
    for(const [row,index] of rows.entries()){
      const ownRow=own.filter(note=>note.row===index);
      lines.push('| '+(row+1)+' | '+escapeTableText(caseText(model,index,cases,input.preconditionPriority))+' | '+list(ownRow,'hub')+' | '+list(ownRow,'finding')+' | '+list(ownRow,'suggestion')+' |');
    }
    const sub=own.filter(note=>note.row===null);
    if(sub.some(note=>note.kind!=='refuted'))lines.push('');
    if(sub.some(note=>note.kind==='finding'))lines.push('子项上的发现：'+list(sub,'finding'));
    if(sub.some(note=>note.kind==='hub'))lines.push('子项上的 Hub 核对：'+list(sub,'hub'));
    if(sub.some(note=>note.kind==='suggestion'))lines.push('子项上的建议：'+list(sub,'suggestion'));
  }
  lines.push('','### 跨子项（落在文档或更上层的节点上）','- 发现：'+list(cross,'finding'),'- Hub 核对：'+list(cross,'hub'),'- 建议：'+list(cross,'suggestion'));
  const markdown=lines.join('\n')+'\n';let search=0;
  const starts=headings.map(heading=>{const start=markdown.indexOf('\n'+heading.title,search)+1;search=start+heading.title.length;return {selector:heading.selector,start};});
  const crossStart=markdown.lastIndexOf('\n### 跨子项')+1;
  const ranges=starts.map((entry,index)=>({...entry,end:starts[index+1]?.start??crossStart}));
  return {markdown,counts:{...counts,characters:{total:markdown.length,subitems:ranges}}};
}
