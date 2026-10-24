// R4: a command is one complete declared source line, never a phrase fished out of prose.
// Syntax comes from the locked tree's words/signatures (C07), and parameter domains from
// contracts/src/tables.ts CatalogParam. Exact case and characters; ASCII SP/HT delimit tokens,
// CR/LF delimit statements, single/double quotes delimit argument values with quote/backslash escapes.
// No text folding, inferred no form, longest-prefix acceptance or natural-language boundary rules.
import type {CommandParseStatus} from './generated/vocabulary.ts';
import type { CatalogParam, CatalogSignature } from '../../../../contracts/src/tables.ts';
import type { CommandsResult } from './types.ts';
import { guarded, isRecord } from './util.ts';

export type CommandDefinition = { declarations?:Record<string,{selector:string;parameters:Array<{name:string;selector:string}>}>; path: string; words: readonly string[]; signatures: readonly CatalogSignature[] };
export type GrammarNode = { children: Map<string, GrammarNode>; path: string | null; signatures?: readonly CatalogSignature[] };
export type CommandGrammar = { root: GrammarNode; size: number; heads: string[]; definitions?:readonly CommandDefinition[]; tree_root?:string };
const node = (): GrammarNode => ({children:new Map(),path:null,signatures:[]});
type Token = {value:string;quoted:boolean;raw:string};

/** Complete lexical analysis, preserving whether a token is an argument literal. */
export function commandTokens(text:string):Token[]|null {
  if(text.length>2000)return null;
  const out:Token[]=[];
  for(let at=0;at<text.length;){
    if(text[at]===' '||text[at]==='\t'){at++;continue;}
    if(text[at]==='\r'||text[at]==='\n'||text.charCodeAt(at)===0)return null;
    const start=at;
    const quoted=text[at]==='"'||text[at]==="'";let value='';
    if(quoted){
      const quote=text[at++];let closed=false;
      while(at<text.length){const c=text[at++];if(c==='\r'||c==='\n'||c.charCodeAt(0)===0)return null;if(c===quote){closed=true;break;}if(c==='\\'){if(text[at]!==quote&&text[at]!=='\\')return null;value+=text[at++];}else value+=c;}
      if(!closed||at<text.length&&text[at]!==' '&&text[at]!=='\t')return null;
    }else while(at<text.length&&text[at]!==' '&&text[at]!=='\t'){if(text[at]==='\r'||text[at]==='\n'||text.charCodeAt(at)===0)return null;value+=text[at++];}
    out.push({value,quoted,raw:text.slice(start,at)});if(out.length>320)return null;
  }
  return out;
}

