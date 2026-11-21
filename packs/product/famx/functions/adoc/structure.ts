// Published paragraph structure and a bounded signature grammar. Tree words compare exactly, never by prefix.
import {commandTokens,type CommandGrammar} from '../commands.ts';
import {paragraphSignature,type InlineNode} from './inline.ts';
import type {CatalogSignature} from '../../../../../contracts/src/tables.ts';
export const SIGNATURE_STRUCTURE={schema:'famx-adoc-signature-structure@1',block:'paragraph',inline:['strong','optional whitespace + emphasis'],command_word_grammar:'locked-tree-path-and-ascii-drift-slot@1',variants:'bounded {a|b} groups',parameter_authority:'locked command-tree declarations',other_blocks:'chapter content'} as const;
const word=(text:string)=>text.length>0&&[...text].every(ch=>ch.charCodeAt(0)>=33&&ch.charCodeAt(0)<=126&&!"\"'{}[]<>|".includes(ch));
export interface Signature {command:string;parameters:string;words:string[][];drift_slots:boolean[];params:Array<{name:string;required:boolean}>;parameter_problem:string|null}
/** Expand the declared whole-word variant grammar over the command lexer, preserving every word byte. */
function headWords(text:string):string[][]|null {
 const tokens=commandTokens(text);if(!tokens?.length||tokens.some(token=>token.quoted))return null;
 let variants:string[][]=[[]];
 for(const token of tokens){
  let choices:string[][];
  if(token.value.startsWith('{')&&token.value.endsWith('}'))choices=token.value.slice(1,-1).split('|').map(value=>[value]);
  else if(token.value.startsWith('[')&&token.value.endsWith(']'))choices=[[],...[token.value.slice(1,-1)].map(value=>[value])];
  else choices=[[token.value]];
  if(choices.some(row=>row.some(value=>{const tokens=commandTokens(value);return !tokens||tokens.length!==1||tokens[0].quoted||!value.length||[...value].some(ch=>"\"'{}[]<>|".includes(ch));})))return null;
  if(variants.length*choices.length>64)return null;
  variants=variants.flatMap(prefix=>choices.map(choice=>[...prefix,...choice]));
 }
 return variants.some(row=>!row.length)?null:variants;
}
/** Complete bracket/name parameter grammar, with no markup or name-to-type inference. */
const parameterName=(name:string)=>name.length>0&&[...name].every(ch=>ch.charCodeAt(0)>=32&&ch.charCodeAt(0)!==127&&ch!=='<'&&ch!=='>');
function parameters(text:string,required=true,depth=0):Array<{name:string;required:boolean}>|null {
 if(depth>8)return null;
 const result:Array<{name:string;required:boolean}>=[];let at=0;
 while(at<text.length){
  if(text[at].trim()===''){at++;continue;}
  const opening=text[at],closing=opening==='<'?'>':opening==='['?']':opening==='{'?'}':null;
  if(closing){let end=at+1,level=1;for(;end<text.length;end++){if(text[end]===opening)level++;if(text[end]===closing&&--level===0)break;}
   if(end===text.length)return null;const body=text.slice(at+1,end);
   if(opening==='['){const nested=parameters(body,false,depth+1);if(!nested?.length)return null;result.push(...nested);}
   else {if(!parameterName(body))return null;result.push({name:body,required});}
   at=end+1;
  }else{let end=at;while(end<text.length&&text[end].trim()!=='')end++;const name=text.slice(at,end);if(!parameterName(name)||['[',']','{','}','|'].some(delimiter=>name.includes(delimiter)))return null;result.push({name,required});at=end;}
 }
 return result;
}
export function signatureOf(block:{kind:string;inline?:InlineNode[]}):Signature|null {
 const shape=paragraphSignature(block);if(!shape)return null;
 const words=headWords(shape.command);if(!words)return null;
 const params=parameters(shape.parameters);
 return {...shape,words,drift_slots:words.map(row=>row.every(word)),params:params??[],parameter_problem:params?null:'参数跨度不符合完整的 <必选> / [可选] 参数语法'};
}
export function exactNode(catalog:CommandGrammar|null|undefined,words:readonly string[]):{path:string;signatures:readonly CatalogSignature[]}|null {
 if(!catalog)return null;let node=catalog.root;for(const word of words){const next=node.children.get(word);if(!next)return null;node=next;}
 return node.path===null?null:{path:node.path,signatures:node.signatures??[]};
}
export function parameterProblem(signature:Signature,native:readonly CatalogSignature[]):string|null {
 if(signature.parameter_problem)return signature.parameter_problem;
 if(!native.length)return '命令树没有声明参数签名；下一步由命令树维护者补结构字段';
 const shapes=native.filter(row=>row.params.length===signature.params.length&&row.params.every((param,index)=>param.name===signature.params[index].name&&(param.optional!==true)===signature.params[index].required));
 if(!shapes.length)return '斜体参数声明与锁定命令树不一致：手册 '+JSON.stringify(signature.params)+'；树签名 '+JSON.stringify(native.map(row=>row.params.map(param=>({name:param.name,required:param.optional!==true}))))+'；下一步作者按位置核对名称和必选/可选字段后重产';
 if(shapes.every(row=>row.params.some(param=>param.type===undefined||param.unchecked_constraints?.length)))return '命令树参数类型或约束未声明：'+JSON.stringify(shapes.map(row=>row.params.flatMap((param,position)=>param.type===undefined||param.unchecked_constraints?.length?[{position,name:param.name,type_declared:param.type!==undefined,constraints_checked:!param.unchecked_constraints?.length}]:[])))+'；下一步由命令树维护者补完整结构类型后重产';
 return null;
}
export function mentionsOf(nodes:readonly InlineNode[]=[]):string[]{const out:string[]=[];for(const node of nodes){if(node.kind==='strong'||node.kind==='monospaced')out.push(node.text);if(node.children)out.push(...mentionsOf(node.children));}return out;}
