// Personal publications are byte-processing capabilities, never an alternative team assignment gate.
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import type {ProtocolError} from '../../../contracts/src/common.ts';
import type {WorkflowFile,RequirementsFile} from '../../../contracts/src/pack.ts';
import type {PackDeclarations,PackProblem} from './types.ts';
import {problem} from './problems.ts';

export const isPersonalSpace=(space?:string):boolean=>space!==undefined&&space!=='team';
export const personalExternalAllowed=(id:string):boolean=>id.startsWith('knowledge:');
export function personalCapabilityError(path='/pack'):ProtocolError{return {code:'PACK_PERSONAL_CAPABILITY_DENIED',message:PROTOCOL_CODES.PACK_PERSONAL_CAPABILITY_DENIED.when,fix:PROTOCOL_CODES.PACK_PERSONAL_CAPABILITY_DENIED.fix,path};}

export function personalWorkflowProblems(workflow:WorkflowFile,effects?:RequirementsFile['effects']):PackProblem[]{
  const failures:PackProblem[]=[],code='PACK_PERSONAL_CAPABILITY_DENIED';
  const add=(file:string,field:string)=>failures.push(problem(code,file,PROTOCOL_CODES[code].when,PROTOCOL_CODES[code].fix,{field}));
  for(const [index,input] of workflow.inputs.entries())if(input.accepts.some(type=>type.includes(':')&&!personalExternalAllowed(type)))add('workflow.json',`inputs.${index}.accepts`);
  if(workflow.leases||(workflow.context??[]).includes('leases'))add('workflow.json','leases');
  if(effects?.length)add('requirements.json','effects');
  return failures;
}

export function personalPackProblems(declarations:PackDeclarations):PackProblem[]{
  if(declarations.kind==='workflow')return personalWorkflowProblems(declarations.workflow,declarations.requirements.effects);
  if(declarations.kind==='skill')return declarations.method?personalWorkflowProblems(declarations.method.workflow,declarations.method.requirements.effects):[];
  return [];
}
