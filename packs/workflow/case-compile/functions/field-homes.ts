// Where a field name is legal: the places a schema declares it, and what the other plan mode writes in place of a field that
// only one mode has. The refusal of an unknown field uses this to say where the field belongs (round 36: a block carried
// precondition_source, which only a flat step has, and the refusal named neither the places nor the block plan's own home).
import TABLE from '../tables/field-homes.json' with {type:'json'};
import {isRecord} from './text.ts';
import {PLAN_DATA,listed} from './refusal-form.ts';

/** Row of tables/field-homes.json: a field of one plan mode and what the other mode writes instead. */
export interface Counterpart {field:string;declared_at:string;instead:string;says:string}
export const counterparts=():readonly Counterpart[]=>TABLE.counterparts;

/** How deep a schema is read: the item-slot schema is about ten levels deep; a schema deeper than this is not one of ours. */
const DEPTH=32;
const ANY_INDEX='<序号>',ANY_KEY='<键>';

/**
 * Every property name of an item-slot schema (the root of `run.slots.schema`) with the places it is declared, as pointers into the
 * plan file in the form the structure refusals use (`/slots/plan/0/data/steps/<序号>/precondition_source`), in schema order and
 * without repeats. A name declared by several branches of a union (the block kinds) lists the place once.
 */
export function fieldHomes(schema:unknown):ReadonlyMap<string,readonly string[]>{
 const homes=new Map<string,string[]>();
 const add=(name:string,pointer:string):void=>{const list=homes.get(name)??[];if(!list.includes(pointer))list.push(pointer);homes.set(name,list);};
 const visit=(node:unknown,at:string,depth:number):void=>{
  if(!isRecord(node)||depth>DEPTH)return;
  if(isRecord(node.properties))for(const [name,child] of Object.entries(node.properties)){add(name,`${at}/${name}`);visit(child,`${at}/${name}`,depth+1);}
  if(Array.isArray(node.anyOf))for(const branch of node.anyOf)visit(branch,at,depth+1);
  if(isRecord(node.items))visit(node.items,`${at}/${node.maxItems===1?'0':ANY_INDEX}`,depth+1);
  if(isRecord(node.additionalProperties))visit(node.additionalProperties,`${at}/${ANY_KEY}`,depth+1);
 };
 visit(schema,'/slots',0);
 return homes;
}

export interface UnknownFieldNote {
 /** The closed set of fields the node has. */
 allowed:string[];
 /** What else the program knows: where the schema declares the names, and what the other plan mode writes. */
 also:string[];
 /** What the writer does next. */
 next:string;
}

/** The words after "不认识的字段" for the names a node does not have. Says only what the schema and the counterpart table support. */
export function unknownFieldNote(input:{homes:ReadonlyMap<string,readonly string[]>;keys:readonly string[];allowed:readonly string[]}):UnknownFieldNote{
 const also:string[]=[],moves:string[]=[];
 for(const key of input.keys){
  const places=input.homes.get(key);
  if(places!==undefined&&places.length)also.push(`${key} 在模式里的位置：${listed(places,4)}`);
  const row=TABLE.counterparts.find(entry=>entry.field===key);
  if(row!==undefined){also.push(`${row.says}（${PLAN_DATA}${row.instead}）`);moves.push(`${input.keys.length===1?'它':key+' '}的内容改写到 ${PLAN_DATA}${row.instead} 里`);}
 }
 const names=input.keys.join('、');
 const next=moves.length?`从这里删去 ${names}，${moves.join('，')}`
  :also.length?`删去 ${names}，或把它写到上面列出的位置`
  :`删去 ${names}，或改成允许的字段之一`;
 return {allowed:[...input.allowed],also,next};
}
