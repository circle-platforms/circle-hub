// Only a producer-witnessed scope can select an author-declared step; result rows and prose are not execution evidence.
import type { LoadedWorkflow } from '../../ports.ts';

export interface WorkflowStepScope {
  readonly requirements: ReadonlySet<string>;
  readonly complete: boolean;
}

export function stepNameForScope(workflow: Pick<LoadedWorkflow, 'workflow' | 'requirements'>, scope?: WorkflowStepScope): string | undefined {
  if (!scope?.complete || scope.requirements.size === 0 || !workflow.workflow.steps?.length) return undefined;
  let selected: string | undefined;
  for (const key of scope.requirements) {
    const matches = workflow.requirements.filter(requirement => requirement.key === key);
    if (matches.length !== 1 || matches[0].step === undefined) return undefined;
    const step = matches[0].step;
    if (selected !== undefined && selected !== step) return undefined;
    selected = step;
  }
  const steps = workflow.workflow.steps.filter(step => step.id === selected);
  return steps.length === 1 ? steps[0].name : undefined;
}
