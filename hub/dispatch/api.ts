// Public dispatch boundary: declarative executor resources and generic job lifecycle only.
export { ExecutorDefinition, at, bind, type CallRole, registrationMissing } from './definition.ts';
export { ExecutorRegistry, type RegisteredExecutor } from './executors.ts';
export { type Exchange, type SaveResponse, type ResponseMetadata } from './transport.ts';
export { DispatchService, type DispatchOptions, type JobStatus } from './service.ts';
export { verifyInput, type VerifiedInput, type VerificationPort } from './proof.ts';

export { observationHashes, rpcResponse, toolContent } from './observations.ts';

export type { BuildKnowledge } from './probes.ts';

export { readRunJobs, type RunJob } from './read-runs.ts';
export {ExecutorSource,resolveExecutorValues} from './source.ts';

export {freezeEffectRegistry} from './snapshot.ts';
export {boundaryPolicy,policyAllows} from './policy.ts';

export type {ReleaseCheck,ReleaseField} from './release-diagnostics.ts';

export {
  captureText,
  lineDiff,
  type BedBaselineRecord,
  unregisteredBaselineFact,
  unregisteredBaselineNext,
  residueCaptureFact,
  residueCaptureNext,
} from './bed-state.ts';
