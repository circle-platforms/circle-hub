// Public surface of the runs engine (W01 W02 W03 W05 W06 W07 W08, V01 V03 V04 V05 V06 V07, T03 T04, A01-A04, B01 B05,
// C08 R[4]): starting runs, boundary validation, terminal states and partitions. The server and the console import only this
// file. createRunsService returns the RunsService of hub/ports.ts exactly, plus the extras of RunsEngine.
export { createRunsService } from './service.ts';
export type { RunsEngine } from './service.ts';
export type { AdminLogEntry, RunsEngineDeps } from './deps.ts';
export { ENGINE_COMPONENT, DEFAULT_CLIENT_KEY_WINDOW_MS } from './deps.ts';
export type { ProductionResult, StartRunAnswer, StartRunDetail } from './start.ts';
export { isProduction } from './start.ts';
export type { SubmitAnswer } from './submit.ts';
export type { ResolveAnswer } from './preview.ts';
export type { StoredResult } from './queries.ts';

// Pure rules, for the console and for other packages' tests.
export { itemCell, attributionByReason, attributionByRole, isSandboxFailure } from './terminals.ts';
export type { CellLayer, ItemCell } from './terminals.ts';
export { declaredFamily, effectiveSubmission, independenceGap, independenceOf, warrantIndependence } from './independence.ts';
export type { AuthorOrigin, ProducerOrigin } from './independence.ts';
export { slotSchemaOf } from './slots.ts';
export { canSeeRun } from './readers.ts';

export type { RequestBody, RequestView } from './requests.ts';
export { createRequestService } from './requests.ts';
export { isAbandonedResult } from './management.ts';

export { unruledShapes } from './queries.ts';
