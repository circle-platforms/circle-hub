export type CallErrorCategory = '参数无效' | '无权限' | '不存在' | '已被占用' | '暂时不可用';

export function formatPlumbCallError(category: CallErrorCategory, fact: string, nextAction: string): string {
  const sentence = (text: string): string => text.trim().replace(/[。.!！?？]+$/u, '') + '。';
  return `${category}：${sentence(fact)}${sentence(nextAction)}`;
}

export type PlumbGateAction = 'pass' | 'review' | 'reject';

export interface PlumbGate {
  action: PlumbGateAction;
  calibrated: boolean;
  calibration_source?: string | null;
  threshold?: number | null;
  reject_threshold?: number | null;
  score_for_gate?: number | null;
  none_threshold?: number | null;
}

export interface PlumbJudgeDisclosure {
  status: '未确认';
  decided_by: '模型';
  model_version: string;
}

export interface PlumbAnswer {
  type: string;
  choice?: string;
  value?: string | number;
  match?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  single_candidate?: boolean;
  score_for_gate?: number;
  gate?: PlumbGate;
}

export interface PlumbNormalizedAnswer {
  kind: 'noul' | 'choice';
  choice: string;
  value: string | number;
  confidence: number;
  match?: number;
  probabilities?: Record<string, number>;
  gate?: PlumbGate;
}

export interface PlumbMindmapNode {
  line?: string;
  module?: string | null;
  path?: string[];
  title?: string;
}

export type PlumbCandidate = string | { name: string; text?: string };

export interface PlumbBatchQuestion {
  type?: string;
  task?: string;
  state?: string | Record<string, unknown> | unknown[];
  step_n?: number;
  with_ctx?: boolean;
  instructions?: string;
  criteria?: Record<string, string> | PlumbCandidate[];
  candidates?: PlumbCandidate[];
  options?: PlumbCandidate[];
  node?: PlumbMindmapNode;
  command?: string;
  commands?: string[] | string;
  document?: string;
  definition?: string;
  metadata?: Record<string, unknown>;
}

export interface PlumbJudgeRequest {
  model?: string;
  task?: string;
  step_n?: number;
  with_ctx?: boolean;
  state?: string | Record<string, unknown> | unknown[];
  node?: PlumbMindmapNode;
  command?: string;
  commands?: string[] | string;
  document?: string;
  definition?: string;
  candidates?: PlumbCandidate[];
  options?: PlumbCandidate[];
  questions?: Record<string, PlumbBatchQuestion>;
  metadata?: Record<string, unknown>;
}

export interface PlumbUsage {
  state_truncated?: boolean;
  est_tokens_before?: number;
  est_tokens_after?: number;
  input_tokens?: number;
  [key: string]: unknown;
}

export interface PlumbJudgeResponse extends PlumbJudgeDisclosure {
  request_id?: string;
  task?: string;
  answer: PlumbAnswer;
  gate?: PlumbGate;
  usage?: PlumbUsage;
  cache_hit?: boolean;
}

export interface PlumbBatchAnswer {
  type?: string;
  choice?: string;
  value?: string | number;
  match?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  single_candidate?: boolean;
  score_for_gate?: number;
  status?: '未确认';
  decided_by?: '模型';
  model_version?: string;
  answer?: PlumbAnswer;
  gate?: PlumbGate;
}

export interface PlumbBatchJudgeResponse extends PlumbJudgeDisclosure {
  request_id?: string;
  task?: string;
  answers: Record<string, PlumbBatchAnswer>;
  usage?: PlumbUsage;
  cache_hit?: boolean;
}

export type PlumbAnyJudgeResponse = PlumbJudgeResponse | PlumbBatchJudgeResponse;

export interface PlumbModelEntry {
  id: string;
  serving?: boolean;
  released?: boolean;
  tasks?: string[];
  [key: string]: unknown;
}

export interface PlumbModelsResponse {
  default_model?: string;
  models: PlumbModelEntry[] | Record<string, unknown>;
}

export interface PlumbStatusResponse {
  status: string;
  model?: string;
  default_model?: string;
  serving_version?: string | null;
  switching_version?: string | null;
  released?: boolean;
  expected_adapter_sha256?: string | null;
  actual_adapter_sha256?: string | null;
  backend_pid?: number | null;
  eta_sec?: number | null;
  /** The backend's own state ("failed" when its last start attempt failed), reported beside the coarser status. */
  backend_state?: string | null;
  /** The step of the start attempt the gateway reports. */
  phase?: string | null;
  /** The gateway's own words about the start attempt, for a failed one the reason. */
  progress_message?: string | null;
  [key: string]: unknown;
}

export interface PlumbWakeResponse {
  status: string;
  action?: string;
  model?: string;
  eta_sec?: number | null;
  [key: string]: unknown;
}

export interface PlumbKeyRequestResponse {
  request_id: string;
  claim_code?: string;
  status?: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface PlumbKeyClaimResponse {
  key_id?: string;
  api_key?: string;
  status?: string;
  scopes?: string[];
  [key: string]: unknown;
}

export interface PlumbSystemOneRequest {
  model?: string;
  state?: unknown;
  questions?: Record<string, PlumbBatchQuestion>;
  instructions?: string;
  criteria?: Record<string, string> | PlumbCandidate[];
  [key: string]: unknown;
}

export interface PlumbAuditRecord {
  ts: string;
  endpoint: string;
  task: string;
  model_version: string;
  request_sha256: string;
  request_id: string | null;
  status: '未确认';
  decided_by: '模型';
  choice?: string;
  confidence?: number;
  gate_action?: PlumbGateAction;
  cache_hit: boolean;
  error_code?: string;
}

export interface PlumbTiming {
  now: () => number;
  pause: (ms: number) => Promise<void>;
}

export interface PlumbClientConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  caFile?: string;
  caSha256?: string;
  allowInsecureHttp?: boolean;
  cacheDir?: string;
  noCache?: boolean;
  auditOut?: string;
  timeoutMs?: number;
  wakeTimeoutMs?: number;
  maxConcurrent?: number;
  maxRpm?: number;
  maxBodyBytes?: number;
  userAgent?: string;
  timing?: PlumbTiming;
}

export class PlumbHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly category: CallErrorCategory;
  readonly requestId?: string;

  constructor(params: {
    message: string;
    status: number;
    code: string;
    retryable: boolean;
    retryAfterMs: number | null;
    category: CallErrorCategory;
    requestId?: string;
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = 'PlumbHttpError';
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
    this.retryAfterMs = params.retryAfterMs;
    this.category = params.category;
    this.requestId = params.requestId;
  }
}
