import {z} from 'zod';
import {ApiError,ArtifactId,InputRevisionId,OperationId,Sha256,ToolDescriptor,ToolName,ExecutionTransitionAssetPin,canonicalHash,canonicalJson,parseExecutionTransitionOutput,requireCondition} from '../../contracts/src/index.ts';
import {sanitizeResult} from '../../connectors/src/result-safety.ts';

export const ProviderPreparations=z.array(z.object({tool:ToolName,args:z.record(z.string(),z.unknown()).optional()}).strict()).min(1).max(256);
export function preparationCleanupTransport(method:string,tool:string,releaseTool:string){requireCondition(method==='tools/call'&&tool===releaseTool,'FORBIDDEN_ACTION','Cleanup transport only authorizes the bound lease release');return {method:'tools/call' as const,tool,plaintextAuthentication:true as const};}
const identitySchema=z.object({operationId:OperationId,inputRevisionId:InputRevisionId,fencingToken:z.number().int().positive(),requestHash:Sha256,resource:ExecutionTransitionAssetPin,leaseDigest:Sha256}).strict();
const referenceSchema=z.object({artifactId:ArtifactId,sha256:Sha256,size:z.number().int().positive()}).strict();
type Identity=z.infer<typeof identitySchema>;
type Plan={index:number;tool:string;args:Record<string,unknown>}[];
type RecordValue={index:number;tool:string;reference:z.infer<typeof referenceSchema>;result:any;argsDigest?:string};

function invalid(error:unknown):never{throw error instanceof ApiError?error:new ApiError('INVALID_PAYLOAD','Preparation metadata does not satisfy its bounded contract');}
export function preparationPlan(value:unknown,tools:unknown[],reserved=new Set<string>()):Plan{
 try{return ProviderPreparations.parse(value).map((call,index)=>{
  const declared=tools.filter((item:any)=>item?.name===call.tool);requireCondition(declared.length===1,'SOURCE_NOT_APPROVED','Preparation Tool is not uniquely declared');
  const tool=ToolDescriptor.parse(declared[0]);requireCondition(tool.effect==='read','INVALID_PAYLOAD','Preparation Tools must declare read effects');
  const args=call.args??{};requireCondition(!Object.keys(args).some(key=>reserved.has(key)),'INVALID_PAYLOAD','Preparation cannot supply lease authority');
  parseExecutionTransitionOutput({schema:'hub-execution-transition/1',state:null,actions:[{kind:'delivery.propose',stepId:'prepare-args',occurrence:0,status:'succeeded',result:args,references:[]}]});
  return {index,tool:call.tool,args};
 });}catch(error){invalid(error);}
}

function plainOriginal(value:any,ancestors=new Set<any>()):void{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 requireCondition(value&&typeof value==='object'&&!ancestors.has(value),'INVALID_PAYLOAD','Preparation original must be finite JSON');
 const array=Array.isArray(value),proto=Object.getPrototypeOf(value);requireCondition(proto===Object.prototype||proto===null||array&&proto===Array.prototype,'INVALID_PAYLOAD','Preparation original must be plain JSON');ancestors.add(value);
 const descriptors=Object.getOwnPropertyDescriptors(value);
 for(const key of Reflect.ownKeys(descriptors)){if(array&&key==='length')continue;const descriptor=(descriptors as any)[key];requireCondition(typeof key==='string'&&descriptor.enumerable&&Object.hasOwn(descriptor,'value')&&key!=='__proto__'&&(!array||/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length),'INVALID_PAYLOAD','Preparation original contains non-JSON properties');plainOriginal(descriptor.value,ancestors);}
 if(array)for(let i=0;i<value.length;i++)requireCondition(Object.hasOwn(descriptors,String(i)),'INVALID_PAYLOAD','Preparation original contains a sparse array');ancestors.delete(value);
}
export const preparationCommitments=(records:RecordValue[])=>records.map(({index,tool,reference,argsDigest})=>({index,tool,reference,...(argsDigest?{argsDigest}:{})}));
export function preparationProgress(value:unknown,plan:Plan,records:RecordValue[]){
 try{const identity=identitySchema.parse(value);requireCondition(records.length>0&&records.length<=plan.length,'EVIDENCE_INSUFFICIENT','Preparation originals are outside their approved plan');
  for(const [index,record]of records.entries()){requireCondition(record.index===index&&record.tool===plan[index].tool,'EVIDENCE_INSUFFICIENT','Preparation original order differs from its approved plan');referenceSchema.parse(record.reference);plainOriginal(record.result);requireCondition(canonicalHash(record.result)===record.reference.sha256&&Buffer.byteLength(canonicalJson(record.result))===record.reference.size,'SOURCE_HASH_MISMATCH','Preparation result differs from its canonical B original');}
  return {schema:'hub-provider-preparation/1' as const,identity,planHash:canonicalHash(plan),records,complete:records.length===plan.length,digest:canonicalHash({identity,planHash:canonicalHash(plan),records:preparationCommitments(records)})};
 }catch(error){invalid(error);}
}
export function preparationReceipt(value:unknown,plan:Plan,records:RecordValue[]){requireCondition(records.length===plan.length,'EVIDENCE_INSUFFICIENT','Not every declared preparation has an original');return preparationProgress(value,plan,records);}
export function preparationProofMatches(proof:any,value:unknown,plan:Plan):boolean{
 try{const checked=preparationReceipt(proof.identity,plan,proof.records);return canonicalHash(identitySchema.parse(value))===canonicalHash(checked.identity)&&proof.schema===checked.schema&&proof.planHash===checked.planHash&&proof.digest===checked.digest;}catch{return false;}
}

const sensitive=/^(authorization|cookie|password|secret|client_secret|api_key|access_token|refresh_token)$/i;
export function preparationSubject(input:Record<string,unknown>,operationId:string,proof:ReturnType<typeof preparationReceipt>,secrets:string[]=[],leaseFields=new Set<string>()){
 let redacted=false;
 function project(value:any):any{
  if(typeof value==='string'){let text=value;for(const secret of secrets.filter(Boolean))if(text.includes(secret)){text=text.replaceAll(secret,'[redacted]');redacted=true;}return text;}
  if(Array.isArray(value))return value.map(project);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>{if(sensitive.test(key)||leaseFields.has(key)){redacted=true;return [];}return [[key,project(item)]];}));return value;
 }
 const preparations=proof.records.map(({index,tool,reference,result})=>{redacted=false;const projected=sanitizeResult(project(result));return {index,tool,reference,result:redacted?{...projected,sanitized:true}:projected};});
 const subject={input,operationId,preparations};
 parseExecutionTransitionOutput({schema:'hub-execution-transition/1',state:null,actions:[{kind:'hook.verify',stepId:'prepared-before-dispatch',occurrence:0,event:'beforeDispatch',subject}]});
 return subject;
}
