import {compileGrammar,commandIdentity,commandTokens,parseCommandState,type CommandDefinition} from './generated/skills/command-tools/command-check/grammar.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import {identityOf,identityKey} from './typed-contract.ts';

type Parameter=CommandIdentity['parameters'][number];
export interface CellParameter extends Omit<Parameter,'parsed'> {parsed:{kind:'runtime_cell';register:string;template:string}}
export interface CommandTemplate extends Omit<CommandIdentity,'parameters'> {input_register:string;parameters:Array<Parameter|CellParameter>}
export type ResolvedCommand=CommandIdentity|CommandTemplate;
export const isCommandTemplate=(value:ResolvedCommand):value is CommandTemplate=>'input_register'in value;
export function resolvedKey(value:ResolvedCommand):string{
 return isCommandTemplate(value)?JSON.stringify([value.tree_root,value.path,value.signature,value.input_register,value.parameters.map(parameter=>[parameter.position,parameter.type,parameter.parsed])]):identityKey(value);
}
export function resolvedLine(value:ResolvedCommand):string{
 return [...value.path.split('/').slice(2).map(decodeURIComponent),...[...value.parameters].sort((a,b)=>a.position-b.position).map(parameter=>parameter.raw)].join(' ');
}
export function commandTemplate(definitions:readonly CommandDefinition[],line:string,register:string):CommandTemplate|null{
 const tokens=commandTokens(line);if(!tokens)return null;
 const candidates:CommandTemplate[]=[];
 for(const definition of definitions){
  if(!definition.words.every((word,index)=>tokens[index]?.value===word&&!tokens[index].quoted))continue;
  const args=tokens.slice(definition.words.length);
  for(const signature of definition.signatures){
   const memo=new Map<string,Array<{position:number;token:number;dynamic:boolean}>|null>();
   const bind=(position:number,token:number):Array<{position:number;token:number;dynamic:boolean}>|null=>{
    const key=position+':'+token;if(memo.has(key))return memo.get(key)!;
    if(position===signature.params.length)return token===args.length?[]:null;
    const parameter=signature.params[position],argument=args[token];let result:Array<{position:number;token:number;dynamic:boolean}>|null=null;
    if(argument){
     const dynamic=argument.value.includes('{}')||argument.value.includes('{0}');
     const accepted=dynamic?parameter.type!==undefined&&parameter.type!=='keyword':parseCommandState(compileGrammar([{path:'/commands/value',words:['value'],signatures:[{...signature,params:[parameter]}]}]),'value '+argument.raw).status==='parsed';
     if(accepted){const tail=bind(position+1,token+1);if(tail)result=[{position,token,dynamic},...tail];}
    }
    if(!result&&parameter.optional===true)result=bind(position+1,token);
    memo.set(key,result);return result;
   };
   const bound=bind(0,0);if(!bound?.some(value=>value.dynamic))continue;
   const positions=new Set(bound.filter(value=>value.dynamic).map(value=>value.position));
   const params=signature.params.map((parameter:Record<string,any>,index:number)=>positions.has(index)?{...parameter,type:'string' as const,minLength:undefined,maxLength:undefined,minimum:undefined,maximum:undefined,unchecked_constraints:undefined}:parameter);
   const identity=identityOf(commandIdentity(compileGrammar([{...definition,signatures:[{...signature,params}]}]),line));
   if(!identity)continue;
   const parameters=identity.parameters.map(parameter=>{
    if(!positions.has(parameter.position))return parameter;
    const {catalog_type:_unknown,...type}=parameter.type;
    return {...parameter,type,parsed:{kind:'runtime_cell' as const,register,template:args[bound.find(value=>value.position===parameter.position)!.token].value}};
   });
   candidates.push({...identity,input_register:register,parameters});
  }
 }
 const unique=[...new Map(candidates.map(candidate=>[resolvedKey(candidate),candidate])).values()];
 return unique.length===1?unique[0]:null;
}
