import { createHash } from 'node:crypto';
export interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_calls?: Call[];
  tool_call_id?: string;
  name?: string;
  status?: 'success' | 'error';
  internal?: string;
  display?: string;
  hook?: {
    kind: string;
    tool?: string;
    name?: string;
    reason?: string;
    count?: number;
  };
  completion?: {
    reason: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
export interface RecordRow {
  id: string;
  parent: string | null;
  created: number;
  ref: string;
}
export interface ContextRow {
  version: number;
  checkpoint: string;
  created: number;
  ref: string;
  state: Record<string, unknown>;
}
export interface SessionRow {
  id: string;
  parent_id: string | null;
  workspace: string;
  head: string | null;
  created: number;
  updated: number;
  records: RecordRow[];
  contexts: ContextRow[];
}
export interface Event {
  id: string;
  kind: string;
  session: string;
  ordinal: number;
  checkpoint: string;
  dependsOn: string[];
  sourceCreated: number;
  payloadRef: string;
  derivation: string;
}
export interface Gap {
  fact: string;
  next: string;
  session?: string;
  event?: string;
  blocking?: boolean;
}
export interface ToolPair {
  session: string;
  assistant: string;
  call: Call;
  result: RecordRow;
  message: Message;
  denied?: Message['hook'];
  child?: string;
  job?: string;
}
export interface Source {
  schema: 'circle-replay-source@1';
  root: string;
  captured: string;
  appVersion: string;
  appFiles: Record<string, string>;
  captureNode: {
    version: string;
    sha256: string;
  };
  home: string;
  workspaces: string[];
  indexHashes: Record<string, string>;
  rowsSha256: string;
  artifacts: {
    virtual: string;
    ref?: string;
    observed: string;
  }[];
}
export interface Bundle {
  directory: string;
  source: Source;
  sessions: SessionRow[];
  messages: Map<string, Message>;
  events: Event[];
  gaps: Gap[];
  paths: Map<string, RecordRow[]>;
  pairs: Map<string, ToolPair>;
  counts: {
    sessions: number;
    messages: number;
    calls: number;
    responses: number;
    errors: number;
    denials: number;
    branches: number;
    contexts: number;
    background: number;
  };
}
export class ReplayError extends Error {
  readonly exit: number;
  readonly detail: Record<string, unknown>;
  constructor(message: string, exit = 1, detail: Record<string, unknown> = {}) { super(message); this.exit = exit; this.detail = detail; }
}
export const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const keyOf = (session: string, call: string) => JSON.stringify([session, call]);
export function requireFact(condition: unknown, message: string, detail: Record<string, unknown> = {}): asserts condition {
  if (!condition)
    throw new ReplayError(message, 1, detail);
}
export const deniedLine = 'Hook denied this call:';
/**
 * Circle 1.17.0 refuses a call whose arguments do not fit the tool's declared schema before any hook is asked
 * (`prepareToolCall`): its error result starts with the tool name and this text, and no before_tool decision exists for the call.
 */
export const invalidArgumentsLine = ' was called with invalid arguments: ';
export const refusedBeforeHook = (call: { name: string }, result: Message): boolean => result.status === 'error' && result.content.startsWith(call.name + invalidArgumentsLine);
/** Circle 1.17.0's host-authored job notice display, not free-text tool output. */
export function backgroundIds(message: Message): string[] {
  if (message.internal !== 'job_notice' || !message.content.startsWith('<system-reminder data-source="circle-jobs">\n') || typeof message.display !== 'string')
    return [];
  const ids = message.display.split('\n').map(line => /^◆ (j[1-9][0-9]*) /.exec(line)?.[1]);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length)
    return [];
  return ids as string[];
}
