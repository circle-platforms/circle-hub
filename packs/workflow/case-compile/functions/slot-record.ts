// The structure of one item's slot record, judged against the schema the run froze for it (run.slots.schema, the one start_run
// hands the model), the way the Hub judges a submission before it runs a single check. The offline plan check calls this so a
// plan the Hub refuses by shape (a claim without its text, a field the claim does not have, a count, a value of the wrong type)
// is refused here too. Fail-closed: a schema keyword this reader does not know is reported, never skipped.
import {isRecord} from './text.ts';

export interface SlotRecordProblem { pointer: string; message: string }
type Node=Record<string,unknown>;

const KNOWN=new Set(['$schema','title','description','type','properties','required','additionalProperties','anyOf','const','enum','items','minItems','maxItems','minLength','maxLength','minimum','maximum','pattern']);
const shown=(value:unknown):string=>JSON.stringify(value)??String(value);
const received=(value:unknown):string=>value===undefined?'undefined':value===null?'null':Array.isArray(value)?'数组':typeof value==='string'?'字符串':typeof value==='number'?'数字':typeof value==='boolean'?'布尔值':'对象';
/** What a schema node asks for, in the words of the Hub's own shape refusals (`"<string>"`, `<number>`, an array or an object). */
export function renderShape(node:unknown):string{
 if(!isRecord(node))return '<any>';
 if(Array.isArray(node.enum))return node.enum.map(shown).join(' | ');
 if(Object.hasOwn(node,'const'))return shown(node.const);
 if(Array.isArray(node.anyOf))return node.anyOf.map(renderShape).join(' | ');
 if(node.type==='string')return '"<string>"';
 if(node.type==='boolean')return '<boolean>';
 if(node.type==='number'||node.type==='integer')return '<number>';
 if(node.type==='array')return isRecord(node.items)&&leaf(node.items)?`数组 [${renderShape(node.items)}]`:'数组';
 if(node.type==='object')return '对象';
 return '<any>';
}
const leaf=(node:Node):boolean=>!isRecord(node.properties)&&node.type!=='object'&&node.type!=='array';

const ANNOTATION=new Set(['$schema','title','description']);
/** The alternatives of one node: leaf alternatives are tried as a list; object alternatives are told apart by the constant their kind declares. */
function alternatives(branches:Node[],value:unknown,at:string,out:SlotRecordProblem[],lead:(text:string)=>string,wrong:(expected:string)=>void):void{
 if(branches.every(leaf)){if(!branches.some(branch=>{const probe:SlotRecordProblem[]=[];walk(branch,value,at,probe,lead);return probe.length===0;}))wrong(renderShape({anyOf:branches}));return;}
 const discriminated=isRecord(value)?branches.find(branch=>isRecord(branch.properties)&&isRecord(branch.properties.kind)&&Object.hasOwn(branch.properties.kind,'const')&&branch.properties.kind.const===value.kind):undefined;
 if(discriminated){walk(discriminated,value,at,out,lead);return;}
 if(isRecord(value)&&value.kind!==undefined){
  const kinds=branches.flatMap(branch=>isRecord(branch.properties)&&isRecord(branch.properties.kind)&&Object.hasOwn(branch.properties.kind,'const')?[shown(branch.properties.kind.const)]:[]);
  if(kinds.length){out.push({pointer:`${at}/kind`,message:lead(`${at}/kind 要的是${kinds.join(' | ')}，收到的是${shown(value.kind)}`)});return;}
 }
 let best:SlotRecordProblem[]|null=null;
 for(const branch of branches){const probe:SlotRecordProblem[]=[];walk(branch,value,at,probe,lead);if(probe.length===0)return;if(best===null||probe.length<best.length)best=probe;}
 out.push(...(best??[{pointer:at,message:lead(`${at} 不符合任何一种允许的形状，收到的是${received(value)}`)}]));
}

