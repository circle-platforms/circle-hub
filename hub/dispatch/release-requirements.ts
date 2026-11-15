import type { RequirementTemplate } from '../../contracts/src/pack.ts';
import type { RequirementResult } from '../../contracts/src/validation.ts';
import type { ItemProjection } from '../../contracts/src/run.ts';
import { expectationFor, meets } from '../runs/engine/terminals.ts';

/** Before its first effect, a dispatch-observed requirement is ready on its static layer alone. Once the dynamic layer has
 * run, its complete status decides: a later pass, failure or missing fact is never hidden by the earlier static facts. */
export function releaseStatus(template: RequirementTemplate, result: RequirementResult, item: ItemProjection): RequirementResult['status'] {
  const dynamic = (result.layers ?? []).find((layer) => layer.layer === 'dynamic');
  if (dynamic?.terminal !== 'not_run') return result.status;
  if (result.unsatisfied_reason === 'no_producer' || result.unsatisfied_reason === 'independence_unknown') return result.status;
  const expectation = expectationFor(template, item.fields);
  const refutations = result.claims.filter((claim) => claim.statement.verdict === 'refute');
  const expectedRefutation = refutations.length > 0 && refutations.every((claim) => claim.statement.code !== undefined && expectation.codes.includes(claim.statement.code));
  const staticLayers = result.layers.filter((layer) => layer.layer === 'static');
  const ready = staticLayers.length > 0 && staticLayers.every((layer) => meets(layer, expectation, expectedRefutation, template.accepted_producer));
  return ready ? 'satisfied' : result.status;
}
