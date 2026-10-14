import {EXECUTION_TRANSITION_LIMITS,executionTransitionStepKey,requireCondition} from '../../contracts/src/index.ts';

// A nonterminal batch must leave capacity for C to observe its completed
// actions and ask the approved transition for a final interpretation.
export function flowBatchBudget(task:any,run:any,existing:any[],actions:any[]){
 const terminal=actions.length===1&&['delivery.propose','outcome.error'].includes(actions[0].kind),keys=new Set(existing.map(row=>row.step_key));
 for(const action of actions.filter(item=>!['delivery.propose','outcome.error'].includes(item.kind)))keys.add(executionTransitionStepKey({taskId:task.taskId,inputRevisionId:task.inputRevisionId,method:run.binding.method,flowVersion:run.binding.method.flowVersion,stepId:action.stepId,occurrence:action.occurrence}));
 const reserve=terminal?0:1,generation=Number(run.generation);requireCondition(Number.isSafeInteger(generation)&&generation>=0&&generation<EXECUTION_TRANSITION_LIMITS.generations,'RESULT_TOO_LARGE','Transition generation budget is exhausted');
 requireCondition(keys.size+reserve<=EXECUTION_TRANSITION_LIMITS.runSteps&&generation+reserve<EXECUTION_TRANSITION_LIMITS.generations,'RESULT_TOO_LARGE','Action batch leaves no capacity for its next transition');
 return {persistentSteps:keys.size,reservedTransitions:reserve};
}