/** One value against one node; every problem is reported at its own pointer, in the Hub's wording where the Hub has one. */
function walk(node:unknown,value:unknown,at:string,out:SlotRecordProblem[],lead:(text:string)=>string):void{
 if(!isRecord(node))return;
 for(const key of Object.keys(node))if(!KNOWN.has(key)){out.push({pointer:at,message:`${at} 的模式用了本地读不懂的关键字 ${key}；重新下载本次运行的完整 run.json，核对不了的部分以 Hub 回执为准`});return;}
 const wrong=(expected:string):void=>{out.push({pointer:at,message:lead(`${at} 要的是${expected}，收到的是${received(value)}`)});};
 if(Array.isArray(node.anyOf)){
  alternatives(node.anyOf.filter(isRecord),value,at,out,lead,wrong);
  // The other keywords of the node apply as well, as in the claim schema of a requirement that asks for evidence.
  const {anyOf:_alternatives,...rest}=node;
  if(Object.keys(rest).some(key=>!ANNOTATION.has(key)))walk(rest,value,at,out,lead);
  return;
 }
 if(Object.hasOwn(node,'const')){if(value!==node.const)wrong(shown(node.const));return;}
 if(Array.isArray(node.enum)){if(!node.enum.includes(value))wrong(renderShape(node));return;}
 const type=node.type??(isRecord(node.properties)||Array.isArray(node.required)?'object':node.items!==undefined||node.minItems!==undefined||node.maxItems!==undefined?'array':node.minLength!==undefined||node.maxLength!==undefined||node.pattern!==undefined?'string':node.minimum!==undefined||node.maximum!==undefined?'number':undefined);
 if(type==='object'){
  if(!isRecord(value)){wrong('对象');return;}
  const properties=isRecord(node.properties)?node.properties:{};
  for(const key of Array.isArray(node.required)?node.required:[])if(typeof key==='string'&&!Object.hasOwn(value,key))out.push({pointer:`${at}/${key}`,message:lead(`${at}/${key} 要的是${renderShape(properties[key])}，收到的是undefined`)});
  const unknown=Object.keys(value).filter(key=>!Object.hasOwn(properties,key));
  if(unknown.length&&node.additionalProperties===false)out.push({pointer:unknown.length===1?`${at}/${unknown[0]}`:at,message:lead(`不认识的字段 ${unknown.join('、')}`)});
  else if(unknown.length&&isRecord(node.additionalProperties))for(const key of unknown)walk(node.additionalProperties,value[key],`${at}/${key}`,out,lead);
  for(const [key,child] of Object.entries(properties))if(Object.hasOwn(value,key))walk(child,value[key],`${at}/${key}`,out,lead);
  return;
 }
 if(type==='array'){
  if(!Array.isArray(value)){wrong(renderShape(node));return;}
  if(typeof node.minItems==='number'&&value.length<node.minItems)out.push({pointer:at,message:lead(`${at} 至少要有 ${node.minItems} 项，现在 ${value.length} 项`)});
  if(typeof node.maxItems==='number'&&value.length>node.maxItems)out.push({pointer:at,message:lead(`${at} 最多 ${node.maxItems} 项，现在 ${value.length} 项`)});
  if(isRecord(node.items))for(const [index,child] of value.entries())walk(node.items,child,`${at}/${index}`,out,lead);
  return;
 }
 if(type==='string'){
  if(typeof value!=='string'){wrong('"<string>"');return;}
  const length=[...value].length;
  if(typeof node.minLength==='number'&&length<node.minLength)out.push({pointer:at,message:lead(`${at} 要的是至少 ${node.minLength} 个字符的字符串，收到的是 ${length} 个字符`)});
  if(typeof node.maxLength==='number'&&length>node.maxLength)out.push({pointer:at,message:lead(`${at} 要的是至多 ${node.maxLength} 个字符的字符串，收到的是 ${length} 个字符`)});
  if(typeof node.pattern==='string'){let ok=false;try{ok=new RegExp(node.pattern,'u').test(value);}catch{out.push({pointer:at,message:`${at} 的模式用了本地读不懂的正则；核对不了的部分以 Hub 回执为准`});ok=true;}if(!ok)out.push({pointer:at,message:lead(`${at} 的值 ${shown(value.length>200?value.slice(0,200)+'…':value)} 不是声明的写法${typeof node.description==='string'?`：${node.description}`:''}`)});}
  return;
 }
 if(type==='integer'||type==='number'){
  if(typeof value!=='number'||!Number.isFinite(value)||type==='integer'&&!Number.isInteger(value)){wrong(type==='integer'?'整数':'<number>');return;}
  if(typeof node.minimum==='number'&&value<node.minimum)out.push({pointer:at,message:lead(`${at} 要的是不小于 ${node.minimum} 的数，收到的是 ${value}`)});
  if(typeof node.maximum==='number'&&value>node.maximum)out.push({pointer:at,message:lead(`${at} 要的是不大于 ${node.maximum} 的数，收到的是 ${value}`)});
  return;
 }
 if(type==='boolean'){if(typeof value!=='boolean')wrong('<boolean>');return;}
 if(type==='null'){if(value!==null)wrong('null');return;}
 if(type!==undefined)out.push({pointer:at,message:`${at} 的模式用了本地读不懂的类型 ${shown(type)}；核对不了的部分以 Hub 回执为准`});
}

