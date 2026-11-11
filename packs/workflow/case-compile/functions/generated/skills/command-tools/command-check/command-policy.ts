// Exact path segments and product-authored structure only. No command words are classified here.
const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);
import {commandTokens} from './grammar.ts';
export interface Confirmation {command_prefix:string;prompt:string;answer:string}
export interface PolicyCommand {prefix:string;with_parameter?:number}
export interface PersistenceChannel {id:string;commands:PolicyCommand[];source:string}
export interface ForbiddenCombination {id:string;side_a:PolicyCommand[];side_b:PolicyCommand[];source:string}
export interface CommandPolicy {schema:'command-policy@1';read_only:string[];inverse_rules:Array<{source_prefix:string;inverse_prefix:string;leading_parameters?:number}>;inverse_alternatives?:Array<[string,string]>;confirmations?:Confirmation[];persistence_channels?:PersistenceChannel[];forbidden_combinations?:ForbiddenCombination[]}
export function pathSegments(path:unknown):string[]|null {
 if(typeof path!=='string'||!path.startsWith('/'))return null;
 const parts=path.slice(1).split('/');if(parts[0]!=='commands'||parts.some(part=>!part||part==='.'||part==='..'||/[\u0000-\u0020]/.test(part)))return null;
 try{parts.forEach(part=>decodeURIComponent(part));}catch{return null;}return parts;
}
export function within(path:string,prefix:string):boolean {const a=pathSegments(path),b=pathSegments(prefix);return !!a&&!!b&&a.length>=b.length&&b.every((part,index)=>a[index]===part);}
const wordsOf=(prefix:string)=>pathSegments(prefix)!.slice(1).map(decodeURIComponent);
/** The line the product's most specific rule makes of a command: the rule's inverse words, then the rest of the command as written. */
export function inverseLine(policy:CommandPolicy,line:string):string|null {
 const tokens=commandTokens(line);if(!tokens)return null;
 const fits=policy.inverse_rules.filter(rule=>wordsOf(rule.source_prefix).every((word,index)=>tokens[index]?.value===word&&!tokens[index].quoted)).sort((a,b)=>wordsOf(b.source_prefix).length-wordsOf(a.source_prefix).length);
 const rule=fits[0];if(!rule||fits[1]?.source_prefix===rule.source_prefix)return null;
 return [...wordsOf(rule.inverse_prefix),...tokens.slice(wordsOf(rule.source_prefix).length).map(token=>token.raw)].join(' ');
}
/** Every command's line under the rule, read with the plan so a check can tell a cleanup left out from one the locked tree does not have: all of them, or none when they do not fit the selection's limits. */
export function inverseLines(policy:CommandPolicy|null,lines:readonly string[]):string[] {
 if(!policy)return [];
 const fresh=[...new Set(lines.flatMap(line=>{const inverse=inverseLine(policy,line);return inverse!==null&&!lines.includes(inverse)&&Buffer.byteLength(inverse)<=8192?[inverse]:[];}))];
 return lines.length+fresh.length<=128?fresh:[];
}
const declaredCommands=(list:unknown)=>Array.isArray(list)&&list.length>=1&&list.length<=64&&list.every(row=>isRecord(row)&&Object.keys(row).every(name=>name==='prefix'||name==='with_parameter')&&!!pathSegments(row.prefix)&&(row.with_parameter===undefined||Number.isSafeInteger(row.with_parameter)&&Number(row.with_parameter)>=0&&Number(row.with_parameter)<=255));
export function readCommandPolicy(value:unknown):CommandPolicy|null {
 if(!isRecord(value)||value.schema!=='command-policy@1'||Object.keys(value).some(key=>!['schema','read_only','inverse_rules','inverse_alternatives','confirmations','persistence_channels','forbidden_combinations'].includes(key))||!Array.isArray(value.read_only)||value.read_only.length>64||value.read_only.some(path=>!pathSegments(path))||!Array.isArray(value.inverse_rules)||value.inverse_rules.length>64)return null;
 for(const rule of value.inverse_rules)if(!isRecord(rule)||Object.keys(rule).some(key=>!['source_prefix','inverse_prefix','leading_parameters'].includes(key))||!pathSegments(rule.source_prefix)||!pathSegments(rule.inverse_prefix)||rule.leading_parameters!==undefined&&(!Number.isSafeInteger(rule.leading_parameters)||Number(rule.leading_parameters)<0||Number(rule.leading_parameters)>128))return null;
 // Inverse alternatives are exact closed-set pairs of non-space values; a value paired with itself is meaningless.
 if(value.inverse_alternatives!==undefined){
  if(!Array.isArray(value.inverse_alternatives)||value.inverse_alternatives.length>64)return null;
  const partners=new Map<string,string>();
  for(const pair of value.inverse_alternatives){
   if(!Array.isArray(pair)||pair.length!==2||pair.some(member=>typeof member!=='string'||!/\S/.test(member))||pair[0]===pair[1])return null;
   for(const [from,to]of [[pair[0],pair[1]],[pair[1],pair[0]]]){if(partners.has(from)&&partners.get(from)!==to)return null;partners.set(from,to);}
  }
 }
 // A confirmation is the product's declared dialogue: one prompt text and one answer word per command prefix.
 if(value.confirmations!==undefined){
  if(!Array.isArray(value.confirmations)||value.confirmations.length>16)return null;
  const prefixes=new Set<string>();
  for(const row of value.confirmations){
   if(!isRecord(row)||Object.keys(row).some(key=>!['command_prefix','prompt','answer'].includes(key))||!pathSegments(row.command_prefix)||prefixes.has(String(row.command_prefix)))return null;
   if(typeof row.prompt!=='string'||!/^\S(?:.*\S)?$/.test(row.prompt)||row.prompt.length>64||typeof row.answer!=='string'||!/^\S+$/.test(row.answer)||row.answer.length>16)return null;
   prefixes.add(String(row.command_prefix));
  }
 }
 for(const key of ['persistence_channels','forbidden_combinations']as const){
  const rows=value[key];if(rows===undefined)continue;
  if(!Array.isArray(rows)||rows.length>16)return null;
  const ids=new Set<string>();
  for(const row of rows){
   const sides=key==='persistence_channels'?['commands']:['side_a','side_b'];
   if(!isRecord(row)||Object.keys(row).some(name=>!['id','source',...sides].includes(name))||typeof row.id!=='string'||!/^[a-z][a-z0-9_]{0,39}$/.test(row.id)||ids.has(row.id))return null;
   if(typeof row.source!=='string'||row.source.length<1||row.source.length>400||/[\r\n]/.test(row.source)||sides.some(name=>!declaredCommands(row[name])))return null;
   ids.add(row.id);
  }
 }
 return value as unknown as CommandPolicy;
}
export interface ParsedCommand {path:string;parameters:ReadonlyArray<{position:number}>;line?:string|null}
export interface CaseProfile {
 channels:Array<{id:string;source:string;commands:string[]}>;
 sides:Array<{combination:string;side:'a'|'b';source:string;commands:string[]}>;
}
export function commandCounts(command:ParsedCommand,declared:PolicyCommand):boolean {
 return within(command.path,declared.prefix)&&(declared.with_parameter===undefined||command.parameters.some(parameter=>parameter.position===declared.with_parameter));
}
export function caseProfile(policy:CommandPolicy|null,commands:readonly ParsedCommand[]):CaseProfile {
 const hits=(declared:readonly PolicyCommand[])=>[...new Set(commands.filter(command=>declared.some(row=>commandCounts(command,row))).map(command=>command.line??command.path))].slice(0,5);
 return {
  channels:(policy?.persistence_channels??[]).flatMap(channel=>{const lines=hits(channel.commands);return lines.length?[{id:channel.id,source:channel.source,commands:lines}]:[];}),
  sides:(policy?.forbidden_combinations??[]).flatMap(row=>(['a','b']as const).flatMap(side=>{const lines=hits(side==='a'?row.side_a:row.side_b);return lines.length?[{combination:row.id,side,source:row.source,commands:lines}]:[];})),
 };
}
export function volumeOrder<T extends {profile:CaseProfile}>(cases:readonly T[]):{ordered:T[];moved:T[]} {
 const moved=cases.filter(row=>row.profile.channels.length>0),others=cases.filter(row=>row.profile.channels.length===0);
 return {ordered:[...others,...moved],moved:others.length>0?moved:[]};
}
export interface VolumeConflict {combination:string;source:string;side_a:string[];side_b:string[]}
export function volumeConflicts(cases:ReadonlyArray<{id:string;profile:CaseProfile}>):VolumeConflict[] {
 const found=new Map<string,VolumeConflict>();
 for(const row of cases)for(const side of row.profile.sides){
  const conflict=found.get(side.combination)??{combination:side.combination,source:side.source,side_a:[],side_b:[]};
  conflict[side.side==='a'?'side_a':'side_b'].push(row.id);found.set(side.combination,conflict);
 }
 return [...found.values()].filter(conflict=>conflict.side_a.length>0&&conflict.side_b.length>0);
}
export function authorTexts(value:unknown):string[]{const fields=isRecord(value)?value:{},out:string[]=[];if(Array.isArray(fields.source_atoms))return fields.source_atoms.filter(isRecord).filter(a=>a.kind!=='intent'&&typeof a.content==='string').map(a=>String(a.content));if(typeof fields.title==='string')out.push(fields.title);if(Array.isArray(fields.expected))out.push(...fields.expected.filter((text):text is string=>typeof text==='string'));for(const step of Array.isArray(fields.steps)?fields.steps:[])if(isRecord(step)){if(typeof step.text==='string')out.push(step.text);if(Array.isArray(step.expected))out.push(...step.expected.filter((text):text is string=>typeof text==='string'));}return out;}
