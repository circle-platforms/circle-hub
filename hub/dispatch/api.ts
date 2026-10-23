// Public dispatch boundary: declarative executor resources and generic job lifecycle only.
export { ExecutorDefinition, at, bind, type CallRole } from './definition.ts';
export { ExecutorRegistry, type RegisteredExecutor } from './executors.ts';
export { RpcClient, type Exchange, type SaveResponse } from './transport.ts';
export { DispatchService, type DispatchOptions, type JobStatus } from './service.ts';
export { verifyInput, type VerifiedInput, type VerificationPort } from './proof.ts';
