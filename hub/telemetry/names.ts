// The names of steps and of usage (B08, decision 146). They are an interface: the CLI, the console and later the alerts
// refer to them, so a name starts with a verb, holds no dynamic value and stays once it is published. This file is the
// only list; a step or usage name that is not here does not compile. The tool names are the six of contracts/src/tools.ts
// and the commands those of the CLI (a test keeps both complete); a name a client or a URL sent never becomes a step name
// by itself: the functions below map what arrives to an entry of this list.

/** The root step of an MCP request: the tool called, or what else the request asked for. */
const MCP_STEPS = ['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result', 'initialize', 'list-tools', 'handle-mcp'] as const;

/**
 * The root step of a console request, by its first path segment; `serve-console` for anything else under /console and
 * `stream-console` for the live updates, whose one request lasts as long as the page is open.
 */
const CONSOLE_STEPS = [
  'stream-console', 'serve-console', 'serve-overview', 'serve-results', 'serve-runs', 'serve-knowledge', 'serve-packs', 'serve-connections', 'serve-records',
  'serve-search', 'serve-settings', 'serve-health', 'serve-team', 'serve-operations', 'serve-admin', 'serve-api', 'serve-assets', 'serve-login', 'serve-logout',
  'serve-setup', 'serve-password', 'serve-authorize',
] as const;

/** The root step of a sync request, by its route; `serve-sync` before a route is known or for none. */
const SYNC_STEPS = [
  'serve-sync', 'sync-state', 'sync-client', 'sync-session', 'sync-inventory', 'sync-missing', 'sync-upload', 'sync-download', 'sync-commit',
  'sync-operation', 'sync-abort', 'sync-mode-check', 'sync-mode', 'sync-share',
] as const;

/** One round of a background task. */
export const BACKGROUND_STEPS = ['maintain-runs', 'index-citations', 'summarize-results', 'index-knowledge', 'sync-knowledge', 'poll-console', 'clean-staging', 'renew-lease', 'project-document', 'purge-traces'] as const;
export type BackgroundStep = (typeof BACKGROUND_STEPS)[number];

/** Rounds a timer starts. The others run when something asks (a document job, a staged pack's expiry, a lease in use), so they have no interval to report. */
export const TIMED_BACKGROUND_STEPS = ['maintain-runs', 'index-citations', 'summarize-results', 'index-knowledge', 'poll-console', 'purge-traces'] as const satisfies readonly BackgroundStep[];

/** The root step of a CLI command, by the command's name; `run-command` for a name the CLI does not know. */
const COMMAND_STEPS = [
  'run-command', 'run-user', 'run-token', 'run-logs', 'run-run', 'run-local-tools', 'run-setup-code',
  'run-share', 'run-unshare', 'run-records', 'run-executor', 'run-job', 'run-bed', 'run-skill', 'run-pack', 'run-resource', 'run-var', 'run-mask', 'run-secret',
  'run-original', 'run-lease', 'run-knowledge', 'run-doc', 'run-init-admin', 'run-operator-token', 'run-trace',
  'run-init', 'run-db', 'run-key', 'run-service', 'run-backup', 'run-restore', 'run-deploy', 'run-rollback', 'run-rehearse', 'run-status', 'run-tls',
] as const;

/** What a request or a round does inside: the steps worth a row of their own. */
const INNER_STEPS = [
  'authenticate', 'check-permission', 'read-source', 'parse-document', 'run-function', 'run-check', 'validate-submission', 'append-record', 'compute-view', 'slow-query',
  'load-workflow', 'freeze-skills', 'resolve-target', 'bind-inputs', 'read-context', 'project-items', 'bind-expected', 'evaluate-run', 'list-packs',
  'list-runs', 'load-tasks', 'list-requests', 'read-call-log', 'read-systems', 'read-lines', 'read-storage',
] as const;

/**
 * Every step name, in one list. `serve-http` is the root of an exchange that is no call: a request outside MCP, the console and
 * sync, or one on /mcp that gets no call-log line (a GET, a notification, a request refused before it was identified).
 */
export const STEP_NAMES = [...MCP_STEPS, ...CONSOLE_STEPS, ...SYNC_STEPS, ...BACKGROUND_STEPS, ...COMMAND_STEPS, ...INNER_STEPS, 'serve-http'] as const;
export type StepName = (typeof STEP_NAMES)[number];

/**
 * The usage of a step (decision 146, design section 5). `self.ms` is derived, not measured: the step's duration less the
 * time of the entries of ACCOUNTED_USAGE. `steps.dropped` counts the steps a trace left out over its limit.
 */
export const USAGE_NAMES = [
  'db.queries', 'db.rows', 'db.bytes', 'db.ms', 'db.wait_ms',
  'sandbox.runs', 'sandbox.wait_ms', 'sandbox.ms',
  'source.reads', 'source.bytes', 'source.ms',
  'answer.bytes', 'self.ms', 'steps.dropped',
] as const;
export type UsageName = (typeof USAGE_NAMES)[number];

/** The usage in milliseconds that `self.ms` takes out of a step's duration. */
export const ACCOUNTED_USAGE = ['db.ms', 'db.wait_ms', 'sandbox.wait_ms', 'sandbox.ms', 'source.ms'] as const satisfies readonly UsageName[];

export const isUsageName = (value: string): value is UsageName => (USAGE_NAMES as readonly string[]).includes(value);

const pick = <T extends string>(names: readonly T[], name: string, otherwise: T): T => (names as readonly string[]).includes(name) ? (name as T) : otherwise;

/** The root step of an MCP request: `tool` only when it is one of the six, never what a client wrote. */
export function mcpStep(method: unknown, tool: unknown): StepName {
  if (method === 'tools/call' && typeof tool === 'string') return pick(MCP_STEPS, tool, 'handle-mcp');
  return method === 'initialize' ? 'initialize' : method === 'tools/list' ? 'list-tools' : 'handle-mcp';
}

/** The root step of a request under /console, from its path. */
export function consoleStep(pathname: string): StepName {
  if (pathname === '/console/api/stream') return 'stream-console';
  return pick(CONSOLE_STEPS, `serve-${pathname.split('/')[2] ?? 'console'}`, 'serve-console');
}

/** The root step of a sync request: `route` is a key of the route table, camel case there. */
export function syncStep(route: string): StepName {
  return pick(SYNC_STEPS, `sync-${route.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, 'serve-sync');
}

/** The root step of a CLI command. */
export function commandStep(command: string): StepName {
  return pick(COMMAND_STEPS, `run-${command}`, 'run-command');
}
