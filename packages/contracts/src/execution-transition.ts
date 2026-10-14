import {z} from 'zod';

// Internal contracts only: these shapes do not dispatch, authorize or persist.
// Shared primitives are supplied after index.ts initializes, avoiding a cycle.
interface Shared {
  TaskId:z.ZodType<string>;InputRevisionId:z.ZodType<string>;OperationId:z.ZodType<string>;
  AssetId:z.ZodType<string>;SourceRevisionId:z.ZodType<string>;ArtifactId:z.ZodType<string>;
  KnowledgeRecordId:z.ZodType<string>;EvidenceId:z.ZodType<string>;Sha256:z.ZodType<string>;
  Base64Content:z.ZodType<string,string>;SafeRelativePath:z.ZodType<string>;ToolName:z.ZodType<string>;
  PackageName:z.ZodType<string>;PackageVersion:z.ZodType<string>;
  sha256:(value:Uint8Array)=>string;canonicalJson:(value:unknown)=>string;canonicalHash:(value:unknown)=>string;
  registeredError:(value:string)=>boolean;error:(code:string,message:string)=>Error;
}
const ceilPowerOfTwo=(value:number)=>2**Math.ceil(Math.log2(value));
export type ExecutionTransitionJsonValue=null|boolean|number|string|ExecutionTransitionJsonValue[]|{[key:string]:ExecutionTransitionJsonValue};
export const EXECUTION_TRANSITION_SCHEMA='hub-execution-transition/1' as const;
export const EXECUTION_TRANSITION_LIMITS=Object.freeze({
  stateBytes:ceilPowerOfTwo(2*(4219626-2577744-1527460)),
  metadataBytes:ceilPowerOfTwo(2*208866),outputBytes:ceilPowerOfTwo(2*119582),
  jsonStringBytes:ceilPowerOfTwo(2*10420),arrayItems:ceilPowerOfTwo(216),jsonDepth:ceilPowerOfTwo(2*7),
  controlledBytes:ceilPowerOfTwo(149702+9970+7209+4219626),
  // Existing tool-host channel ceilings, not newly enlarged execution limits.
  toolInputWireBytes:24*1024*1024,toolOutputWireBytes:16*1024*1024,
});
export function createExecutionTransitionContracts(shared:Shared){
  const limits=EXECUTION_TRANSITION_LIMITS,bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
  const typedArrayByteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
  const issue=(ctx:z.RefinementCtx,message:string,path:PropertyKey[]=[],code='INVALID_PAYLOAD')=>ctx.addIssue({code:'custom',message,path:path as (string|number)[],params:{errorCode:code}});
  const scalar=[z.null(),z.boolean(),z.number().finite(),z.string().max(limits.jsonStringBytes)] as const;
  let json:z.ZodType<ExecutionTransitionJsonValue>=z.union(scalar);
  for(let depth=0;depth<limits.jsonDepth;depth++)json=z.union([...scalar,z.array(json).max(limits.arrayItems),z.record(z.string().max(limits.jsonStringBytes),json)]);
  const object=z.record(z.string().max(limits.jsonStringBytes),json),stepId=z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  const safeSize=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const pin=z.object({assetId:shared.AssetId,version:shared.PackageVersion,sha256:shared.Sha256,digest:shared.Sha256.optional()}).strict();
  const method=pin.extend({capabilityPackId:shared.PackageName,flowVersion:z.string().min(1).max(200),implementationSha256:shared.Sha256}).strict();
  const binding=z.object({taskId:shared.TaskId,inputRevisionId:shared.InputRevisionId,inputSha256:shared.Sha256,method,
    resources:z.record(shared.ToolName,pin),sources:z.record(shared.ToolName,pin)}).strict();
  const reference=z.discriminatedUnion('kind',[
    z.object({kind:z.literal('source'),sourceRevisionId:shared.SourceRevisionId,sha256:shared.Sha256,size:safeSize}).strict(),
    z.object({kind:z.literal('artifact'),artifactId:shared.ArtifactId,sha256:shared.Sha256,size:safeSize}).strict(),
    z.object({kind:z.literal('evidence'),evidenceId:shared.EvidenceId,sha256:shared.Sha256,size:safeSize}).strict(),
    z.object({kind:z.literal('knowledge'),recordId:shared.KnowledgeRecordId,sha256:shared.Sha256,size:safeSize}).strict(),
  ]);
  const controlled=z.object({slot:stepId,role:z.string().min(1).max(100),encoding:z.literal('base64'),reference,
    contentBase64:z.string().max(Math.ceil(limits.controlledBytes/3)*4).pipe(shared.Base64Content)}).strict();
  const byteReference=controlled.omit({encoding:true,contentBase64:true}).strict(),byteBinding=z.union([byteReference,controlled]);
  const byteParameter=z.string().min(1).max(limits.jsonStringBytes).refine(key=>!['__proto__','constructor','prototype'].includes(key)&&!/[\x00-\x1f]/.test(key),'Use a plain provider parameter key');
  const observation=z.object({operationId:shared.OperationId,reference,facts:object}).strict();
  const common={stepId,occurrence:safeSize};
  const action=z.discriminatedUnion('kind',[
    z.object({...common,kind:z.literal('tool.call'),path:shared.SafeRelativePath,export:z.string().min(1).max(200).regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),args:z.array(json).max(limits.arrayItems),byteSlots:z.array(stepId).max(limits.arrayItems).optional()}).strict(),
    z.object({...common,kind:z.literal('provider.call'),resource:shared.ToolName,tool:shared.ToolName,args:object,byteArgs:z.record(byteParameter,stepId).optional()}).strict().refine(value=>!Object.keys(value.byteArgs??{}).some(key=>Object.hasOwn(value.args,key)),'A binary parameter cannot overwrite ordinary args'),
    z.object({...common,kind:z.literal('operation.wait'),operationId:shared.OperationId}).strict(),
    // Exact HookSubjects and frozen binding are checked by the future driver.
    z.object({...common,kind:z.literal('hook.verify'),event:z.enum(['verify.deviceCommand','verify.hostCommand','verify.workbook','beforeDispatch','afterResult']),subject:object}).strict(),
    z.object({...common,kind:z.literal('outcome.error'),code:z.string().regex(/^[A-Z][A-Z0-9_]*$/).refine(shared.registeredError,'A fixed registered error code is required'),facts:object}).strict(),
    z.object({...common,kind:z.literal('delivery.propose'),status:z.enum(['succeeded','partial']),result:json,references:z.array(reference).max(limits.arrayItems)}).strict(),
  ]);
  function tree(value:unknown,ctx:z.RefinementCtx,direction:'input'|'output'){
    const ancestors=new Set<object>(),budgetCode=direction==='input'?'BODY_TOO_LARGE':'RESULT_TOO_LARGE';
    function walk(item:unknown,path:(string|number)[],depth:number){
      if(depth>limits.jsonDepth){issue(ctx,'JSON nesting exceeds its budget',path,budgetCode);return;}
      const binary=direction==='input'&&path.length===3&&path[0]==='controlledBytes'&&typeof path[1]==='number'&&path[2]==='contentBase64';
      if(typeof item==='string'){if(!binary&&bytes(item)>limits.jsonStringBytes)issue(ctx,'JSON string exceeds its UTF-8 byte budget',path,budgetCode);return;}
      if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
      if(typeof item!=='object'){issue(ctx,'Only finite JSON values are accepted',path);return;}
      if(ancestors.has(item)){issue(ctx,'Cyclic JSON values are not accepted',path);return;}
      const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);
      if(prototype!==(array?Array.prototype:Object.prototype)&&!(prototype===null&&!array)){issue(ctx,'Only plain JSON objects and arrays are accepted',path);return;}
      if(array&&item.length>limits.arrayItems){issue(ctx,'JSON array exceeds its item budget',path,budgetCode);return;}
      ancestors.add(item);
      const descriptors=Object.getOwnPropertyDescriptors(item);
      for(const key of Reflect.ownKeys(descriptors)){
        if(array&&key==='length')continue;
        const descriptor=(descriptors as any)[key];
        if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||key==='__proto__'||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length)){issue(ctx,'JSON properties cannot be hidden symbols accessors prototype keys or extra array fields',path);continue;}
        if(bytes(key)>limits.jsonStringBytes)issue(ctx,'JSON key exceeds its UTF-8 byte budget',path,budgetCode);
        walk(descriptor.value,[...path,array?Number(key):key],depth+1);
      }
      if(array)for(let i=0;i<item.length;i++)if(!Object.hasOwn(descriptors,String(i)))issue(ctx,'Sparse JSON arrays are not accepted',[...path,i]);
      ancestors.delete(item);
    }
    walk(value,[],1);
  }
  const guarded=<T extends z.ZodType>(schema:T,direction:'input'|'output')=>z.preprocess((value,ctx)=>{
    const count=ctx.issues.length;tree(value,ctx as z.RefinementCtx,direction);return ctx.issues.length>count?z.NEVER:value;
  },schema);
  function stateBudget(value:unknown,ctx:z.RefinementCtx,direction:'input'|'output'){
    if(bytes(shared.canonicalJson(value))>limits.stateBytes)issue(ctx,'Product state exceeds its total JSON byte budget',['state'],direction==='input'?'BODY_TOO_LARGE':'RESULT_TOO_LARGE');
  }
  function byteBudget(entries:z.infer<typeof byteBinding>[],ctx:z.RefinementCtx){
    const slots=new Set<string>();let total=0;
    for(const [index,entry]of entries.entries()){
      if(slots.has(entry.slot))issue(ctx,'Controlled byte slots must be unique',['controlledBytes',index,'slot']);slots.add(entry.slot);
      total+=entry.reference.size;
      if('contentBase64' in entry){const decoded=Buffer.from(entry.contentBase64,'base64');if(decoded.length!==entry.reference.size||shared.sha256(decoded)!==entry.reference.sha256)issue(ctx,'Controlled bytes differ from their original SHA or decoded size',['controlledBytes',index],'SOURCE_HASH_MISMATCH');}
    }
    if(total>limits.controlledBytes)issue(ctx,'Controlled original bytes exceed their total budget',['controlledBytes'],'BODY_TOO_LARGE');
  }
  function metadataBudget(value:{controlledBytes:z.infer<typeof byteBinding>[]},ctx:z.RefinementCtx){
    const metadata={...value,controlledBytes:value.controlledBytes.map(entry=>({slot:entry.slot,role:entry.role,reference:entry.reference,...('encoding' in entry?{encoding:entry.encoding}:{})}))};
    if(bytes(shared.canonicalJson(metadata))>limits.metadataBytes)issue(ctx,'Transition metadata exceeds its cumulative JSON byte budget',[],'BODY_TOO_LARGE');
  }
  const inputBase=z.object({schema:z.literal(EXECUTION_TRANSITION_SCHEMA),binding,currentInput:z.object({value:json,sha256:shared.Sha256}).strict(),state:json,
    observations:z.array(observation).max(limits.arrayItems),controlledBytes:z.array(controlled).max(limits.arrayItems)}).strict().superRefine((value,ctx)=>{
    stateBudget(value.state,ctx,'input');
    if(shared.canonicalHash(value.currentInput.value)!==value.currentInput.sha256||value.currentInput.sha256!==value.binding.inputSha256)issue(ctx,'Current input differs from its canonical SHA or frozen binding',['currentInput','sha256'],'SOURCE_HASH_MISMATCH');
    metadataBudget(value,ctx);byteBudget(value.controlledBytes,ctx);
  });
  const outputBase=z.object({schema:z.literal(EXECUTION_TRANSITION_SCHEMA),state:json,actions:z.array(action).max(limits.arrayItems)}).strict().superRefine((value,ctx)=>{
    stateBudget(value.state,ctx,'output');
    if(bytes(shared.canonicalJson(value))>limits.outputBytes)issue(ctx,'Transition output exceeds its cumulative JSON byte budget',[],'RESULT_TOO_LARGE');
    const identities=new Set<string>();for(const [index,item]of value.actions.entries()){const identity=shared.canonicalJson([item.stepId,item.occurrence]);if(identities.has(identity))issue(ctx,'Action step and occurrence must be unique',['actions',index]);identities.add(identity);}
  });
  const input=guarded(inputBase,'input'),output=guarded(outputBase,'output');
  const identity=z.object({taskId:shared.TaskId,inputRevisionId:shared.InputRevisionId,method,
    flowVersion:z.string().min(1).max(200),stepId,occurrence:safeSize}).strict().refine(value=>value.flowVersion===value.method.flowVersion,'Step flow differs from its frozen method flow');
  const stepIdentity=guarded(identity,'input');
  const hashBinding=guarded(binding.superRefine((value,ctx)=>{if(bytes(shared.canonicalJson(value))>limits.metadataBytes)issue(ctx,'Request binding exceeds the metadata budget',[],'BODY_TOO_LARGE');}),'input');
  const hashBytes=guarded(z.object({controlledBytes:z.array(byteBinding).max(limits.arrayItems)}).strict().superRefine((value,ctx)=>{metadataBudget(value,ctx);byteBudget(value.controlledBytes,ctx);}),'input');
  const parse=<T extends z.ZodType>(schema:T,value:unknown)=>{
    const parsed=schema.safeParse(value);if(parsed.success)return parsed.data;
    const issue=parsed.error.issues[0] as z.core.$ZodIssueCustom;
    throw shared.error(typeof issue.params?.errorCode==='string'?issue.params.errorCode:'INVALID_PAYLOAD',issue.message);
  };
  return {
    ExecutionTransitionAssetPin:pin,ExecutionTransitionInput:input,ExecutionTransitionOutput:output,
    parseExecutionTransitionInput:(value:unknown)=>parse(input,value),parseExecutionTransitionOutput:(value:unknown)=>parse(output,value),
    executionTransitionStepKey:(value:unknown)=>{const item=parse(stepIdentity,value);return shared.canonicalHash({taskId:item.taskId,inputRevisionId:item.inputRevisionId,methodPinDigest:shared.canonicalHash(item.method),flowVersion:item.flowVersion,stepId:item.stepId,occurrence:item.occurrence});},
    executionTransitionRequestHash:(frozenBinding:unknown,proposedAction:unknown,byteBindings:unknown=[])=>{
      const checkedBinding=parse(hashBinding,frozenBinding),checkedOutput=parse(output,{schema:EXECUTION_TRANSITION_SCHEMA,state:null,actions:[proposedAction]});
      const item=checkedOutput.actions[0],checkedBytes=parse(hashBytes,{controlledBytes:byteBindings}).controlledBytes,bySlot=new Map(checkedBytes.map(entry=>[entry.slot,entry]));
      const used=item.kind==='provider.call'?Object.values(item.byteArgs??{}):item.kind==='tool.call'?item.byteSlots??[]:[];
      const resolved=[...new Set(used)].sort().map(slot=>{const entry=bySlot.get(slot);if(!entry)throw shared.error('INVALID_PAYLOAD','A referenced binary slot is absent from its frozen original bindings');return {slot:entry.slot,role:entry.role,reference:entry.reference};});
      return shared.canonicalHash({binding:checkedBinding,action:item,...(resolved.length?{byteBindings:resolved}:{})});
    },
    checkExecutionTransitionWire:(serialized:string|Uint8Array,direction:'input'|'output')=>{
      z.enum(['input','output']).parse(direction);let size:number;
      if(typeof serialized==='string')size=bytes(serialized);
      else{if(!(serialized instanceof Uint8Array))throw shared.error('INVALID_PAYLOAD','Tool wire must be a serialized string or actual Uint8Array');try{size=typedArrayByteLength.call(serialized);}catch{throw shared.error('INVALID_PAYLOAD','Tool wire is not an actual byte buffer');}}
      const max=direction==='input'?limits.toolInputWireBytes:limits.toolOutputWireBytes;
      if(size>max)throw shared.error(direction==='input'?'BODY_TOO_LARGE':'RESULT_TOO_LARGE','Serialized Tool wire exceeds the existing channel ceiling');return size;
    },
    // Preprocessing only rejects data; its admitted output has this exact shape.
    executionTransitionJsonSchemas:()=>({input:z.toJSONSchema(inputBase,{io:'output',reused:'ref'}),output:z.toJSONSchema(outputBase,{io:'output',reused:'ref'})}),
  };
}
