// Public dispatch boundary: declarative executor resources and generic job lifecycle only.
export { ExecutorDefinition, at, bind, type CallRole } from './definition.ts';
export { ExecutorRegistry, type RegisteredExecutor } from './executors.ts';
