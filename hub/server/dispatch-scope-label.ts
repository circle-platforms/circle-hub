import type { DispatchAttemptScope } from '../../contracts/api.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';

/** Name only the scope supplied by the validated source. */
export function dispatchScopeLabel(scope: DispatchAttemptScope): string {
  switch (scope.operation) {
    case 'dispatch': return `第${scope.round}轮${labelOf('dispatch_operation', scope.operation)}`;
    case 'conformance': return labelOf('dispatch_operation', scope.operation);
  }
}
