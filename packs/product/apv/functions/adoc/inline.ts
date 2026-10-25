// Inline structure is owned by the pinned engine. Private identity attributes bind its actual quoted nodes to
// their serialization; plain/passthrough HTML cannot impersonate one. Instrumentation is removed from all output.
import type {AstNode} from './vendor/core.mjs';
import {decodeReferences} from './text.ts';
export interface InlineNode {kind:string;text:string;children?:InlineNode[];authored?:boolean;rendered?:string}
interface Quoted {type:string;text:string;parent:object}
interface Converter {convert_inline_quoted(node:Quoted):Promise<string>}
interface Binding {prefix:string;nodes:Map<string,{kind:string;owner:object;text:string}>}
const bindings=new WeakMap<object,Binding>();
const marker=' data-hub-inline="';
function converterOf(node:object):Converter{return (node as {getConverter():Converter}).getConverter();}
function tagEnd(text:string,start:number):number {
 let quote:string|null=null;for(let at=start;at<text.length;at++){const ch=text[at];if(quote){if(ch===quote)quote=null;}else if(ch==='"'||ch==="'")quote=ch;else if(ch==='>')return at;}return -1;
}
export function observeInline(doc:object,prefix:string):()=>void {
 const converter=converterOf(doc),original=converter.convert_inline_quoted,previous=bindings.get(converter);
 const binding:Binding={prefix,nodes:new Map()};bindings.set(converter,binding);
 converter.convert_inline_quoted=async function(quoted){
  const rendered=await original.call(this,quoted),tag=quoted.type==='strong'?'strong':quoted.type==='emphasis'?'em':quoted.type==='monospaced'?'code':null;
  if(tag===null||!rendered.startsWith('<'+tag))return rendered;
  const end=tagEnd(rendered,1);if(end<0)return rendered;
  const id=prefix+'-'+binding.nodes.size;const parent=quoted.parent as {subAttributes(text:string):string};
  binding.nodes.set(id,{kind:quoted.type,owner:quoted.parent,text:decodeReferences(parent.subAttributes(quoted.text))});
  return rendered.slice(0,end)+marker+id+'"'+rendered.slice(end);
 };
 return ()=>{converter.convert_inline_quoted=original;if(previous)bindings.set(converter,previous);else bindings.delete(converter);};
}
/** Strip only identities emitted by this parse, in linear time, including identities inside unusual raw markup. */
export function cleanInline(node:object,text:string):string {
 const binding=bindings.get(converterOf(node));if(!binding||!text.includes(marker))return text;
 const parts:string[]=[];let at=0;
 for(;;){const start=text.indexOf(marker,at);if(start<0){parts.push(text.slice(at));break;}const end=text.indexOf('"',start+marker.length);if(end<0){parts.push(text.slice(at));break;}
  const id=text.slice(start+marker.length,end);parts.push(text.slice(at,start));if(!binding.nodes.has(id))parts.push(text.slice(start,end+1));at=end+1;
 }
 return parts.join('');
}
export async function inlineContent(node:AstNode):Promise<{converted:string;inline:InlineNode[]}> {
 if(!node.getContent||!['paragraph','admonition','quote','table_cell'].includes(node.context))return {converted:'',inline:[]};
 const value:unknown=await node.getContent(),html=typeof value==='string'?value:Array.isArray(value)&&value.every(part=>typeof part==='string')?value.join('\n'):'';
 const inline=inlineTree(html,bindings.get(converterOf(node)),node),pending=[...inline];
 while(pending.length){const value=pending.pop()!;value.text=cleanInline(node,value.text);if(value.children)pending.push(...value.children);}
 return {converted:cleanInline(node,html),inline};
}
const white=(ch:string)=>ch===' '||ch==='\t'||ch==='\n'||ch==='\r';
/** Complete tag/attribute grammar over the engine serialization; no source-text or Markdown recognition. */
function identity(body:string,start:number):string|null {
 let at=start,found:string|null=null;
 while(at<body.length){
  if(white(body[at])||body[at]==='/'){at++;continue;}
  const from=at;while(at<body.length&&!white(body[at])&&body[at]!=='=')at++;
  const name=body.slice(from,at);while(at<body.length&&white(body[at]))at++;
  if(body[at]!=='=')return null;at++;while(at<body.length&&white(body[at]))at++;
  const quote=body[at];if(quote!=='"'&&quote!=="'")return null;
  const end=body.indexOf(quote,++at);if(end<0)return null;
  if(name==='data-hub-inline'){if(found!==null)return null;found=body.slice(at,end);}
  at=end+1;
 }
 return found;
}
export function inlineTree(html:string,binding?:Binding,owner?:object):InlineNode[]{
 const root:InlineNode={kind:'root',text:'',children:[]},stack:Array<{tag:string;node:InlineNode;source?:string}>=[{tag:'',node:root}],seen=new Set<string>();let at=0;
 const append=(node:InlineNode)=>stack.at(-1)!.node.children!.push(node);
 while(at<html.length){
  if(html[at]!=='<'){const end=html.indexOf('<',at),to=end<0?html.length:end;append({kind:'text',text:decodeReferences(html.slice(at,to))});at=to;continue;}
  const start=at++,end=tagEnd(html,at);if(end<0)return [{kind:'other',text:decodeReferences(html)}];
  at=end+1;const token=html.slice(start+1,end),closing=token[0]==='/',body=closing?token.slice(1):token;
  let length=0;while(length<body.length&&!white(body[length])&&body[length]!=='/')length++;
  const tag=body.slice(0,length);
  if(closing){if(stack.length===1||stack.at(-1)!.tag!==tag)return [{kind:'other',text:decodeReferences(html)}];const item=stack.pop()!,value=item.node;const rendered=value.children!.map(child=>child.rendered??child.text).join('');value.text=item.source??rendered;if(item.source!==undefined)value.rendered=rendered;continue;}
  const id=identity(body,length),record=id===null?undefined:binding?.nodes.get(id);
  const expected=record?.kind==='strong'?'strong':record?.kind==='emphasis'?'em':record?.kind==='monospaced'?'code':null;
  const trusted=record!==undefined&&expected===tag&&id!==null&&!seen.has(id);if(trusted)seen.add(id!);
  const node:InlineNode={kind:trusted?record!.kind:'other',text:'',children:[],...(trusted?{authored:record!.owner===owner}:{})};append(node);
  if(body.endsWith('/')||['br','img','hr','wbr'].includes(tag))continue;
  stack.push({tag,node,...(trusted?{source:record!.text}:{})});
 }
 return stack.length===1?root.children!:[{kind:'other',text:decodeReferences(html)}];
}
/** A paragraph contains exactly one authored strong, optionally whitespace plus one authored emphasis. */
export function paragraphSignature(block:{kind:string;inline?:InlineNode[]}):{command:string;parameters:string}|null {
 if(block.kind!=='paragraph'||!block.inline)return null;
 const nodes=block.inline;
 if(nodes[0]?.kind!=='strong'||nodes[0].authored!==true||nodes[0].children?.some(child=>child.kind!=='text'))return null;
 if(nodes.length===1)return {command:nodes[0].text,parameters:''};
 if(nodes.length!==3||nodes[1].kind!=='text'||!nodes[1].text.length||nodes[1].text.trim()!==''||nodes[2].kind!=='emphasis'||nodes[2].authored!==true||nodes[2].children?.some(child=>child.kind!=='text'))return null;
 return {command:nodes[0].text,parameters:nodes[2].text};
}
