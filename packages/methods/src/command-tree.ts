import {isIP} from 'node:net';
import {ApiError,requireCondition} from '../../contracts/src/index.ts';

export const COMMAND_RULES_VERSION='command-tree/1.0.0';
type Command={name:string;arguments:Record<string,string>[]};
export function shlex(input:string):string[]{
  const tokens:string[]=[];let word='',started=false,quote:string|null=null;
  for(let i=0;i<input.length;i++){
    const character=input[i];
    if(character==='\\'&&quote!=="'"){
      requireCondition(i+1<input.length,'INVALID_PAYLOAD','Command ends with an escape');const next=input[++i];
      if(quote==='"'&&!['"','\\'].includes(next))word+='\\';word+=next;started=true;continue;
    }
    if(quote){if(character===quote)quote=null;else word+=character;continue;}
    if(character==='"'||character==="'"){quote=character;started=true;continue;}
    if(/\s/.test(character)){if(started){tokens.push(word.toLowerCase());word='';started=false;}continue;}
    word+=character;started=true;
  }
  requireCondition(!quote,'INVALID_PAYLOAD','Command has an unterminated quote');if(started)tokens.push(word.toLowerCase());return tokens;
}
function normalized(commands:Command[]):Map<string,Command>{
  const heads=new Map<string,Command>();for(const command of commands){const tokens=shlex(command.name);requireCondition(tokens.length>0&&tokens.length<=8,'INVALID_PAYLOAD','Command heads contain one to eight words');
    const head=tokens.join(' ');requireCondition(!heads.has(head),'INVALID_PAYLOAD','Command head is ambiguous');heads.set(head,command);}return heads;
}
function match(heads:Map<string,Command>,tokens:string[]):{head:string;command:Command;length:number}|null {
  for(let length=Math.min(tokens.length,8);length>0;length--){const head=tokens.slice(0,length).join(' '),command=heads.get(head);if(command)return {head,command,length};}return null;
}
function parameters(command:Command):any[]{return command.arguments.map((arg,index)=>{
  const position=arg.position===undefined?index+1:Number(arg.position);requireCondition(Number.isInteger(position)&&position>=1,'INVALID_PAYLOAD','Parameter position is malformed');
  const min=arg.min===undefined?null:Number(arg.min),max=arg.max===undefined?null:Number(arg.max);
  requireCondition((min===null||Number.isFinite(min))&&(max===null||Number.isFinite(max))&&(min===null||max===null||min<=max),'INVALID_PAYLOAD','Parameter range is malformed');
  return {position,type:(arg.type??'UNKNOWN').toUpperCase(),optional:['true','1','yes'].includes((arg.optional??'false').toLowerCase()),help:arg.help??'',range:{min,max},enum:arg.enum?arg.enum.split('|').map(value=>value.toLowerCase()):[]};
}).sort((a,b)=>a.position-b.position);}
export function commandHeads(commands:Command[],prefix:string,limit=128):any {
  const start=shlex(prefix).join(' '),heads=[...normalized(commands).keys()].filter(head=>head.startsWith(start)).sort();
  if(heads.length>limit)throw new ApiError('RESULT_TOO_LARGE','Command head result exceeds the limit',{outcome:'result_too_large',count:heads.length,limit});
  return {heads,count:heads.length,limit,ruleVersion:COMMAND_RULES_VERSION};
}
export function commandParam(commands:Command[],head:string):any {
  const found=match(normalized(commands),shlex(head));return found?{status:'hit',head:found.head,parameters:parameters(found.command),ruleVersion:COMMAND_RULES_VERSION}:{status:'missing',head:null,parameters:[],ruleVersion:COMMAND_RULES_VERSION};
}
function dottedMask(value:string):boolean {
  if(isIP(value)!==4)return false;const bits=value.split('.').map(part=>Number(part).toString(2).padStart(8,'0')).join('');return /^1*0*$/.test(bits);
}
export function commandCheck(commands:Command[],inputs:string[]):any {
  const heads=normalized(commands);
  return {ruleVersion:COMMAND_RULES_VERSION,commands:inputs.map(input=>{
    let tokens:string[];try{tokens=shlex(input);}catch{return {command:input,status:'missing',head:null,violations:[{code:'TOKENIZE_ERROR'}]};}
    const found=match(heads,tokens);if(!found)return {command:input,status:'missing',head:null,violations:[{code:'HEAD_MISSING'}]};
    const params=parameters(found.command),args=tokens.slice(found.length),violations:any[]=[];
    const expected=params.filter(p=>!p.optional).length;
    if(args.length<expected||args.length>params.length||params.some(p=>!p.optional&&args[p.position-1]===undefined))violations.push({code:'ARGUMENT_COUNT',actual:args.length,minimum:expected,maximum:params.length});
    for(const parameter of params){const value=args[parameter.position-1];if(value===undefined)continue;let valid=true,numeric:number|null=null;
      switch(parameter.type){
        case 'STRING':case 'XSTRING':valid=value.length>0;break;
        case 'U16':case 'U32':valid=/^[+-]?\d+$/.test(value);if(valid){numeric=Number(value);const max=parameter.type==='U16'?65535:4294967295;if(!Number.isSafeInteger(numeric)||numeric<0||numeric>max)violations.push({code:'OUT_OF_RANGE',position:parameter.position,minimum:0,maximum:max});}break;
        case 'IPADDR':valid=isIP(value)>0;break;
        case 'DOTTEDIP':valid=isIP(value)===4;break;
        case 'IPMASK':valid=dottedMask(value);break;
        default:violations.push({code:'UNSUPPORTED_PARAMETER_TYPE',position:parameter.position,type:parameter.type});continue;
      }
      if(!valid){violations.push({code:'TYPE_MISMATCH',position:parameter.position,type:parameter.type});continue;}
      if(parameter.enum.length&&!parameter.enum.includes(value))violations.push({code:'ENUM_MISMATCH',position:parameter.position,allowed:parameter.enum});
      if(numeric!==null&&(parameter.range.min!==null&&numeric<parameter.range.min||parameter.range.max!==null&&numeric>parameter.range.max)&&!violations.some(v=>v.code==='OUT_OF_RANGE'&&v.position===parameter.position))violations.push({code:'OUT_OF_RANGE',position:parameter.position,minimum:parameter.range.min,maximum:parameter.range.max});
    }return {command:input,status:'hit',head:found.head,arguments:args,violations};
  })};
}
