// Device CLI parameters are identified by the frozen runtime contract/profile roles. Only whole grammar parses
// over the Hub-supplied locked catalog produce identities; source case declarations are a separate constraint.
import {compileGrammar,commandIdentity,parseCommandState,commandTokens,type CommandDefinition} from './generated/command-grammar.ts';
import {isRecord} from './text.ts';
import {bindArguments} from './binding.ts';
import {runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import type {RuntimeProfile} from './profile.ts';
import type {PlanSlots} from './slots.ts';
import {identityOf,identityKey} from './typed-contract.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {CatalogEntry} from '../../../../contracts/src/tables.ts';
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
type CommandVerdict = Extract<Verdict, 'unknown' | 'refute'>;
export interface CommandCatalog {policy?:unknown;authority_entries?:CatalogEntry[];root:string;complete:boolean;entries:CatalogEntry[];covered_lines?:string[]}
export interface CommandProblem {document:string;pointer:string;message:string;verdict:CommandVerdict}
export function deviceCommandLines(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots):Array<{line:string;pointer:string}>{
 const lines:Array<{line:string;pointer:string}>=[];
 for(const [index,step]of slots.steps.entries()){const entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);if(!entry||!allowed)continue;for(const value of bindArguments(entry,step,`/steps/${index}`).values)if(allowed.parameters[value.name]==='device_cli'&&typeof value.value==='string')lines.push({line:value.value,pointer:value.pointer});}
 return lines;
}
export function planCommands(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,raw:unknown):{identities:CommandIdentity[];byLine:Map<string,CommandIdentity>;problems:CommandProblem[];catalog:CommandCatalog|null}{
 const lines=deviceCommandLines(contract,profile,slots);
 const evidence=isRecord(raw)?{...(raw.policy!==undefined?{policy:raw.policy}:{}),...(Array.isArray(raw.authority_entries)?{authority_entries:raw.authority_entries}:Array.isArray(raw.entries)?{authority_entries:raw.entries}:{})}:{};
 const problems:CommandProblem[]=[],byLine=new Map<string,CommandIdentity>();const note=(pointer:string,message:string,verdict:CommandVerdict='unknown')=>problems.push({document:'catalog',pointer,message,verdict});
 const declarations=(identities:CommandIdentity[]):void=>{ if(slots.command_identities!==undefined){if(!Array.isArray(slots.command_identities)){note('/command_identities','模型提交的可选命令身份声明不是列表','refute');return;}const declared=slots.command_identities.map(identityOf);if(declared.some(identity=>identity===null))note('/command_identities','模型提交的命令身份结构或类型化值不一致','refute');else{const supplied=new Set(declared.map(identity=>identityKey(identity!))),actual=new Set(identities.map(identityKey));if(supplied.size!==actual.size||[...actual].some(key=>!supplied.has(key)))note('/command_identities','模型提交的命令身份不等于锁定目录对计划命令的完整解析','refute');}}};
 if(!lines.length){declarations([]);return {identities:[],byLine,problems,catalog:isRecord(raw)&&typeof raw.root==='string'&&typeof raw.complete==='boolean'?{root:raw.root,complete:raw.complete,entries:[],covered_lines:[],...evidence}:null};}
 if(!isRecord(raw)||typeof raw.root!=='string'||!Array.isArray(raw.entries)||typeof raw.complete!=='boolean'){note('/command_catalog','缺 Hub 按锁定根提供的 commands 目录；不能用用例身份或模型自报身份代替完整解析');return {identities:[],byLine,problems,catalog:null};}
 if(typeof raw.missing==='string'){note('/command_catalog',raw.missing);return {identities:[],byLine,problems,catalog:null};}
 const catalog=raw as unknown as CommandCatalog;const definitions:CommandDefinition[]=[],candidates=new Set<CatalogEntry>();
 for(const entry of catalog.entries){if(!isRecord(entry)||!Array.isArray(entry.words)||entry.words.some(word=>typeof word!=='string'||!word)||!Array.isArray(entry.signatures)||typeof entry.reference!=='string')continue;const path='/commands/'+entry.words.map(encodeURIComponent).join('/'),ref='tree:'+catalog.root+path;
  if(entry.reference!==ref&&!(entry.reference.slice(0,ref.length+1)===ref+'@'&&entry.reference.slice(ref.length+1).length===64))continue;
  definitions.push({path,words:entry.words,signatures:entry.signatures});
  if(lines.some(({line})=>{const tokens=commandTokens(line);return tokens&&entry.words.every((word,index)=>tokens[index]?.value===word&&!tokens[index].quoted);}))candidates.add(entry as CatalogEntry);
 }
 const grammar=compileGrammar(definitions);
 for(const {line,pointer}of lines){if(catalog.covered_lines&&!catalog.covered_lines.includes(line)){note(pointer,'目录回执未覆盖这条完整计划命令；重新核验计划以取得锁定目录依据');continue;}const state=parseCommandState(grammar,line),parsed=commandIdentity(grammar,line),identity=parsed?identityOf(parsed):null;
  if(identity)byLine.set(line,identity);else if(state.status==='parameters_unchecked'||state.status==='parsed')note(pointer,state.missing??'完整签名缺类型、原始声明或唯一身份；下一步由目录生产器补结构声明后重核');else note(pointer,'不是锁定 /commands 完整语法可解析的命令；逐词、参数类型和完整消费均须满足',catalog.complete?'refute':'unknown');
 }
 const identities=[...new Map([...byLine.values()].map(identity=>[identityKey(identity),identity])).values()];
 declarations(identities);
 return {identities,byLine,problems,catalog:{root:catalog.root,complete:catalog.complete,entries:[...candidates],...evidence,covered_lines:[...new Set(lines.map(value=>value.line))]}};
}