/**
 * The problems of an item's `slots` against the item-slot-record schema of the frozen run, at pointers relative to the item file
 * (`/slots/...`). Claims are read in the Hub's order for each claim (its own fields first, then its `data`), but all problems of
 * one record are reported together: the Hub names the claim's fields in one round and its data in the next.
 */
export function slotRecordProblems(schema:unknown,slots:unknown):SlotRecordProblem[]{
 if(!isRecord(schema)||!isRecord(schema.properties))return [{pointer:'/slots',message:'冻结运行没有槽位模式（run.slots.schema），不能核对槽位记录；重新下载本次运行的完整 run.json，不手写冻结输入'}];
 const declared=Object.keys(schema.properties),out:SlotRecordProblem[]=[];
 if(!isRecord(slots))return [{pointer:'/slots',message:`已处理的条目要给出槽位记录（slots，对象，键是要求项：${declared.join('、')}）或沿用引用（reuse）`}];
 for(const key of Object.keys(slots))if(!declared.includes(key))out.push({pointer:`/slots/${key}`,message:`槽位里没有 ${key}（可填：${declared.join('、')||'无'}）`});
 const plain=(text:string):string=>`提交的结构不对：${text}`,inData=(text:string):string=>`data 不符合要求项 plan 声明的模式：提交的结构不对：${text}`;
 for(const key of declared){
  const requirement=schema.properties[key],value=slots[key];
  if(!isRecord(requirement))continue;
  if(value===undefined){out.push({pointer:'/slots',message:`缺少要求项 ${key} 的槽位；没有要报告的就写空列表 []`});continue;}
  if(!Array.isArray(value)){out.push({pointer:`/slots/${key}`,message:`要求项 ${key} 的槽位是陈述的列表`});continue;}
  const min=typeof requirement.minItems==='number'?requirement.minItems:0,max=typeof requirement.maxItems==='number'?requirement.maxItems:undefined;
  if(value.length<min)out.push({pointer:`/slots/${key}`,message:`要求项 ${key} 至少要有 ${min} 条陈述，现在 ${value.length} 条`});
  if(max!==undefined&&value.length>max)out.push({pointer:`/slots/${key}`,message:`要求项 ${key} 最多 ${max} 条陈述，现在 ${value.length} 条`});
  const claim=isRecord(requirement.items)?requirement.items:null;if(claim===null)continue;
  for(const [index,statement] of value.entries()){
   const at=`/slots/${key}/${index}`,properties=isRecord(claim.properties)?claim.properties:{};
   const { data:declaredData, ...fields }=properties as Node;
   // The claim's own fields first, then its data against the pack's schema; an absent data is judged as {} (as the Hub does).
   walk({...claim,properties:fields,required:(Array.isArray(claim.required)?claim.required:[]).filter(name=>name!=='data')},isRecord(statement)?Object.fromEntries(Object.entries(statement).filter(([name])=>name!=='data')):statement,at,out,plain);
   if(!isRecord(statement)||declaredData===undefined)continue;
   if(statement.data!==undefined&&!isRecord(statement.data))out.push({pointer:`${at}/data`,message:plain(`${at}/data 要的是对象，收到的是${received(statement.data)}`)});
   else walk(declaredData,statement.data??{},`${at}/data`,out,inData);
  }
 }
 return out;
}
