import {pathSegments} from './command-policy.ts';
// runtime-contract@2 declarations are policy inputs, never inferences from names or prose.
import {schema} from './schema.ts';
import TYPE from '../tables/declared-type.schema.json' with {type:'json'};
import ROLE from '../tables/declared-role.schema.json' with {type:'json'};
import ADDRESS from '../tables/typed-address.schema.json' with {type:'json'};
import IDENTITY from '../tables/command-identity.schema.json' with {type:'json'};
import type {CommandIdentity,DeclaredParameterType} from '../../../../contracts/generated/shared-interfaces.ts';
import {isRecord} from './text.ts';
import {addressKey} from './manifest.ts';
const Type=schema(TYPE),Role=schema(ROLE),Address=schema(ADDRESS),Identity=schema(IDENTITY);
export interface ValueType {declaration:DeclaredParameterType;address_kind?:string;values?:string[];literal?:string;minimum?:number;maximum?:number;minLength?:number;maxLength?:number}
export interface RoleDeclaration {source:string;bed_member?:boolean}
export interface Effect {id:string;source:string;roles:string[];budget:number;commands?:CommandIdentity[];command_scope?:string[];allowed_literals:string[];command_roles:Array<{signature:string;position:number;role:string}>}
export interface Authority {source:string;parameters:Record<string,{type:ValueType;role:string}>;roles:Record<string,RoleDeclaration>;effects:Effect[]}
const ground=(name:string,value:unknown):value is string=>Role.safeParse({name,declaration:value}).success;
export function identityOf(value:unknown):CommandIdentity|null {
 const read=Identity.safeParse(value);if(!read.success)return null;
 const identity=read.data as CommandIdentity;
 const root=identity.signature.startsWith('src:')?identity.signature.slice(4).split('/')[0]:identity.signature.startsWith('tree:')?identity.signature.slice(5).split('/')[0]:null;
 if(root!==identity.tree_root||new Set(identity.parameters.map(p=>p.position)).size!==identity.parameters.length)return null;
 for(const p of identity.parameters){const decoded=argumentValue(p.raw);if(decoded===null)return null;const parsed=p.parsed;
  if(parsed.kind==='address'){if(String(parsed.value.value)!==decoded)return null;}
  else if(parsed.kind==='int'||parsed.kind==='number'){if(!/^-?[0-9]+$/.test(decoded)||Number(decoded)!==parsed.value)return null;}
  else if(parsed.kind==='boolean'){if(decoded!==(parsed.value?'true':'false'))return null;}
  else if(parsed.value!==decoded)return null;
 }
 return identity;
}
/** One complete argument of the declared SP/HT, quote/backslash grammar. */
function argumentValue(raw:string):string|null {
 if(!raw.length||/[\r\n\u0000]/.test(raw))return null;
 if(raw[0]!=="'"&&raw[0]!=='"')return /[ \t]/.test(raw)?null:raw;
 const quote=raw[0];let value='';for(let at=1;at<raw.length;at++){const c=raw[at];if(c===quote)return at===raw.length-1?value:null;if(c==='\\'){if(raw[at+1]!==quote&&raw[at+1]!=='\\')return null;value+=raw[++at];}else value+=c;}return null;
}
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(isRecord(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export function identityKey(i:CommandIdentity):string{return JSON.stringify([i.tree_root,i.path,i.signature,[...i.parameters].sort((a,b)=>a.position-b.position).map(p=>[p.position,p.name,[p.type.name,p.type.grammar,p.type.declaration],canonical(p.parsed)])]);}
export function commandLine(i:CommandIdentity):string|null {try{return [...i.path.split('/').slice(2).map(decodeURIComponent),...[...i.parameters].sort((a,b)=>a.position-b.position).map(p=>p.raw)].join(' ');}catch{return null;}}
export function readAuthority(contract:Record<string,unknown>,entry:Record<string,unknown>,names:string[],unsupplied:readonly string[]=[]):Authority|null {
 if(contract.schema!=='runtime-contract@2'||!isRecord(contract.types)||!isRecord(contract.roles)||!isRecord(contract.effects)||!isRecord(entry.typed_authority))return null;
 const roles:Record<string,RoleDeclaration>={};for(const [id,row]of Object.entries(contract.roles)){if(!isRecord(row)||!ground(id,row.source)||row.bed_member!==undefined&&typeof row.bed_member!=='boolean')return null;roles[id]={source:row.source,...(typeof row.bed_member==='boolean'?{bed_member:row.bed_member}:{})};}
 const types:Record<string,ValueType>={};for(const [id,row]of Object.entries(contract.types)){if(!isRecord(row)||!Type.safeParse(row.declaration).success)return null;const d=row.declaration as DeclaredParameterType;if(!d.catalog_type)return null;
  if(row.values!==undefined&&(!Array.isArray(row.values)||row.values.some(v=>typeof v!=='string')||new Set(row.values).size!==row.values.length))return null;
  for(const key of ['minimum','maximum','minLength','maxLength'])if(row[key]!==undefined&&(!Number.isSafeInteger(row[key])||(key==='minLength'||key==='maxLength')&&Number(row[key])<0))return null;
  if(row.address_kind!==undefined){const arms=(ADDRESS as unknown as {anyOf:Array<{properties:{kind:{const:string}}}>}).anyOf;const kinds=arms.map(arm=>arm.properties.kind.const);if(typeof row.address_kind!=='string'||!kinds.includes(row.address_kind))return null;const type=row.address_kind==='ipv4_prefix'||row.address_kind==='ipv6_prefix'?'int':row.address_kind;if(d.catalog_type!==type)return null;}
  if(d.catalog_type==='enum'&&(!Array.isArray(row.values)||!row.values.length))return null;
  if(d.catalog_type==='keyword'&&typeof row.literal!=='string')return null;
  if(typeof row.minimum==='number'&&typeof row.maximum==='number'&&row.minimum>row.maximum||typeof row.minLength==='number'&&typeof row.maxLength==='number'&&row.minLength>row.maxLength)return null;
  if(row.literal!==undefined&&typeof row.literal!=='string')return null;
  types[id]={...row,declaration:d} as unknown as ValueType;
 }
 const effects:Record<string,Effect>={};for(const [id,row]of Object.entries(contract.effects)){if(!isRecord(row)||!ground(id,row.source)||!Array.isArray(row.roles)||row.roles.some(r=>typeof r!=='string'||!roles[r])||!Number.isSafeInteger(row.budget)||Number(row.budget)<0)return null;
  if(row.commands!==undefined&&!Array.isArray(row.commands))return null;
  const commands=Array.isArray(row.commands)?row.commands.map(identityOf):undefined;if(commands?.some(i=>i===null))return null;
  const command_scope=row.command_scope;if(command_scope!==undefined&&(!Array.isArray(command_scope)||command_scope.some(path=>!pathSegments(path))||new Set(command_scope).size!==command_scope.length))return null;
  const allowed_literals=row.allowed_literals??[];if(!Array.isArray(allowed_literals)||allowed_literals.some(v=>typeof v!=='string'))return null;
  const effectRoles=row.roles;
  const bindings=row.command_roles??[];if(!Array.isArray(bindings)||bindings.some(v=>!isRecord(v)||!ground(id,v.signature)||!Number.isSafeInteger(v.position)||Number(v.position)<0||typeof v.role!=='string'||!effectRoles.includes(v.role)))return null;
  effects[id]={id,source:row.source,roles:effectRoles as string[],budget:Number(row.budget),...(commands!==undefined?{commands:commands as CommandIdentity[]}:{}),...(command_scope!==undefined?{command_scope:command_scope as string[]}:{}),allowed_literals:allowed_literals as string[],command_roles:bindings as Effect['command_roles']};
 }
 const raw=entry.typed_authority;if(!ground(String(entry.f),raw.source)||!isRecord(raw.parameters)||!Array.isArray(raw.effects)||!raw.effects.length||raw.effects.some(id=>typeof id!=='string'||!effects[id]))return null;
 const source=raw.source,parameterMap=raw.parameters;
 const selected=(raw.effects as string[]).map(id=>effects[id]);const parameters:Authority['parameters']={};
 const exempt=new Set(unsupplied),counted=names.filter(name=>!exempt.has(name)),declared=Object.keys(parameterMap);
 if(declared.filter(name=>!exempt.has(name)).length!==counted.length||counted.some(name=>!Object.hasOwn(parameterMap,name))||declared.some(name=>!names.includes(name)))return null;
 for(const name of declared){const p=parameterMap[name];if(!isRecord(p)||typeof p.type!=='string'||!types[p.type]||typeof p.role!=='string'||!roles[p.role]||!selected.some(e=>e.roles.includes(p.role as string)))return null;parameters[name]={type:types[p.type],role:p.role};}
 return {source,parameters,roles,effects:selected};
}
export function valueProblem(type:ValueType,value:unknown):string|null {
 const t=type.declaration.catalog_type;if(!t)return '类型未声明';
 if(type.address_kind!==undefined){let native:unknown=value;if(type.address_kind==='ipv4_prefix'||type.address_kind==='ipv6_prefix'){if(typeof value==='string'&&!/^[0-9]+$/.test(value))return '前缀不是完整十进制字段';native=Number(value);}if(!Address.safeParse({kind:type.address_kind,value:native}).success)return '不符合已声明地址类型';if(type.address_kind==='mask'){const bits=String(value).split('.').map(v=>Number(v).toString(2).padStart(8,'0')).join('');if(!/^1*0*$/.test(bits))return '掩码不连续';}return null;}
 if(t==='int'||t==='port'){const text=String(value);if(!/^-?[0-9]+$/.test(text)||!Number.isSafeInteger(Number(text)))return '不是声明的十进制安全整数';const n=Number(text);if(t==='port'&&(n<0||n>65535)||type.minimum!==undefined&&n<type.minimum||type.maximum!==undefined&&n>type.maximum)return '整数超出声明范围';return null;}
 if(typeof value!=='string')return '声明的文字参数不是字符串';
 if(t==='ipv4'||t==='ipv6'||t==='mask')return valueProblem({...type,address_kind:t},value);
 if(t==='enum')return type.values?.includes(value)?null:'不在已声明枚举中';
 if(t==='keyword')return type.literal===value?null:'不等于声明字面量';
 if(type.minLength!==undefined&&[...value].length<type.minLength||type.maxLength!==undefined&&[...value].length>type.maxLength)return '文字长度超出声明范围';
 if(t==='hostname'||t==='ip_or_hostname'){const host=value.endsWith('.')?value.slice(0,-1):value;const valid=host.length>0&&host.length<=253&&host.split('.').every(part=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part));if(addressKey(value)!==null)return t==='ip_or_hostname'?null:'hostname 不能代替已声明 IP 类型';return valid?null:'不符合声明的 DNS 标签语法';}
 return t==='string'?null:'未实现该声明类型的完整核验';
}