export function compileGrammar(definitions:readonly CommandDefinition[]):CommandGrammar {
  const root=node();const heads:string[]=[];let size=0;
  for(const definition of definitions){
    if(!definition.words.length||!definition.path||definition.words.some(w=>!w||commandTokens(w)?.length!==1))continue;
    let current=root;
    for(const word of definition.words){let next=current.children.get(word);if(!next){next=node();current.children.set(word,next);}current=next;}
    if(current.path!==null&&current.path!==definition.path)throw new Error('同一精确命令身份出现不同路径');
    if(current.path===null){size++;heads.push(definition.words.join(' '));}
    current.path=definition.path;current.signatures=[...(current.signatures??[]),...definition.signatures];
  }
  return {root,size,heads,definitions};
}
const digits=(value:string)=>value.length>0&&[...value].every(c=>c>='0'&&c<='9');
function ipv4(value:string):boolean {const parts=value.split('.');return parts.length===4&&parts.every(p=>digits(p)&&p.length<=3&&(p==='0'||p[0]!=='0')&&Number(p)<=255);}
function ipv6(value:string):boolean {
  if(value.includes('%')||value.includes(':::'))return false;
  const split=value.split('::');if(split.length>2)return false;
  const parts=value.split(':');let count=0;
  for(let i=0;i<parts.length;i++){
    const part=parts[i];if(!part)continue;
    if(part.includes('.')){if(i!==parts.length-1||!ipv4(part))return false;count+=2;}
    else {if(part.length>4||![...part].every(c=>'0123456789abcdefABCDEF'.includes(c)))return false;count++;}
  }
  return split.length===2?count<8:count===8&&!value.startsWith(':')&&!value.endsWith(':');
}
function hostname(value:string):boolean {
  const s=value.endsWith('.')?value.slice(0,-1):value;
  return s.length>0&&s.length<=253&&!ipv4(s)&&!ipv6(s)&&s.split('.').every(p=>p.length>0&&p.length<=63&&p[0]!=='-'&&p.at(-1)!=='-'&&[...p].every(c=>c>='a'&&c<='z'||c>='A'&&c<='Z'||c>='0'&&c<='9'||c==='-'));
}
function accepts(param:CatalogParam,value:string):boolean {
  if(param.unchecked_constraints?.length)return false;
  const length=[...value].length;if(param.minLength!==undefined&&length<param.minLength||param.maxLength!==undefined&&length>param.maxLength)return false;
  switch(param.type){
    case 'string':return true;
    case 'keyword':return value===(param.keyword??param.name);
    case 'enum':return param.values?.includes(value)??false;
    case 'int':case 'port':{
      const s=value.startsWith('-')?value.slice(1):value;if(!digits(s))return false;
      const n=Number(value);return Number.isSafeInteger(n)&&(param.minimum===undefined||n>=param.minimum)&&(param.maximum===undefined||n<=param.maximum)&&(param.type!=='port'||n>=0&&n<=65535);
    }
    case 'ipv4':return ipv4(value);
    case 'ipv6':return ipv6(value);
    case 'hostname':return hostname(value);
    case 'ip_or_hostname':return ipv4(value)||ipv6(value)||hostname(value);
    case 'mask':{
      if(!ipv4(value))return false;const bits=value.split('.').map(p=>Number(p).toString(2).padStart(8,'0')).join('');let zero=false;for(const bit of bits){if(bit==='0')zero=true;else if(zero)return false;}return true;
    }
    default:return false;
  }
}
function signatureMatches(signature:CatalogSignature,tokens:readonly Token[],allowUnchecked=false):boolean {
  if(!allowUnchecked && signature.params.some(param=>param.type===undefined))return false;
  const memo=new Map<string,boolean>();
  const walk=(p:number,t:number):boolean=>{
    const key=p+':'+t;if(memo.has(key))return memo.get(key)!;
    const param=signature.params[p];
    const result=p===signature.params.length?t===tokens.length:(param.optional===true&&(allowUnchecked||param.default===undefined||!param.unchecked_constraints?.length)&&walk(p+1,t)||t<tokens.length&&(allowUnchecked&&(param.type===undefined||!!param.unchecked_constraints?.length)?param.type===undefined||accepts({...param,unchecked_constraints:undefined},tokens[t].value):accepts(param,tokens[t].value))&&walk(p+1,t+1));
    memo.set(key,result);return result;
  };
  return walk(0,0);
}
/** Ambiguous complete parses cannot establish one identity. Arguments never start another command. */
export type CommandParse={status:CommandParseStatus;path:string|null;missing?:string;exit?:{next_action:string;audience:string;due:string}};
export function parseCommandState(grammar:CommandGrammar,text:string):CommandParse {
  const tokens=commandTokens(text);if(!tokens?.length)return {status:'not_command',path:null};
  let current=grammar.root;const found=new Set<string>();const unchecked=new Set<string>();
  for(let at=0;at<tokens.length;at++){
    if(tokens[at].quoted)break;const next=current.children.get(tokens[at].value);if(!next)break;current=next;
    if(current.path===null)continue;
    if(current.signatures?.some(s=>signatureMatches(s,tokens.slice(at+1))))found.add(current.path);
    else if(current.signatures?.some(s=>signatureMatches(s,tokens.slice(at+1),true)))unchecked.add(current.path);
  }
  const sole=found.size===1?[...found][0]:null;
  if(sole!==null&&[...unchecked].every(path=>path===sole))return {status:'parsed',path:sole};
  return unchecked.size>0||found.size>1?{status:'parameters_unchecked',path:null,missing:'命令树中该参数的结构化类型或唯一完整签名尚未声明，涉及路径：'+[...unchecked,...found].join('、'),exit:{next_action:'包作者或命令树维护者补结构化类型与唯一完整签名后重产',audience:'包作者',due:'下一次生产之前'}}:{status:'not_command',path:null};
}
export function parseCommand(grammar:CommandGrammar,text:string):string|null{return parseCommandState(grammar,text).path;}
export function commandLines(text:string):Array<{text:string;start:number;end:number}> {
  const out:Array<{text:string;start:number;end:number}>=[];let start=0;
  for(let at=0;at<=text.length;at++)if(at===text.length||text[at]==='\r'||text[at]==='\n'){
    out.push({text:text.slice(start,at),start,end:at});if(text[at]==='\r'&&text[at+1]==='\n')at++;start=at+1;
  }
  return out;
}
/** Explicit complete-line slots plus typed definitions; a head-only list is insufficient evidence. */
export function extractCommands(input:{text:string;heads?:string[];definitions?:CommandDefinition[]}):CommandsResult {
  if(!isRecord(input)||typeof input.text!=='string')return {phrases:[],warnings:['text 不是字符串']};
  if(!Array.isArray(input.definitions))return {phrases:[],warnings:['缺锁定命令树的完整类型语法；下一步：包作者绑定 words/signatures 后重跑']};
  if(input.text.length>1_000_000||input.definitions.length>100_000)return {phrases:[],warnings:['输入超过完整解析上限；下一步：包作者分片后重跑，不截断当作完整']};
  const grammar=compileGrammar(input.definitions);
  return {phrases:commandLines(input.text).filter(line=>parseCommand(grammar,line.text)!==null),warnings:[]};
}
export default function commands(input:unknown):CommandsResult {
  return guarded(()=>extractCommands(input as Parameters<typeof extractCommands>[0]),warning=>({phrases:[],warnings:[warning]}));
}

/** Fully consumed, uniquely typed identity; no identity exists for an undeclared type. */
export function commandIdentity(grammar:CommandGrammar,text:string):import('../../../../contracts/generated/shared-interfaces.ts').CommandIdentity|null {
 const tokens=commandTokens(text),state=parseCommandState(grammar,text);
 if(!tokens||state.status!=='parsed'||!grammar.tree_root)return null;
 const identities:import('../../../../contracts/generated/shared-interfaces.ts').CommandIdentity[]=[];
 for(const definition of grammar.definitions??[]){
  if(definition.path!==state.path||!definition.words.every((word,i)=>tokens[i]?.value===word))continue;
  const args=tokens.slice(definition.words.length);
  for(const signature of definition.signatures){
   const declaration=definition.declarations?.[signature.id??''];
   if(!signature.reference||!declaration||declaration.parameters.length!==signature.params.length||declaration.parameters.some(param=>!param.name)||!signatureMatches(signature,args))continue;
   const bind=(p:number,t:number):Array<{position:number;raw:string;value:string}>|null=>{
    if(p===signature.params.length)return t===args.length?[]:null;
    const param=signature.params[p];
    if(t<args.length&&accepts(param,args[t].value)){const tail=bind(p+1,t+1);if(tail)return [{position:p,raw:args[t].raw,value:args[t].value},...tail];}
    return param.optional===true?bind(p+1,t):null;
   };
   const bound=bind(0,0);if(!bound)continue;
   const parameters=bound.map(({position,raw,value})=>{const param=signature.params[position];
    const parsed:import('../../../../contracts/generated/shared-interfaces.ts').ParsedParameterValue=param.type==='int'||param.type==='port'?{kind:'int',value:Number(value)}:param.type==='ipv4'||param.type==='ipv6'||param.type==='mask'?{kind:'address',value:{kind:param.type,value}}:{kind:'text',value};
    return {position,name:param.name,raw,type:{name:declaration.parameters[position].name,catalog_type:param.type!,declaration:`src:${grammar.tree_root}#xml@1:${declaration.parameters[position].selector}`,grammar:'apv-command-tree@2'},parsed};
   });
   identities.push({tree_root:grammar.tree_root,path:definition.path,signature:signature.reference,parameters});
  }
 }
 const unique=[...new Map(identities.map(identity=>[JSON.stringify(identity),identity])).values()];
 return unique.length===1?unique[0]:null;
}
